import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTelemetryRows, summarizeTelemetry } from '../src/transparency/metrics.js';

describe('time-aware telemetry metrics', () => {
    it('integrates variable-duration power samples into Wh and time-weighted average W', () => {
        const summary = summarizeTelemetry([
            { timestamp: '2099-01-01T00:00:01Z', interval_seconds: 1, total_power_watts: 10 },
            { timestamp: '2099-01-01T00:00:04Z', interval_seconds: 3, total_power_watts: 30 },
        ]);
        assert.equal(summary.duration_seconds, 4);
        assert.ok(Math.abs(summary.energy_wh - 100 / 3600) < 1e-12);
        assert.ok(Math.abs(summary.power_watts - 25) < 1e-12);
        assert.equal(summary.peak_power_watts, 30);
    });

    it('sums carbon and water contributions across integrated sample intervals', () => {
        const summary = summarizeTelemetry([
            { interval_seconds: 2, total_power_watts: 18, carbon_gCO2e: 0.01, water_liters: 0.002 },
            { interval_seconds: 1, total_power_watts: 36, carbon_gCO2e: 0.02, water_liters: 0.004 },
        ]);
        assert.ok(Math.abs(summary.energy_wh - 0.02) < 1e-12);
        assert.equal(summary.carbon_gco2e, 0.03);
        assert.equal(summary.water_liters, 0.006);
    });

    it('clips interval contributions to the requested execution window', () => {
        const rows = prepareTelemetryRows([
            {
                timestamp: '2099-01-01T00:00:05Z', interval_seconds: 10,
                total_power_watts: 10, carbon_gCO2e: 0.1, water_liters: 0.01,
            },
        ], '2099-01-01T00:00:02Z', '2099-01-01T00:00:04Z');
        assert.equal(rows[0].interval_seconds, 2);
        assert.ok(Math.abs(rows[0].carbon_gCO2e - 0.02) < 1e-12);
        assert.ok(Math.abs(rows[0].water_liters - 0.002) < 1e-12);
        assert.ok(Math.abs(summarizeTelemetry(rows).energy_wh - 20 / 3600) < 1e-12);
    });

    it('uses only the measured overlap of a first hardware sample with a short run', () => {
        const row = {
            timestamp: '2099-01-01T00:00:00.500Z',
            interval_seconds: 0.5,
            total_power_watts: 10,
            carbon_gCO2e: 0.05,
            water_liters: 0.001,
        };
        const overlap = prepareTelemetryRows([row],
            '2099-01-01T00:00:00.200Z', '2099-01-01T00:00:00.400Z');
        assert.equal(overlap.length, 1);
        assert.ok(Math.abs(overlap[0].interval_seconds - 0.2) < 1e-12);
        assert.ok(Math.abs(overlap[0].carbon_gCO2e - 0.02) < 1e-12);
        assert.ok(Math.abs(overlap[0].water_liters - 0.0004) < 1e-12);
        assert.ok(Math.abs(summarizeTelemetry(overlap).energy_wh - 2 / 3600) < 1e-12);

        const noOverlap = prepareTelemetryRows([row],
            '2099-01-01T00:00:00.600Z', '2099-01-01T00:00:00.800Z');
        assert.deepEqual(noOverlap, [], 'a sample entirely outside the run is not evidence for this run');
    });

    it('does not invent one-second intervals when duration is unavailable', () => {
        assert.deepEqual(summarizeTelemetry([
            { total_power_watts: 12, carbon_gCO2e: 1, water_liters: 2 },
        ]), {
            duration_seconds: 0,
            power_watts: 0,
            peak_power_watts: null,
            energy_wh: 0,
            energy_kwh: 0,
            carbon_gco2e: 0,
            water_liters: 0,
            cpu_power_watts: null, cpu_peak_power_watts: null, cpu_energy_wh: null,
            cpu_energy_kwh: null, cpu_duration_seconds: null, cpu_telemetry_count: 0,
            gpu_power_watts: null, gpu_peak_power_watts: null, gpu_energy_wh: null,
            gpu_energy_kwh: null, gpu_duration_seconds: null, gpu_telemetry_count: 0,
            ane_power_watts: null, ane_peak_power_watts: null, ane_energy_wh: null,
            ane_energy_kwh: null, ane_duration_seconds: null, ane_telemetry_count: 0,
            client_workload_power_watts: null, client_workload_peak_power_watts: null,
            client_workload_energy_wh: null, client_workload_energy_kwh: null,
            client_workload_duration_seconds: null,
            client_workload_carbon_gco2e: null, client_workload_water_liters: null,
            client_workload_telemetry_count: 0, client_workload_environmental_allocation: 'unavailable',
            ecoprint_overhead_power_watts: null, ecoprint_overhead_peak_power_watts: null,
            ecoprint_overhead_energy_wh: null, ecoprint_overhead_energy_kwh: null,
            ecoprint_overhead_duration_seconds: null,
            ecoprint_overhead_carbon_gco2e: null, ecoprint_overhead_water_liters: null,
            ecoprint_overhead_telemetry_count: 0, ecoprint_overhead_environmental_allocation: 'unavailable',
        });
    });

    it('integrates CPU, GPU, and ANE average, peak, and energy independently', () => {
        const summary = summarizeTelemetry([
            { interval_seconds: 1, total_power_watts: 10, cpu_power_watts: 2, gpu_power_watts: 1, ane_power_watts: 0.5 },
            { interval_seconds: 3, total_power_watts: 30, cpu_power_watts: 4, gpu_power_watts: 2, ane_power_watts: 1.5 },
        ]);
        assert.ok(Math.abs(summary.cpu_power_watts - 3.5) < 1e-12);
        assert.equal(summary.cpu_peak_power_watts, 4);
        assert.ok(Math.abs(summary.cpu_energy_wh - 14 / 3600) < 1e-12);
        assert.ok(Math.abs(summary.gpu_power_watts - 1.75) < 1e-12);
        assert.equal(summary.gpu_peak_power_watts, 2);
        assert.ok(Math.abs(summary.gpu_energy_wh - 7 / 3600) < 1e-12);
        assert.ok(Math.abs(summary.ane_power_watts - 1.25) < 1e-12);
        assert.equal(summary.ane_peak_power_watts, 1.5);
        assert.ok(Math.abs(summary.ane_energy_wh - 5 / 3600) < 1e-12);
        assert.ok(Math.abs(summary.energy_wh - 100 / 3600) < 1e-12,
            'total energy is integrated only from total power');
    });

    it('uses only intervals with available component data and reports wholly absent components unavailable', () => {
        const summary = summarizeTelemetry([
            { interval_seconds: 2, total_power_watts: 10, cpu_power_watts: 2, gpu_power_watts: null },
            { interval_seconds: 1, total_power_watts: 20, cpu_power_watts: null, gpu_power_watts: null },
        ]);
        assert.equal(summary.cpu_power_watts, 2);
        assert.equal(summary.cpu_duration_seconds, 2);
        assert.equal(summary.cpu_telemetry_count, 1);
        assert.equal(summary.gpu_power_watts, null);
        assert.equal(summary.gpu_energy_wh, null);
    });

    it('integrates client and EcoPrint allocation series and proportionally reconciles environment values', () => {
        const metrics = summarizeTelemetry([
            { interval_seconds: 2, total_power_watts: 10, client_workload_power_watts: 8,
                ecoprint_overhead_power_watts: 2, carbon_gCO2e: 0.1, water_liters: 0.02 },
        ]);
        assert.equal(metrics.client_workload_power_watts, 8);
        assert.equal(metrics.client_workload_peak_power_watts, 8);
        assert.equal(metrics.ecoprint_overhead_power_watts, 2);
        assert.equal(metrics.ecoprint_overhead_peak_power_watts, 2);
        assert.ok(Math.abs(metrics.client_workload_energy_wh - 16 / 3600) < 1e-12);
        assert.ok(Math.abs(metrics.ecoprint_overhead_energy_wh - 4 / 3600) < 1e-12);
        assert.ok(Math.abs(metrics.client_workload_carbon_gco2e - 0.08) < 1e-12);
        assert.ok(Math.abs(metrics.ecoprint_overhead_water_liters - 0.004) < 1e-12);
        assert.equal(metrics.client_workload_environmental_allocation, 'proportional-to-power');
    });

    it('does not report allocated environmental values when a split is missing or fails reconciliation', () => {
        const metrics = summarizeTelemetry([
            { interval_seconds: 1, total_power_watts: 10, client_workload_power_watts: 7,
                ecoprint_overhead_power_watts: 1, carbon_gCO2e: 0.2, water_liters: 0.1 },
            { interval_seconds: 1, total_power_watts: 10, client_workload_power_watts: null,
                ecoprint_overhead_power_watts: null, carbon_gCO2e: 0.2, water_liters: 0.1 },
        ]);
        assert.equal(metrics.client_workload_energy_wh, 7 / 3600);
        assert.equal(metrics.client_workload_carbon_gco2e, null);
        assert.equal(metrics.ecoprint_overhead_water_liters, null);
    });
});
