import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    closeDatabase, completeAttempt, completeRun, createWorkload, getExperienceCase, initSchema,
    normalizeAIUsage, openDatabase, startAttempt, startRun,
} from '../src/transparency/index.js';
import {
    experienceContext, recordExperienceOutcome, retrieveRelevantExperiences, saveExperienceCase,
} from '../src/transparency/experience.js';

const openDbs = new Set();
async function createCase({ name = 'web-build', type = 'build', aiExplanation = 'Historical hypothesis.', telemetryRows, aiUsage = null } = {}) {
    const db = await openDatabase(':memory:');
    openDbs.add(db);
    await initSchema(db);
    const workload = await createWorkload(db, { name, type });
    const started = await startRun(db, { workloadId: workload.workload_id });
    const startedAttempt = await startAttempt(db, { runId: started.run_id, workloadId: workload.workload_id });
    const attempt = await completeAttempt(db, { attemptId: startedAttempt.attempt_id, status: 'completed' });
    const run = await completeRun(db, { runId: started.run_id, status: 'completed' });
    const normalizedUsage = aiUsage ? normalizeAIUsage(aiUsage, {
        identity: {
            workload_id: workload.workload_id, run_id: run.run_id,
            attempt_id: attempt.attempt_id, attempt_no: attempt.attempt_no,
        },
        recordedAt: '2026-09-27T12:00:00.000Z',
    }) : null;
    const metrics = {
        average_power_watts: 18, cpu_average_power_watts: 10, gpu_average_power_watts: 7,
        ane_average_power_watts: 1, energy_wh: 0.01, measurement_quality: telemetryRows?.length ? 'hardware' : 'unavailable',
        measurement_method: telemetryRows?.length ? 'hardware' : 'unavailable',
        grid_intensity_quality: telemetryRows?.length ? 'live' : 'unavailable', attribution_coverage: 100,
    };
    await saveExperienceCase(db, {
        workload, run, telemetryRows: telemetryRows ?? [{
            timestamp: '2099-01-01T00:00:00Z', interval_seconds: 0.5, total_power_watts: 18,
            cpu_power_watts: 10, gpu_power_watts: 7, ane_power_watts: 1, measurement_source: 'hardware',
            carbon_gCO2e: 0.001, water_liters: 0.0001, grid_intensity_source: 'electricity-maps-live',
        }],
        runMetrics: metrics,
        reconciliation: { measured: { energy_wh: 0.01 }, attributed: { energy_wh: 0.01 }, unattributed: { energy_wh: 0 } },
        processLineage: [{ classification: 'client', executable: 'npm' }],
        baselineComparison: null,
        insights: { OBSERVED: [], 'LIKELY CONTRIBUTOR': [], EVIDENCE: ['hardware sample'], RECOMMENDATION: [] },
        aiExplanation,
        aiUsage: normalizedUsage,
        aiProvider: aiExplanation ? { name: 'fake', model: 'fake-model' } : null,
    });
    return { db, workload, run, metrics };
}

afterEach(async () => {
    await Promise.all([...openDbs].map(db => closeDatabase(db)));
    openDbs.clear();
});

describe('case-based experience memory', () => {
    it('persists measured, derived, provenance, AI, and outcome layers separately', async () => {
        const usage = { provider: 'ollama', model: 'llama3.2:3b', input_tokens: 12, output_tokens: 4, total_tokens: 16 };
        const { db, run } = await createCase({ aiUsage: usage });
        const cases = await retrieveRelevantExperiences(db, {
            workload: { name: 'web-build', type: 'build' },
            facts: { measurement: { cpu_average_power_watts: 10 }, process_lineage: [{ classification: 'client' }] },
        });
        assert.equal(cases.length, 1);
        assert.equal(cases[0].run_id, run.run_id);
        assert.equal(cases[0].measured_facts.telemetry_observations[0].cpu_power_watts, 10);
        assert.equal(cases[0].deterministic_derived_facts.metrics.average_power_watts, 18);
        assert.equal(cases[0].provenance[0].classification, 'client');
        assert.equal(cases[0].ai_interpretation.text, 'Historical hypothesis.');
        const stored = await getExperienceCase(db, run.run_id);
        assert.equal(stored.ai_usage.signal_type, 'logical_ai_usage');
        assert.equal(stored.ai_usage.workload_id, stored.workload.workload_id);
        assert.equal(stored.ai_usage.run_id, run.run_id);
        assert.equal(stored.ai_usage.attempt_no, 1);
        assert.equal(stored.ai_usage.recorded_at, '2026-09-27T12:00:00.000Z');
        assert.deepEqual(stored.ai_usage.derived_metrics, {
            tokens_per_wh: null, wh_per_1k_tokens: null,
            carbon_gco2e_per_1k_tokens: null, water_liters_per_1k_tokens: null,
            status: 'unavailable', reason: 'no validated SigSense measurement for this inference window',
        });
        const context = experienceContext(cases);
        assert.equal(context.cases[0].ai_usage.attempt_id, stored.ai_usage.attempt_id);
        assert.equal(cases[0].interpretation_status, 'unverified');
        assert.equal(cases[0].outcome_status, 'none');

        const verified = await recordExperienceOutcome(db, {
            runId: run.run_id, outcome: { claim: 'CPU was the largest component', verified_by: 'operator' }, verified: true,
        });
        assert.equal(verified.outcome_status, 'verified');
        assert.equal(verified.measured_facts.telemetry_observations[0].cpu_power_watts, 10);
    });

    it('keeps historical AI hypotheses separate from current measured facts', async () => {
        const { db } = await createCase({ aiExplanation: 'The prior model guessed this workload used 999 W.' });
        const currentFacts = {
            measurement: { average_power_watts: 5, cpu_average_power_watts: 4 },
            process_lineage: [{ classification: 'client' }],
        };
        const cases = await retrieveRelevantExperiences(db, {
            workload: { name: 'web-build', type: 'build' }, facts: currentFacts,
        });
        const context = experienceContext(cases);
        assert.equal(currentFacts.measurement.average_power_watts, 5);
        assert.equal(context.cases[0].historical_ai_interpretation.text,
            'The prior model guessed this workload used 999 W.');
        assert.equal(context.cases[0].historical_ai_interpretation.status, 'unverified');
        assert.equal(context.cases[0].historical_ai_interpretation.confidence, null);
        assert.equal(context.cases[0].verified_outcome, null);
        assert.equal(context.cases[0].measured_facts.telemetry_observations[0].total_power_watts, 18);
        assert.equal(context.cases[0].deterministic_derived_facts.metrics.average_power_watts, 18);
    });

    it('ranks the same logical workload identity as a relevant prior case', async () => {
        const { db, workload, run } = await createCase();
        const cases = await retrieveRelevantExperiences(db, {
            workload: { name: 'renamed-invocation', type: 'other' },
            facts: { identity: { workload: { workload_id: workload.workload_id } }, measurement: {} },
        });
        assert.equal(cases[0].run_id, run.run_id);
        assert.ok(cases[0].similarity.reasons.includes('same-workload-identity'));
    });

    it('marks sparse historical interpretations low-confidence and describes a novel pattern explicitly', async () => {
        const { db } = await createCase({ telemetryRows: [], aiExplanation: 'No measured values were available.' });
        const sparse = await retrieveRelevantExperiences(db, {
            workload: { name: 'web-build', type: 'build' }, facts: { measurement: {}, process_lineage: [] },
        });
        assert.equal(sparse[0].interpretation_status, 'low-confidence');
        assert.equal(experienceContext(sparse).cases[0].historical_ai_interpretation.verification,
            'unverified unless a separate verified outcome is present');

        const novel = await experienceContext(await retrieveRelevantExperiences(db, {
            workload: { name: 'new-database-migration', type: 'migration' }, facts: { measurement: {} },
        }));
        assert.equal(novel.status, 'novel-pattern-no-prior-cases');
        assert.deepEqual(novel.cases, []);
    });
});
