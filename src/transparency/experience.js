/**
 * Lightweight case-based learning stored beside deterministic Transparency
 * records. Historical interpretations and verified outcomes have separate
 * columns from measured observations and deterministic derived facts.
 */

import { randomUUID } from 'node:crypto';
import { dbAll, dbRun } from './db.js';
import { normalizeAIUsage } from './ai.js';

const MAX_CANDIDATES = 100;
const DEFAULT_LIMIT = 3;

export async function saveExperienceCase(db, {
    workload, run, telemetryRows, runMetrics, reconciliation, processLineage,
    baselineComparison, insights, aiExplanation = null, aiProvider = null, aiUsage = null,
}) {
    if (run?.status !== 'completed') return null;

    const measuredFacts = {
        telemetry_observations: telemetryRows.map(row => ({
            timestamp: row.timestamp,
            interval_seconds: row.interval_seconds,
            total_power_watts: row.total_power_watts,
            cpu_power_watts: row.cpu_power_watts,
            gpu_power_watts: row.gpu_power_watts,
            ane_power_watts: row.ane_power_watts,
            measurement_source: row.measurement_source,
        })),
    };
    const evidenceMetadata = {
        telemetry_count: telemetryRows.length,
        measurement_quality: runMetrics.measurement_quality,
        measurement_method: runMetrics.measurement_method,
        grid_intensity_quality: runMetrics.grid_intensity_quality,
        attribution_coverage: runMetrics.attribution_coverage,
        baseline_available: Boolean(baselineComparison),
        baseline_comparable: baselineComparison?.metrics?.comparison_status !== 'incomparable',
        deterministic_evidence: insights?.EVIDENCE ?? [],
    };
    const derivedFacts = {
        metrics: runMetrics,
        attribution: reconciliation,
        environmental_impact: telemetryRows.map(row => ({
            timestamp: row.timestamp,
            carbon_gco2e: row.carbon_gCO2e,
            water_liters: row.water_liters,
            grid_intensity_source: row.grid_intensity_source,
        })),
        baseline_comparison: baselineComparison,
        deterministic_insights: insights,
        evidence_metadata: evidenceMetadata,
    };
    const hasEvidence = telemetryRows.length > 0;
    const interpretation = aiExplanation ? {
        text: aiExplanation,
        provider: aiProvider?.name ?? 'custom-provider',
        model: aiProvider?.model ?? null,
        generated_at: new Date().toISOString(),
        status: hasEvidence ? 'unverified' : 'low-confidence',
        confidence: null,
        confidence_note: hasEvidence
            ? 'AI interpretation has no verified outcome yet.'
            : 'No measured telemetry was available for this run.',
    } : null;
    const now = new Date().toISOString();

    await dbRun(db, `
        INSERT OR IGNORE INTO experience_cases (
            experience_id, run_id, workload_id, workload_name, workload_type,
            measured_facts_json, derived_facts_json, provenance_json,
            ai_interpretation_json, ai_usage_json, interpretation_status, interpretation_confidence,
            outcome_json, outcome_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'none', ?)
    `, [
        randomUUID(), run.run_id, workload.workload_id, workload.name, workload.type,
        JSON.stringify(measuredFacts), JSON.stringify(derivedFacts), JSON.stringify(processLineage),
        interpretation ? JSON.stringify(interpretation) : null, aiUsage ? JSON.stringify(aiUsage) : null,
        interpretation?.status ?? 'none', interpretation?.confidence ?? null, now,
    ]);

    return getExperienceCase(db, run.run_id);
}

export async function getExperienceCase(db, runId) {
    const rows = await dbAll(db, 'SELECT * FROM experience_cases WHERE run_id = ?', [runId]);
    return rows.length ? decodeCase(rows[0]) : null;
}

/** Mark feedback as verified only when the caller supplies that explicit flag. */
export async function recordExperienceOutcome(db, { runId, outcome, verified = false }) {
    const result = await dbRun(db, `
        UPDATE experience_cases
           SET outcome_json = ?, outcome_status = ?
         WHERE run_id = ?
    `, [JSON.stringify(outcome), verified ? 'verified' : 'unverified', runId]);
    if (result.changes === 0) return null;
    return getExperienceCase(db, runId);
}

/** Retrieve a small, deterministic set of prior cases using structured similarity. */
export async function retrieveRelevantExperiences(db, { workload, facts, limit = DEFAULT_LIMIT } = {}) {
    const candidates = await dbAll(db,
        'SELECT * FROM experience_cases ORDER BY created_at DESC LIMIT ?', [MAX_CANDIDATES]);
    return candidates.map(decodeCase)
        .map(prior => ({ ...prior, similarity: scoreSimilarity(prior, workload, facts) }))
        .filter(prior => prior.similarity.score > 0)
        .sort((left, right) => right.similarity.score - left.similarity.score
            || right.created_at.localeCompare(left.created_at))
        .slice(0, Math.max(0, limit));
}

export function experienceContext(cases = [], statusOverride = null) {
    return {
        policy: 'Prior cases are contextual evidence only and never override current measured or deterministic facts.',
        status: statusOverride ?? (cases.length ? 'historical-experience-available' : 'novel-pattern-no-prior-cases'),
        cases: cases.map(({ similarity, ...prior }) => ({
            ...prior,
            similarity,
            historical_ai_interpretation: prior.ai_interpretation ? {
                ...prior.ai_interpretation,
                status: prior.interpretation_status,
                confidence: prior.interpretation_confidence,
                verification: 'unverified unless a separate verified outcome is present',
            } : null,
            verified_outcome: prior.outcome_status === 'verified' ? prior.outcome : null,
        })),
    };
}

function decodeCase(row) {
    const interpretation = parseJson(row.ai_interpretation_json, null);
    const storedUsage = parseJson(row.ai_usage_json, null);
    const legacyUsage = interpretation?.usage_metadata
        ? normalizeAIUsage(interpretation.usage_metadata, {
            identity: { workload_id: row.workload_id, run_id: row.run_id },
            recordedAt: null,
        })
        : null;
    return {
        experience_id: row.experience_id,
        run_id: row.run_id,
        workload: { workload_id: row.workload_id, name: row.workload_name, type: row.workload_type },
        measured_facts: parseJson(row.measured_facts_json, {}),
        deterministic_derived_facts: parseJson(row.derived_facts_json, {}),
        provenance: parseJson(row.provenance_json, []),
        ai_interpretation: interpretation,
        ai_usage: storedUsage ?? legacyUsage,
        interpretation_status: row.interpretation_status,
        interpretation_confidence: row.interpretation_confidence,
        outcome: parseJson(row.outcome_json, null),
        outcome_status: row.outcome_status,
        created_at: row.created_at,
    };
}

function parseJson(value, fallback) {
    if (value == null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function scoreSimilarity(prior, workload = {}, facts = {}) {
    const reasons = [];
    let score = 0;
    const currentWorkloadId = facts.identity?.workload?.workload_id;
    if (currentWorkloadId && prior.workload.workload_id === currentWorkloadId) {
        score += 8;
        reasons.push('same-workload-identity');
    }
    if (normalize(prior.workload.name) && normalize(prior.workload.name) === normalize(workload.name)) {
        score += 5;
        reasons.push('same-workload-name');
    }
    if (prior.workload.type && prior.workload.type === workload.type) {
        score += 3;
        reasons.push('same-workload-type');
    }

    const oldMetrics = prior.deterministic_derived_facts.metrics ?? {};
    const currentMetrics = facts.measurement ?? {};
    for (const key of ['cpu_average_power_watts', 'gpu_average_power_watts', 'ane_average_power_watts']) {
        const similarity = numericSimilarity(oldMetrics[key], currentMetrics[key]);
        if (similarity !== null) score += similarity;
    }
    if (['cpu_average_power_watts', 'gpu_average_power_watts', 'ane_average_power_watts']
        .some(key => numericSimilarity(oldMetrics[key], currentMetrics[key]) !== null)) {
        reasons.push('similar-component-power-profile');
    }

    const oldQuality = prior.deterministic_derived_facts.evidence_metadata?.measurement_quality;
    if (oldQuality && currentMetrics.measurement_quality && oldQuality === currentMetrics.measurement_quality) {
        score += 1;
        reasons.push('same-measurement-quality');
    }
    const oldClasses = new Set(prior.provenance.map(item => item.classification).filter(Boolean));
    const currentClasses = new Set((facts.process_lineage ?? []).map(item => item.classification).filter(Boolean));
    if (oldClasses.size && currentClasses.size) {
        const union = new Set([...oldClasses, ...currentClasses]);
        const overlap = [...oldClasses].filter(item => currentClasses.has(item)).length;
        score += 2 * overlap / union.size;
        if (overlap) reasons.push('overlapping-process-provenance');
    }

    const oldDeltas = prior.deterministic_derived_facts.baseline_comparison?.metrics ?? {};
    const currentDeltas = facts.baseline?.metrics ?? {};
    const deltaKeys = ['cpu_average_power_watts', 'gpu_average_power_watts', 'ane_average_power_watts'];
    const deltaSimilarities = deltaKeys
        .map(key => numericSimilarity(oldDeltas[key]?.absolute_delta, currentDeltas[key]?.absolute_delta))
        .filter(value => value !== null);
    if (deltaSimilarities.length) {
        score += deltaSimilarities.reduce((sum, value) => sum + value, 0) / deltaSimilarities.length;
        reasons.push('similar-component-baseline-deltas');
    }
    return { score: Number(score.toFixed(3)), reasons };
}

function normalize(value) { return String(value ?? '').trim().toLocaleLowerCase(); }

function numericSimilarity(left, right) {
    const a = Number(left);
    const b = Number(right);
    if (left == null || right == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    const denominator = Math.max(Math.abs(a), Math.abs(b), 0.05);
    return Math.max(0, 1 - Math.abs(a - b) / denominator);
}
