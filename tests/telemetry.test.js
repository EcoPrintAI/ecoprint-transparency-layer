import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import { normalizeTelemetryRow, readTelemetryWindow } from '../src/transparency/telemetry.js';
import { prepareTelemetryRows, summarizeTelemetry } from '../src/transparency/metrics.js';

function exec(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}

describe('SigSense telemetry window adapter', () => {
    let db;
    after(async () => { if (db) await new Promise(resolve => db.close(resolve)); });

    it('includes boundary samples, source quality, and clips integration to the run window', async () => {
        db = new sqlite3.Database(':memory:');
        await exec(db, `CREATE TABLE telemetry (
            id INTEGER PRIMARY KEY, timestamp TEXT, node_id TEXT, total_power_watts REAL,
            carbon_gCO2e REAL, water_liters REAL, delta_time REAL,
            cpu_mw REAL, gpu_mw REAL, ane_mw REAL,
            client_workload_watts REAL, ecoprint_overhead_watts REAL
        )`);
        await exec(db, 'CREATE TABLE measurement_quality (telemetry_id INTEGER PRIMARY KEY, measurement_source TEXT, grid_intensity_source TEXT)');
        const samples = [
            [1, '2099-01-01T00:00:00.000Z', 100, 0.1, 0.01, 1, 100, 50, 25, 'hardware', 'electricity-maps-live'],
            [2, '2099-01-01T00:00:02.000Z', 10, 0.02, 0.002, 2, 200, 75, 30, 'hardware-rapl', 'electricity-maps-live'],
            [3, '2099-01-01T00:00:04.000Z', 20, 0.04, 0.004, 2, 300, 80, 50, 'fallback', 'fallback'],
        ];
        for (const [id, timestamp, power, carbon, water, delta, cpu, gpu, ane, source, gridSource] of samples) {
            await exec(db, 'INSERT INTO telemetry VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, timestamp, 'node-1', power, carbon, water, delta, cpu, gpu, ane, power * 0.92, power * 0.08]);
            await exec(db, 'INSERT INTO measurement_quality VALUES (?, ?, ?)', [id, source, gridSource]);
        }
        const rows = await readTelemetryWindow(db, {
            windowStart: '2099-01-01T00:00:01.000Z',
            windowEnd: '2099-01-01T00:00:03.000Z',
            resourceId: 'node-1',
        });
        assert.equal(rows.length, 3);
        assert.equal(rows[1].measurement_source, 'hardware-rapl');
        assert.equal(rows[2].measurement_source, 'fallback');
        assert.equal(rows[0].cpu_power_watts, 0.1);
        assert.equal(rows[0].gpu_power_watts, 0.05);
        assert.equal(rows[0].ane_power_watts, 0.025);
        assert.equal(rows[0].client_workload_power_watts, 92);
        assert.equal(rows[0].ecoprint_overhead_power_watts, 8);
        assert.equal(rows[0].allocation_basis, 'macos-parser-time-allocation');
        assert.equal(rows[0].split_provenance, 'allocated');
        assert.equal(rows[1].cpu_power_watts, null, 'aggregate RAPL is not represented as component telemetry');
        assert.equal(rows[2].gpu_power_watts, null, 'fallback values are not presented as hardware components');
        assert.equal(rows[1].grid_intensity_source, 'electricity-maps-live');
        const clipped = prepareTelemetryRows(rows,
            '2099-01-01T00:00:01.000Z', '2099-01-01T00:00:03.000Z');
        const metrics = summarizeTelemetry(clipped);
        assert.equal(metrics.duration_seconds, 2);
        assert.equal(metrics.power_watts, 15);
        assert.equal(metrics.peak_power_watts, 20);
        assert.ok(Math.abs(metrics.energy_wh - 30 / 3600) < 1e-12);
        assert.ok(Math.abs(metrics.carbon_gco2e - 0.03) < 1e-12);
    });

    it('normalizes component mW only for hardware component readings', () => {
        const row = normalizeTelemetryRow({ measurement_source: 'hardware', cpu_mw: 1234, gpu_mw: 250, ane_mw: null });
        assert.equal(row.cpu_power_watts, 1.234);
        assert.equal(row.gpu_power_watts, 0.25);
        assert.equal(row.ane_power_watts, null);
        assert.equal(normalizeTelemetryRow({ measurement_source: 'estimated-pdh-proxy', cpu_mw: 300 }).cpu_power_watts, null);
    });

    it('preserves unavailable allocations and marks modeled split methods', () => {
        const normalized = normalizeTelemetryRow({ measurement_source: 'hardware-rapl',
            client_workload_watts: null, ecoprint_overhead_watts: 2 }, 'linux');
        assert.equal(normalized.client_workload_power_watts, null);
        assert.equal(normalized.ecoprint_overhead_power_watts, 2);
        assert.equal(normalized.split_provenance, 'unavailable');
        assert.equal(normalized.allocation_basis, 'fixed-92-8-allocation');
        assert.equal(normalizeTelemetryRow({ measurement_source: 'estimated-pdh-proxy' }, 'win32').allocation_basis,
            'fixed-92-8-pdh-estimate');
    });
});
