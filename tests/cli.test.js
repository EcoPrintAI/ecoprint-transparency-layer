/**
 * cli.test.js — Focused tests for the EcoPrint Transparency CLI orchestrator.
 *
 * All tests use in-memory databases and injected fakes for:
 *   - spawnFn   : simulates child process exit (success or failure)
 *   - telemetryFn: returns controlled telemetry rows
 *
 * No real child processes are spawned.
 * No real SigSense database is opened.
 * No real files are created.
 *
 * Run:
 *   node --test tests/cli.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { runUnderTransparency }   from '../src/transparency/cli.js';
import { openDatabase, initSchema, closeDatabase } from '../src/transparency/index.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Build a fake spawn function that simulates a child process.
 *
 * @param {object} opts
 * @param {number}  opts.exitCode      Process exit code (0 = success).
 * @param {number}  [opts.delayMs]     Delay before close event fires (default 5ms).
 * @param {boolean} [opts.spawnError]  If true, emit an 'error' event instead.
 * @param {number}  [opts.pid]         Fake PID (default 99999).
 */
function fakeSpawn({ exitCode = 0, delayMs = 5, spawnError = false, pid = 99999 } = {}) {
    return (_cmd, _args, _opts) => {
        const emitter     = new EventEmitter();
        emitter.pid       = pid;
        emitter.stdin     = null;
        emitter.stdout    = null;
        emitter.stderr    = null;

        setTimeout(() => {
            if (spawnError) {
                emitter.emit('error', new Error('spawn ENOENT'));
            } else {
                emitter.emit('close', exitCode);
            }
        }, delayMs);

        return emitter;
    };
}

/**
 * Build a fake telemetry function returning controlled rows.
 *
 * @param {object[]} rows  Array of telemetry row objects.
 */
function fakeTelemetry(rows = []) {
    return async (_windowStart, _windowEnd, _resourceId) => rows;
}

/** A standard telemetry row for test use. */
function tRow(ts, power = 0.32, carbon = 0.000047, water = 0.00000017) {
    return {
        timestamp:         ts,
        resource_id:       'test-host',
        total_power_watts: power,
        carbon_gCO2e:      carbon,
        water_liters:      water,
        interval_seconds:  1,
    };
}

/** Run CLI with in-memory DB and provided fakes. */
async function runCli(overrides = {}) {
    return runUnderTransparency({
        workloadName:   overrides.workloadName  ?? 'test-workload',
        workloadType:   overrides.workloadType  ?? 'cli-run',
        command:        overrides.command       ?? ['echo', 'hello'],
        transparencyDb: overrides.transparencyDb ?? ':memory:',
        spawnFn:        overrides.spawnFn       ?? fakeSpawn(),
        telemetryFn:    overrides.telemetryFn
            ? async (start, end, resource) => (await overrides.telemetryFn(start, end, resource))
                .map(row => row.timestamp?.startsWith('2099-') ? { ...row, timestamp: end } : row)
            : fakeTelemetry([]),
        ipcFn:          overrides.ipcFn          ?? (async () => 'OK COLLECTING'),
    });
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('EcoPrint Transparency CLI', () => {

    it('compares the actual baseline measurement sources in deterministic insights', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'ecoprint-cli-baseline-'));
        try {
            const telemetryFn = () => Promise.resolve([{
                ...tRow('2099-06-01T00:01:00.000Z', 2, 0.001, 0.000004),
                resource_id: os.hostname(),
                measurement_source: 'hardware',
                grid_intensity_source: 'electricity-maps-live',
            }]);
            const run = () => runCli({
                workloadName: 'baseline-source-test',
                transparencyDb: path.join(directory, 'transparency.db'),
                telemetryFn,
            });

            await run();
            const current = await run();

            assert.equal(current.baselineComparison.measurement_quality, 'hardware');
            assert.equal(current.baselineComparison.grid_intensity_quality, 'live');
            assert.equal(current.runMetrics.attribution_coverage, 100);
            assert.ok(!current.insights.OBSERVED.some(line => line.includes('Grid intensity source differs')));
            assert.ok(!current.insights.RECOMMENDATION.some(line => line.includes('Check whether live grid-intensity')));
            assert.ok(!current.insights.RECOMMENDATION.some(line => line.includes('Inspect unattributed telemetry')));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    // ── 1. Successful command execution ───────────────────────────────────────
    describe('successful command execution', () => {
        let result;

        before(async () => {
            result = await runCli({
                command:     ['echo', 'hello'],
                spawnFn:     fakeSpawn({ exitCode: 0, pid: 12345 }),
                telemetryFn: fakeTelemetry([]),
            });
        });

        it('exits with code 0', () => {
            assert.equal(result.exitCode, 0);
        });

        it('attempt status is completed', () => {
            assert.equal(result.attempt.status, 'completed');
        });

        it('run status is completed', () => {
            assert.equal(result.run.status, 'completed');
        });

        it('command is recorded correctly', () => {
            assert.deepEqual(result.command, ['echo', 'hello']);
        });

        it('spawnError is null', () => {
            assert.equal(result.spawnError, null);
        });
    });


    // ── 2. Failed command execution ───────────────────────────────────────────
    describe('failed command execution', () => {
        let result;

        before(async () => {
            result = await runCli({
                command:     ['false'],
                spawnFn:     fakeSpawn({ exitCode: 1, pid: 22222 }),
                telemetryFn: fakeTelemetry([]),
            });
        });

        it('exits with code 1', () => {
            assert.equal(result.exitCode, 1);
        });

        it('attempt status is failed', () => {
            assert.equal(result.attempt.status, 'failed');
        });

        it('attempt reason records exit code', () => {
            assert.ok(result.attempt.reason, 'reason should be set');
        });

        it('run status is failed', () => {
            assert.equal(result.run.status, 'failed');
        });

        it('workload identity is still created', () => {
            assert.ok(result.workload.workload_id);
        });
    });


    // ── 3. Workload / run / attempt lifecycle ─────────────────────────────────
    describe('workload / run / attempt lifecycle', () => {
        let result;

        before(async () => {
            result = await runCli({ workloadName: 'lifecycle-test' });
        });

        it('workload is created with the supplied name', () => {
            assert.equal(result.workload.name, 'lifecycle-test');
        });

        it('workload_id is a non-empty string', () => {
            assert.ok(result.workload.workload_id.length > 0);
        });

        it('run_id is a non-empty string', () => {
            assert.ok(result.run.run_id.length > 0);
        });

        it('attempt_id is a non-empty string', () => {
            assert.ok(result.attempt.attempt_id.length > 0);
        });

        it('attempt_no is 1 (first attempt)', () => {
            assert.equal(result.attempt.attempt_no, 1);
        });

        it('run references the correct workload', () => {
            assert.equal(result.run.workload_id, result.workload.workload_id);
        });

        it('attempt references the correct run', () => {
            assert.equal(result.attempt.run_id, result.run.run_id);
        });

        it('startedAt and endedAt are valid ISO timestamps', () => {
            assert.ok(!isNaN(Date.parse(result.startedAt)));
            assert.ok(!isNaN(Date.parse(result.endedAt)));
        });

        it('endedAt is at or after startedAt', () => {
            assert.ok(new Date(result.endedAt) >= new Date(result.startedAt));
        });
    });


    // ── 4. PID context creation and completion ────────────────────────────────
    describe('PID context creation and completion', () => {
        let result;

        before(async () => {
            result = await runCli({ spawnFn: fakeSpawn({ pid: 77777, exitCode: 0 }) });
        });

        it('contextId is a non-empty string', () => {
            assert.ok(result.contextId && result.contextId.length > 0);
        });

        it('pid matches the fake process PID', () => {
            assert.equal(result.pid, 77777);
        });

        it('resourceId is set (os.hostname result)', () => {
            assert.ok(result.resourceId && result.resourceId.length > 0);
        });

        it('contextId differs from workload_id, run_id, attempt_id', () => {
            assert.notEqual(result.contextId, result.workload.workload_id);
            assert.notEqual(result.contextId, result.run.run_id);
            assert.notEqual(result.contextId, result.attempt.attempt_id);
        });
    });


    // ── 5. Telemetry attribution integration ──────────────────────────────────
    describe('telemetry attribution integration', () => {
        let result;
        const T = '2099-06-01T00:01:00.000Z';   // timestamp within any window

        before(async () => {
            result = await runCli({
                telemetryFn: (_ws, _we, _rid) => Promise.resolve([
                    tRow(T, 1.5, 0.005, 0.002),
                ]),
            });
        });

        it('telemetryCount is 1', () => {
            assert.equal(result.telemetryCount, 1);
        });

        it('telemetryError is null', () => {
            assert.equal(result.telemetryError, null);
        });

        it('reconciliation.measured.power_watts equals the injected row', () => {
            assert.ok(Math.abs(result.reconciliation.measured.power_watts - 1.5) < 1e-9);
        });

        it('reconciliation.measured.carbon_gco2e equals the injected row', () => {
            const expected = result.telemetryRows[0].carbon_gCO2e;
            assert.ok(Math.abs(result.reconciliation.measured.carbon_gco2e - expected) < 1e-9);
        });
    });


    // ── 6. Reconciliation: measured = attributed + unattributed ───────────────
    describe('measured = attributed + unattributed', () => {
        let result;

        before(async () => {
            // Two telemetry rows; context will cover startedAt/endedAt exactly,
            // so both rows are within the execution window.
            result = await runCli({
                telemetryFn: (_ws, _we, _rid) => Promise.resolve([
                    tRow('2099-07-01T00:00:01Z', 2.0, 0.01, 0.001),
                    tRow('2099-07-01T00:00:02Z', 3.0, 0.02, 0.002),
                ]),
            });
        });

        it('attributed + unattributed power equals measured power', () => {
            const r = result.reconciliation;
            const total = r.attributed.power_watts + r.unattributed.power_watts;
            assert.ok(Math.abs(total - r.measured.power_watts) < 1e-9,
                `${total} !== ${r.measured.power_watts}`);
        });

        it('attributed + unattributed carbon equals measured carbon', () => {
            const r = result.reconciliation;
            const total = r.attributed.carbon_gco2e + r.unattributed.carbon_gco2e;
            assert.ok(Math.abs(total - r.measured.carbon_gco2e) < 1e-9);
        });

        it('attributed + unattributed water equals measured water', () => {
            const r = result.reconciliation;
            const total = r.attributed.water_liters + r.unattributed.water_liters;
            assert.ok(Math.abs(total - r.measured.water_liters) < 1e-9);
        });

        it('measured power is the time-weighted average of injected rows', () => {
            assert.ok(Math.abs(result.reconciliation.measured.power_watts - 2.5) < 1e-9);
        });
    });


    // ── 7. Terminal report generation (structural check) ─────────────────────
    describe('terminal report — result structure', () => {
        let result;

        before(async () => {
            result = await runCli({
                workloadName: 'report-test',
                command:      ['true'],
                telemetryFn:  fakeTelemetry([tRow('2099-08-01T00:01:00.000Z')]),
            });
        });

        it('result.workload.name is set', () => {
            assert.equal(result.workload.name, 'report-test');
        });

        it('result.reconciliation has window', () => {
            assert.ok(result.reconciliation.window);
            assert.ok(result.reconciliation.window.start);
            assert.ok(result.reconciliation.window.end);
        });

        it('result.reconciliation has measured, attributed, unattributed', () => {
            const r = result.reconciliation;
            assert.ok('power_watts'  in r.measured);
            assert.ok('power_watts'  in r.attributed);
            assert.ok('power_watts'  in r.unattributed);
        });

        it('durationMs is a non-negative number', () => {
            assert.ok(typeof result.durationMs === 'number');
            assert.ok(result.durationMs >= 0);
        });
    });


    // ── 8. Unavailable telemetry does not fabricate values ────────────────────
    describe('unavailable telemetry does not fabricate values', () => {
        let result;

        before(async () => {
            // telemetryFn throws to simulate an unavailable SigSense DB.
            result = await runCli({
                telemetryFn: async () => { throw new Error('SQLITE_CANTOPEN: no such file'); },
            });
        });

        it('telemetryError is set', () => {
            assert.ok(result.telemetryError && result.telemetryError.length > 0);
        });

        it('telemetryCount is 0', () => {
            assert.equal(result.telemetryCount, 0);
        });

        it('reconciliation measured values are all 0', () => {
            const m = result.reconciliation.measured;
            assert.equal(m.power_watts,  0);
            assert.equal(m.carbon_gco2e, 0);
            assert.equal(m.water_liters, 0);
        });

        it('attempt is still completed correctly (lifecycle unaffected)', () => {
            assert.equal(result.attempt.status, 'completed');
        });

        it('run is still completed correctly', () => {
            assert.equal(result.run.status, 'completed');
        });
    });


    // ── 9. Spawn error is handled gracefully ──────────────────────────────────
    describe('spawn error is handled gracefully', () => {
        let result;

        before(async () => {
            result = await runCli({
                command:  ['nonexistent-command-xyz'],
                spawnFn:  fakeSpawn({ spawnError: true, pid: 0 }),
            });
        });

        it('exitCode is non-zero', () => {
            assert.ok(result.exitCode !== 0);
        });

        it('attempt is marked failed', () => {
            assert.equal(result.attempt.status, 'failed');
        });

        it('workload/run/attempt records are still created', () => {
            assert.ok(result.workload.workload_id);
            assert.ok(result.run.run_id);
            assert.ok(result.attempt.attempt_id);
        });
    });

    describe('service run markers', () => {
        it('sends BEGIN before command start and END after command completion', async () => {
            const commands = [];
            const result = await runCli({ ipcFn: async command => {
                commands.push(command);
                return 'OK COLLECTING';
            } });
            assert.deepEqual(commands, [`BEGIN ${result.run.run_id}`, `END ${result.run.run_id}`]);
            assert.equal(result.ipcError, null);
        });
    });

    describe('persistent workload baselines', () => {
        it('reuses a named workload and compares its next completed run', async () => {
            const dir = await mkdtemp(path.join(tmpdir(), 'ecoprint-baseline-'));
            const dbPath = path.join(dir, 'transparency.db');
            try {
                const execute = power => runUnderTransparency({
                    workloadName: 'same-build', workloadType: 'cli-run', command: ['echo', 'build'],
                    transparencyDb: dbPath, spawnFn: fakeSpawn({ exitCode: 0 }),
                    ipcFn: async () => 'OK COLLECTING',
                    telemetryFn: async (_start, end) => [tRow(end, power, 0.01, 0.001)],
                });
                const first = await execute(12);
                const second = await execute(18);
                assert.equal(second.workload.workload_id, first.workload.workload_id);
                assert.equal(second.baselineComparison.run_id, first.run.run_id);
                assert.ok(Math.abs(second.baselineComparison.metrics.average_power_watts.absolute_delta - 6) < 1e-9);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });
    });

});
