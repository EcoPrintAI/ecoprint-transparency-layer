import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, initSchema, closeDatabase, createWorkload, startRun, completeRun } from '../src/transparency/index.js';
import { findBaseline, saveRunMetrics, compareRunMetrics } from '../src/transparency/baseline.js';

describe('per-workload baseline comparison', () => {
    let db;
    after(async () => { if (db) await closeDatabase(db); });

    it('uses the prior completed run and calculates absolute and relative changes', async () => {
        db = await openDatabase(':memory:');
        await initSchema(db);
        const workload = await createWorkload(db, { name: 'repeatable-build', type: 'cli-run' });
        const previous = await startRun(db, { workloadId: workload.workload_id });
        await completeRun(db, { runId: previous.run_id, status: 'completed' });
        await saveRunMetrics(db, previous.run_id, {
            duration_ms: 10000, average_power_watts: 20, peak_power_watts: 40,
            energy_wh: 0.05, carbon_gco2e: 0.02, water_liters: 0.001,
            attribution_coverage: 80, measurement_quality: 'hardware',
        });

        const currentRun = await startRun(db, { workloadId: workload.workload_id });
        await completeRun(db, { runId: currentRun.run_id, status: 'completed' });
        const baseline = await findBaseline(db, workload.workload_id, currentRun.run_id);
        assert.equal(baseline.baseline_run_id, previous.run_id);

        const comparison = compareRunMetrics({
            duration_ms: 12000, average_power_watts: 15, peak_power_watts: 30,
            energy_wh: 0.04, carbon_gco2e: 0.01, water_liters: 0.0005,
            attribution_coverage: 90,
        }, baseline);
        assert.equal(comparison.duration_ms.absolute_delta, 2000);
        assert.equal(comparison.duration_ms.percent_change, 20);
        assert.equal(comparison.average_power_watts.absolute_delta, -5);
        assert.equal(comparison.average_power_watts.percent_change, -25);
        assert.equal(comparison.attribution_coverage.absolute_delta, 10);
        assert.equal(comparison.attribution_coverage.percent_change, 12.5);
    });
});
