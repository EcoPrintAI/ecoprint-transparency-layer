import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import { readTelemetryWindow } from '../src/transparency/telemetry.js';
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
            carbon_gCO2e REAL, water_liters REAL, delta_time REAL
        )`);
        await exec(db, 'CREATE TABLE measurement_quality (telemetry_id INTEGER PRIMARY KEY, measurement_source TEXT, grid_intensity_source TEXT)');
        const samples = [
            [1, '2099-01-01T00:00:00.000Z', 100, 0.1, 0.01, 1, 'hardware-rapl', 'electricity-maps-live'],
            [2, '2099-01-01T00:00:02.000Z', 10, 0.02, 0.002, 2, 'hardware-rapl', 'electricity-maps-live'],
            [3, '2099-01-01T00:00:04.000Z', 20, 0.04, 0.004, 2, 'fallback', 'fallback'],
        ];
        for (const [id, timestamp, power, carbon, water, delta, source, gridSource] of samples) {
            await exec(db, 'INSERT INTO telemetry VALUES (?, ?, ?, ?, ?, ?, ?)',
                [id, timestamp, 'node-1', power, carbon, water, delta]);
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
});
