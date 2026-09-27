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
            cpu_average_power_watts: 4, cpu_peak_power_watts: 7, cpu_energy_wh: 0.01,
            gpu_average_power_watts: 3, gpu_peak_power_watts: 5, gpu_energy_wh: 0.02,
            ane_average_power_watts: 1, ane_peak_power_watts: 2, ane_energy_wh: 0.005,
        });

        const currentRun = await startRun(db, { workloadId: workload.workload_id });
        await completeRun(db, { runId: currentRun.run_id, status: 'completed' });
        const baseline = await findBaseline(db, workload.workload_id, currentRun.run_id);
        assert.equal(baseline.baseline_run_id, previous.run_id);

        const comparison = compareRunMetrics({
            duration_ms: 12000, average_power_watts: 15, peak_power_watts: 30,
            energy_wh: 0.04, carbon_gco2e: 0.01, water_liters: 0.0005,
            attribution_coverage: 90,
            cpu_average_power_watts: 6, cpu_peak_power_watts: 8, cpu_energy_wh: 0.015,
            gpu_average_power_watts: 2, gpu_peak_power_watts: 4, gpu_energy_wh: 0.01,
            ane_average_power_watts: 1, ane_peak_power_watts: 2, ane_energy_wh: 0.005,
        }, baseline);
        assert.equal(comparison.duration_ms.absolute_delta, 2000);
        assert.equal(comparison.duration_ms.percent_change, 20);
        assert.equal(comparison.average_power_watts.absolute_delta, -5);
        assert.equal(comparison.average_power_watts.percent_change, -25);
        assert.equal(comparison.attribution_coverage.absolute_delta, 10);
        assert.equal(comparison.attribution_coverage.percent_change, 12.5);
        assert.equal(comparison.cpu_average_power_watts.absolute_delta, 2);
        assert.ok(Math.abs(comparison.cpu_energy_wh.absolute_delta - 0.005) < 1e-12);
        assert.equal(comparison.gpu_average_power_watts.absolute_delta, -1);
        assert.equal(comparison.gpu_energy_wh.percent_change, -50);
        assert.equal(comparison.ane_average_power_watts.absolute_delta, 0);
        assert.equal(comparison.ane_energy_wh.absolute_delta, 0);
        assert.equal(comparison.ane_energy_wh.percent_change, 0);
    });

    it('keeps component changes unavailable when either run lacks component data', () => {
        const comparison = compareRunMetrics({ cpu_average_power_watts: null }, {
            cpu_average_power_watts: 2,
        });
        assert.equal(comparison.cpu_average_power_watts.absolute_delta, null);
        assert.equal(comparison.cpu_average_power_watts.percent_change, null);
    });

    it('marks runs with different telemetry or allocation methods incomparable', () => {
        const comparison = compareRunMetrics({ energy_wh: 0.12, measurement_method: 'hardware', allocation_method: 'fixed-92-8-allocation' }, {
            energy_wh: 0.1, measurement_method: 'hardware', allocation_method: 'macos-parser-time-allocation',
        });
        assert.equal(comparison.comparison_status, 'incomparable');
        assert.match(comparison.comparison_reason, /allocation_method/);
        assert.equal(comparison.energy_wh.absolute_delta, null);
        assert.equal(comparison.energy_wh.percent_change, null);
    });
});
