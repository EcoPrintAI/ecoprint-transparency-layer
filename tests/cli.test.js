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
import { formatReport } from '../src/transparency/report.js';

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
        processMonitorFactory: overrides.processMonitorFactory ?? (() => ({ start: async () => {}, stop: async () => [] })),
        identityEnv: overrides.identityEnv,
        aiProvider: overrides.aiProvider,
    });
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('EcoPrint Transparency CLI', () => {

    it('uses orchestrator identity, persists process provenance, and exposes full self-measurement facts to an AI adapter', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'ecoprint-provenance-'));
        const dbPath = path.join(directory, 'transparency.db');
        let childEnv;
        let aiFacts;
        try {
            const result = await runCli({
                workloadName: 'orchestrated-build',
                transparencyDb: dbPath,
                identityEnv: {
                    ECOPRINT_WORKLOAD_ID: 'orch-workload',
                    ECOPRINT_RUN_ID: 'orch-run',
                    ECOPRINT_ATTEMPT_ID: 'orch-attempt',
                },
                spawnFn: (cmd, args, options) => {
                    childEnv = options.env;
                    return fakeSpawn({ pid: 9101 })(cmd, args, options);
                },
                processMonitorFactory: () => ({
                    start: async () => {},
                    stop: async () => [{ pid: 9102, parentPid: 9101, executable: 'worker',
                        processStartedAt: '2099-06-01T00:00:00.000Z', processStartQuality: 'estimated-seconds',
                        classification: 'child-of-client', startedAt: '2099-06-01T00:00:00.000Z',
                        endedAt: '2099-06-01T00:00:01.000Z' }],
                }),
                telemetryFn: (start, end, resource) => [{
                    ...tRow(end, 10, 0.1, 0.02), resource_id: resource,
                    client_workload_power_watts: 8, ecoprint_overhead_power_watts: 2,
                    measurement_source: 'hardware', allocation_basis: 'macos-parser-time-allocation',
                    split_provenance: 'allocated',
                }],
                aiProvider: { explain: async ({ facts }) => { aiFacts = facts; return 'Uses supplied facts only.'; } },
            });
            assert.equal(result.workload.workload_id, 'orch-workload');
            assert.equal(result.run.run_id, 'orch-run');
            assert.equal(result.attempt.attempt_id, 'orch-attempt');
            assert.equal(childEnv.ECOPRINT_WORKLOAD_ID, 'orch-workload');
            assert.equal(result.processContexts.length, 1);
            assert.equal(result.runMetrics.client_workload_average_power_watts, 8);
            assert.equal(result.runMetrics.ecoprint_overhead_average_power_watts, 2);
            assert.equal(result.runMetrics.measurement_efficiency_pct, 80);
            assert.equal(result.runMetrics.provenance_quality, 'hardware-total-with-allocated-split');
            assert.equal(aiFacts.current_run_facts.process_lineage.some(item => item.classification === 'child-of-client'), true);
            assert.equal(aiFacts.current_run_facts.self_measurement.allocation_method, 'macos-parser-time-allocation');
            assert.equal(result.aiExplanation, 'Uses supplied facts only.');

            const persisted = await openDatabase(dbPath);
            try {
                const contexts = await new Promise((resolve, reject) => persisted.all(
                    'SELECT process_id, parent_process_id, executable_identity, provenance_classification, attribution_eligible FROM context_events ORDER BY started_at',
                    (error, rows) => error ? reject(error) : resolve(rows)));
                const eco = contexts.find(row => row.provenance_classification === 'ecoprint');
                const child = contexts.find(row => row.pid === 9102 || row.process_id === 9102);
                assert.ok(eco);
                assert.equal(child?.provenance_classification, 'child-of-client');
                assert.equal(child?.attribution_eligible, 0);
            } finally {
                await closeDatabase(persisted);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('reports measurement efficiency as unavailable when allocated energy is zero', async () => {
        const result = await runCli({
            telemetryFn: async (_start, end, resource) => [{
                timestamp: end, resource_id: resource, total_power_watts: 0,
                client_workload_power_watts: 0, ecoprint_overhead_power_watts: 0,
                carbon_gCO2e: 0, water_liters: 0, interval_seconds: 1,
                measurement_source: 'fallback', allocation_basis: 'fallback-allocation', split_provenance: 'allocated',
            }],
        });
        assert.equal(result.runMetrics.measurement_efficiency_pct, null);
        assert.equal(result.runMetrics.provenance_quality, 'estimated-total-with-allocated-split');
    });

    it('keeps a zero-duration point sample unavailable for integrated run metrics', async () => {
        const result = await runCli({
            telemetryFn: async (_start, end, resource) => [{
                timestamp: end, resource_id: resource, total_power_watts: 8,
                cpu_power_watts: 7, gpu_power_watts: 1, ane_power_watts: 0,
                carbon_gCO2e: 0.01, water_liters: 0.001, interval_seconds: 0,
                measurement_source: 'hardware', grid_intensity_source: 'electricity-maps-live',
            }],
        });
        assert.equal(result.telemetryCount, 0);
        assert.equal(result.runMetrics.measurement_method, 'unavailable');
        assert.equal(result.runMetrics.energy_wh, 0);
        assert.equal(result.runMetrics.peak_power_watts, null);
    });

    it('does not adopt ambient identity unless the CLI entry point supplies it', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'ecoprint-ambient-identity-'));
        const dbPath = path.join(directory, 'transparency.db');
        const names = ['ECOPRINT_WORKLOAD_ID', 'ECOPRINT_RUN_ID', 'ECOPRINT_ATTEMPT_ID'];
        const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
        process.env.ECOPRINT_WORKLOAD_ID = 'outer-workload';
        process.env.ECOPRINT_RUN_ID = 'outer-run';
        process.env.ECOPRINT_ATTEMPT_ID = 'outer-attempt';
        try {
            const result = await runCli({ transparencyDb: dbPath });
            assert.notEqual(result.workload.workload_id, 'outer-workload');
            assert.notEqual(result.run.run_id, 'outer-run');
            assert.notEqual(result.attempt.attempt_id, 'outer-attempt');
        } finally {
            for (const name of names) {
                if (previous[name] === undefined) delete process.env[name];
                else process.env[name] = previous[name];
            }
            await rm(directory, { recursive: true, force: true });
        }
    });

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

        it('waits for the END flush before reading an overlapping sample for a sub-second run', async () => {
            let releaseEnd;
            let signalEndStarted;
            let telemetryRead = false;
            const endGate = new Promise(resolve => { releaseEnd = resolve; });
            const endStarted = new Promise(resolve => { signalEndStarted = resolve; });
            const execution = runCli({
                spawnFn: fakeSpawn({ delayMs: 60 }),
                ipcFn: async command => {
                    if (command.startsWith('END ')) {
                        signalEndStarted();
                        await endGate;
                    }
                    return 'OK IDLE';
                },
                telemetryFn: async (_start, end, resource) => {
                    telemetryRead = true;
                    return [{
                        timestamp: new Date(Date.parse(end) + 100).toISOString(),
                        resource_id: resource,
                        total_power_watts: 10,
                        cpu_power_watts: 8,
                        gpu_power_watts: 2,
                        ane_power_watts: 0,
                        client_workload_power_watts: 9,
                        ecoprint_overhead_power_watts: 1,
                        carbon_gCO2e: 0.05,
                        water_liters: 0.001,
                        interval_seconds: 0.5,
                        measurement_source: 'hardware',
                        grid_intensity_source: 'electricity-maps-live',
                    }];
                },
            });

            await endStarted;
            assert.equal(telemetryRead, false, 'query must wait while END drains the sample');
            releaseEnd();
            const result = await execution;

            assert.equal(telemetryRead, true);
            assert.equal(result.telemetryCount, 1);
            assert.ok(result.runMetrics.duration_ms < 500);
            assert.ok(result.telemetryRows[0].interval_seconds > 0);
            assert.ok(result.telemetryRows[0].interval_seconds <= result.runMetrics.duration_ms / 1000);
            assert.ok(result.runMetrics.energy_wh > 0, 'only the measured overlap contributes energy');
            assert.equal(result.runMetrics.measurement_method, 'hardware');
        });
    });

    describe('optional AI interpretation and case memory', () => {
        it('keeps a no-AI run deterministic and saves its eligible evidence case', async () => {
            const directory = await mkdtemp(path.join(tmpdir(), 'ecoprint-no-ai-'));
            const dbPath = path.join(directory, 'transparency.db');
            try {
                const result = await runCli({
                    transparencyDb: dbPath,
                    telemetryFn: async (_start, end, resource) => [{
                        ...tRow(end, 12, 0.01, 0.001), resource_id: resource,
                        measurement_source: 'hardware',
                    }],
                });
                assert.equal(result.aiExplanation, null);
                assert.equal(result.aiError, null);
                assert.equal(result.aiUsage, null);
                assert.doesNotMatch(formatReport(result), /AI USAGE|Tokens:/);
                assert.ok(Math.abs(result.runMetrics.average_power_watts - 12) < 1e-9);
                const db = await openDatabase(dbPath);
                try {
                    const cases = await new Promise((resolve, reject) => db.all(
                        'SELECT measured_facts_json, derived_facts_json, ai_usage_json FROM experience_cases WHERE run_id = ?',
                        [result.run.run_id], (error, rows) => error ? reject(error) : resolve(rows)));
                    assert.equal(cases.length, 1);
                    assert.equal(JSON.parse(cases[0].measured_facts_json).telemetry_observations[0].total_power_watts, 12);
                    assert.ok(Math.abs(JSON.parse(cases[0].derived_facts_json).metrics.average_power_watts - 12) < 1e-9);
                    assert.equal(cases[0].ai_usage_json, null);
                } finally {
                    await closeDatabase(db);
                }
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });

        it('passes similar historical cases to AI and places the explanation after deterministic insights', async () => {
            const directory = await mkdtemp(path.join(tmpdir(), 'ecoprint-ai-memory-'));
            const dbPath = path.join(directory, 'transparency.db');
            const observations = [];
            const aiProvider = {
                name: 'fake-provider', model: 'fake-model', usageMetadata: null,
                async explain(args) {
                    observations.push(args.facts);
                    this.usageMetadata = {
                        provider: 'fake-provider', model: 'fake-model', input_tokens: 100, output_tokens: 20,
                        total_tokens: 120, inference_latency_ms: null, local_request_latency_ms: 10, request_id: null,
                    };
                    return 'The current CPU average is 12 W; investigate the build steps associated with the observed increase.';
                },
            };
            const telemetryFn = async (_start, end, resource) => [{
                ...tRow(end, 12, 0.01, 0.001), resource_id: resource,
                cpu_power_watts: 8, gpu_power_watts: 4, ane_power_watts: 0,
                measurement_source: 'hardware',
            }];
            try {
                const first = await runCli({ workloadName: 'repeatable-build', transparencyDb: dbPath, telemetryFn, aiProvider });
                const second = await runCli({ workloadName: 'repeatable-build', transparencyDb: dbPath, telemetryFn, aiProvider });
                assert.equal(observations[0].historical_experience_not_current_measurements.status, 'novel-pattern-no-prior-cases');
                assert.equal(first.aiExplanation.startsWith('The current CPU'), true,
                    'no matching historical case still permits current-run AI interpretation');
                assert.equal(observations[1].historical_experience_not_current_measurements.cases.length, 1);
                assert.equal(observations[1].historical_experience_not_current_measurements.cases[0].historical_ai_interpretation.status, 'unverified');
                assert.equal(observations[1].historical_experience_not_current_measurements.cases[0].ai_usage.signal_type, 'logical_ai_usage');
                assert.equal(observations[1].historical_experience_not_current_measurements.cases[0].ai_usage.input_tokens, 100);
                assert.ok(Math.abs(observations[1].current_run_facts.measurement.average_power_watts - 12) < 1e-9);
                assert.ok(Math.abs(second.runMetrics.average_power_watts - 12) < 1e-9,
                    'AI output cannot replace deterministic metrics');
                const report = formatReport(second);
                assert.ok(report.indexOf('DETERMINISTIC INSIGHTS') < report.indexOf('AI INTERPRETATION'));
                assert.ok(report.indexOf('AI INTERPRETATION') < report.indexOf('AI USAGE'));
                assert.match(report, /The current CPU average is 12 W/);
                assert.match(report, /Prior cases: 1/);
                const markdownReport = formatReport({ ...second, aiExplanation: '## Summary\n- **Measured** `fact`' });
                assert.match(markdownReport, /SUMMARY\n  • Measured fact/);
                assert.doesNotMatch(markdownReport, /##|`|\*\*/);
                assert.ok(Math.abs(first.runMetrics.average_power_watts - 12) < 1e-9);
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });

        it('withholds a historical-data hallucination for a no-telemetry current run', async () => {
            const directory = await mkdtemp(path.join(tmpdir(), 'ecoprint-ai-grounding-'));
            const dbPath = path.join(directory, 'transparency.db');
            let receivedFacts;
            const aiProvider = {
                name: 'ollama', model: 'llama3.2:3b', usageMetadata: null,
                async explain({ facts }) {
                    receivedFacts = facts;
                    this.usageMetadata = {
                        provider: 'ollama', model: 'llama3.2:3b', input_tokens: 10, output_tokens: 4,
                        total_tokens: 14, inference_latency_ms: 2, local_request_latency_ms: 3,
                    };
                    const duration = facts.current_run_facts.measurement.duration_ms;
                    return `Current run completed in ${duration + 1000} ms. Current CPU rose to 8 W and energy increased to 0.02 Wh. Input tokens 999.`;
                },
            };
            try {
                const previous = await runCli({
                    workloadName: 'grounded-repeatable-build', transparencyDb: dbPath,
                    telemetryFn: async (_start, end, resource) => [{
                        ...tRow(end, 12, 0.01, 0.001), resource_id: resource, measurement_source: 'hardware',
                    }],
                });
                const result = await runCli({
                    workloadName: 'grounded-repeatable-build', transparencyDb: dbPath,
                    aiProvider, telemetryFn: async () => [],
                });
                assert.ok(receivedFacts.historical_experience_not_current_measurements.cases.some(
                    item => item.run_id === previous.run.run_id));
                const current = receivedFacts.current_run_facts;
                assert.equal(current.telemetry_observation_count, 0);
                assert.equal(current.measurement.duration_ms, result.durationMs);
                assert.equal(current.measurement.average_power_watts, null);
                assert.equal(current.measurement.cpu_average_power_watts, null);
                assert.equal(current.measurement.energy_wh, null);
                assert.equal(current.measurement.carbon_gco2e, null);
                assert.equal(current.measurement.water_liters, null);
                assert.equal(current.baseline.metrics.energy_wh.absolute_delta, null);
                assert.equal(result.aiExplanation, null);
                assert.match(result.aiGroundingError, /physical measurement claim/);
                assert.equal(result.aiUsage.input_tokens, 10);
                const report = formatReport(result);
                assert.match(report, /Current physical telemetry is unavailable \(0 SigSense observations\)/);
                assert.match(report, /Historical experience remains context only/);
                assert.doesNotMatch(report, /Current CPU rose to 8 W|Input tokens 999/);
                assert.ok(Math.abs(result.runMetrics.average_power_watts - 0) < 1e-9,
                    'the AI-only projection does not change deterministic no-observation accounting');
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });

        it('handles AI configuration and provider failures without failing the workload', async () => {
            const result = await runCli({
                spawnFn: fakeSpawn({ exitCode: 0 }),
                aiProvider: { explain: async () => { throw new Error('provider is offline'); } },
                telemetryFn: async (_start, end, resource) => [{
                    ...tRow(end, 7, 0.001, 0.0001), resource_id: resource, measurement_source: 'hardware',
                }],
            });
            assert.equal(result.exitCode, 0);
            assert.equal(result.aiExplanation, null);
            assert.equal(result.aiError, 'provider is offline');
            assert.ok(Math.abs(result.runMetrics.average_power_watts - 7) < 1e-9);
            assert.match(formatReport(result), /AI INTERPRETATION[\s\S]*Unavailable: provider is offline/);
        });

        it('reports AI token metadata as logical usage separate from hardware measurements', async () => {
            const usageMetadata = {
                provider: 'ollama', model: 'llama3.2:3b', input_tokens: 30, output_tokens: 10,
                total_tokens: 40, inference_latency_ms: 150, local_request_latency_ms: 175, request_id: null,
            };
            const aiProvider = {
                name: 'ollama', model: 'llama3.2:3b', usageMetadata: null,
                async explain() { this.usageMetadata = usageMetadata; return 'Interprets supplied run facts.'; },
            };
            const result = await runCli({
                spawnFn: fakeSpawn({ exitCode: 0 }), aiProvider,
                telemetryFn: async (_start, end, resource) => [{
                    ...tRow(end, 7, 0.001, 0.0001), resource_id: resource, measurement_source: 'hardware',
                }],
            });
            assert.deepEqual({
                signal_type: result.aiUsage.signal_type,
                provider: result.aiUsage.provider,
                model: result.aiUsage.model,
                input_tokens: result.aiUsage.input_tokens,
                output_tokens: result.aiUsage.output_tokens,
                total_tokens: result.aiUsage.total_tokens,
                workload_id: result.aiUsage.workload_id,
                run_id: result.aiUsage.run_id,
                attempt_id: result.aiUsage.attempt_id,
                attempt_no: result.aiUsage.attempt_no,
                physical_correlation: result.aiUsage.physical_correlation,
            }, {
                signal_type: 'logical_ai_usage', provider: usageMetadata.provider, model: usageMetadata.model,
                input_tokens: 30, output_tokens: 10, total_tokens: 40,
                workload_id: result.workload.workload_id, run_id: result.run.run_id,
                attempt_id: result.attempt.attempt_id, attempt_no: result.attempt.attempt_no,
                physical_correlation: 'not-established',
            });
            const report = formatReport(result);
            assert.match(report, /AI USAGE/);
            assert.match(report, /Provider: ollama/);
            assert.match(report, /Input tokens: 30/);
            assert.match(report, /Output tokens: 10/);
            assert.match(report, /Total tokens: 40/);
            assert.match(report, /Request ID: unavailable/);
            assert.match(report, /Physical inference footprint: unavailable/);
            assert.match(report, /physical energy measurement/);
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
