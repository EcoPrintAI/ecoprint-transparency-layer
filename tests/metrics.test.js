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
        });
    });
});
