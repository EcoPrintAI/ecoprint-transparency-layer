/**
 * attribution.test.js — Tests for the Transparency Deterministic Attribution Layer.
 *
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 * Each suite gets its own in-memory database for full isolation.
 *
 * Telemetry is passed in as plain normalized objects (no SigSense DB access).
 * All timestamps use 2099 to guarantee they are always in the future, which
 * means context ended_at values are always >= started_at for any test run date.
 *
 * Run:
 *   node --test tests/attribution.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
    openDatabase,
    initSchema,
    closeDatabase,
    createWorkload,
    startRun,
    completeRun,
    startAttempt,
    completeAttempt,
    attributeTelemetryWindow,
    recomputeAttribution,
    getAttribution,
    getAttemptAttribution,
    getWorkloadAttribution,
    getUnattributedTelemetry,
    reconcileAttribution,
} from '../src/transparency/index.js';
import { dbRun } from '../src/transparency/db.js';
import { dbAll } from '../src/transparency/db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function freshDb() {
    const db = await openDatabase(':memory:');
    await initSchema(db);
    return db;
}

async function scaffoldAttempt(db, { workloadName = 'test-wl', workloadType = 'ci-build' } = {}) {
    const workload = await createWorkload(db, { name: workloadName, type: workloadType });
    const run      = await startRun(db, { workloadId: workload.workload_id });
    const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
    return { workload, run, attempt };
}

/**
 * Insert a context_event row with fully controlled timestamps, bypassing
 * now() so tests are deterministic regardless of wall-clock time.
 */
async function insertCtx(db, { contextId, workloadId, runId, attemptId,
                                externalId, resourceId, startedAt, endedAt,
                                source = 'transparency-launch', attributionEligible = true,
                                processId = null, parentProcessId = null, classification = 'unknown' }) {
    await dbRun(db,
        `INSERT INTO context_events
             (context_id, workload_id, run_id, attempt_id,
              context_type, external_id, resource_id,
              started_at, ended_at, source, parent_context_id, attribution_eligible,
              process_id, parent_process_id, provenance_classification)
         VALUES (?,?,?,?, 'process',?,?, ?,?,?,NULL,?,?,?,?)`,
        [contextId, workloadId, runId, attemptId,
         externalId, resourceId ?? null,
         startedAt, endedAt ?? null, source, attributionEligible ? 1 : 0,
         processId, parentProcessId, classification]
    );
}

/** Build a minimal telemetry row for attribution. */
function tRow(timestamp, { resourceId = null, power = 1.0, carbon = 0.001, water = 0.0001,
    cpu = null, gpu = null, ane = null } = {}) {
    return {
        timestamp,
        resource_id:        resourceId,
        total_power_watts:  power,
        cpu_power_watts: cpu,
        gpu_power_watts: gpu,
        ane_power_watts: ane,
        carbon_gCO2e:       carbon,
        water_liters:       water,
        interval_seconds:   1,
        client_workload_power_watts: power * 0.8,
        ecoprint_overhead_power_watts: power * 0.2,
        client_workload_carbon_gCO2e: carbon * 0.8,
        ecoprint_overhead_carbon_gCO2e: carbon * 0.2,
        client_workload_water_liters: water * 0.8,
        ecoprint_overhead_water_liters: water * 0.2,
    };
}

// ── Fixed time anchors (all in 2099 — always > any real now()) ───────────────
const T = {
    s0:  '2099-06-01T00:00:00.000Z',   // context starts
    t1:  '2099-06-01T00:01:00.000Z',   // telemetry observation inside context
    e2:  '2099-06-01T00:02:00.000Z',   // context ends
    t3:  '2099-06-01T00:03:00.000Z',   // telemetry observation outside context
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Transparency Deterministic Attribution', () => {

    // ── 1. One observation + one matching context → exact attribution ─────────
    describe('one telemetry observation + one matching context', () => {
        let db, workload, run, attempt, recs;

        before(async () => {
            db = await freshDb();
            ({ workload, run, attempt } = await scaffoldAttempt(db));

            await insertCtx(db, {
                contextId:  'ctx-1a',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '1000',
                resourceId: 'host-a',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            const telemetry = [ tRow(T.t1, { resourceId: 'host-a', power: 2.5, carbon: 0.005, water: 0.002 }) ];
            recs = await attributeTelemetryWindow(db, {
                telemetry,
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
        });

        after(() => closeDatabase(db));

        it('produces exactly one attribution record', () => {
            assert.equal(recs.length, 1);
        });

        it('evidence_level is "exact"', () => {
            assert.equal(recs[0].evidence_level, 'exact');
        });

        it('attribution_method is "exact-context-match"', () => {
            assert.equal(recs[0].attribution_method, 'exact-context-match');
        });

        it('full power, carbon, water are attributed', () => {
            assert.ok(Math.abs(recs[0].attributed_power_watts  - 2.5)   < 1e-10);
            assert.ok(Math.abs(recs[0].attributed_carbon_gco2e - 0.005) < 1e-10);
            assert.ok(Math.abs(recs[0].attributed_water_liters - 0.002) < 1e-10);
        });

        it('attribution_version is set', () => {
            assert.ok(recs[0].attribution_version >= 1);
        });

        it('created_at is a valid ISO timestamp', () => {
            assert.ok(!isNaN(Date.parse(recs[0].created_at)));
        });
    });


    // ── 2. Attribution to the correct attempt ─────────────────────────────────
    describe('attribution to the correct attempt', () => {
        let db, workload, run, attempt, recs;

        before(async () => {
            db = await freshDb();
            ({ workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'corr-wl' }));

            await insertCtx(db, {
                contextId:  'ctx-corr',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '2000',
                resourceId: 'host-b',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            recs = await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1, { resourceId: 'host-b' }) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
        });

        after(() => closeDatabase(db));

        it('attribution references the correct attempt_id', () => {
            assert.equal(recs[0].attempt_id,  attempt.attempt_id);
        });

        it('attribution references the correct run_id', () => {
            assert.equal(recs[0].run_id, run.run_id);
        });

        it('attribution references the correct workload_id', () => {
            assert.equal(recs[0].workload_id, workload.workload_id);
        });

        it('attribution references the correct context_id', () => {
            assert.equal(recs[0].context_id, 'ctx-corr');
        });
    });


    // ── 3. Unmatched telemetry → unattributed ─────────────────────────────────
    describe('unmatched telemetry remains unattributed', () => {
        let db, recs, unattr;

        before(async () => {
            db = await freshDb();
            // No context events at all — observation at T.t1 has no match.
            recs = await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1, { power: 3.0, carbon: 0.01, water: 0.003 }) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
            unattr = await getUnattributedTelemetry(db, { windowStart: T.s0, windowEnd: T.e2 });
        });

        after(() => closeDatabase(db));

        it('produces one attribution record', () => {
            assert.equal(recs.length, 1);
        });

        it('evidence_level is "unattributed"', () => {
            assert.equal(recs[0].evidence_level, 'unattributed');
        });

        it('workload_id / run_id / attempt_id / context_id are all null', () => {
            assert.equal(recs[0].workload_id, null);
            assert.equal(recs[0].run_id,      null);
            assert.equal(recs[0].attempt_id,  null);
            assert.equal(recs[0].context_id,  null);
        });

        it('full measurement is preserved in the unattributed record', () => {
            assert.ok(Math.abs(recs[0].attributed_power_watts  - 3.0)  < 1e-10);
            assert.ok(Math.abs(recs[0].attributed_carbon_gco2e - 0.01) < 1e-10);
            assert.ok(Math.abs(recs[0].attributed_water_liters - 0.003)< 1e-10);
        });

        it('getUnattributedTelemetry returns the record', () => {
            assert.equal(unattr.length, 1);
            assert.equal(unattr[0].evidence_level, 'unattributed');
        });
    });


    // ── 4. Multiple overlapping contexts → equal-share split ─────────────────
    describe('multiple overlapping contexts — equal-share split', () => {
        let db, workload, run, att1, att2, recs;

        before(async () => {
            db = await freshDb();
            workload = await createWorkload(db, { name: 'share-wl', type: 'ci-build' });
            run      = await startRun(db, { workloadId: workload.workload_id });
            att1     = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            att2     = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });

            // Both contexts are active at T.t1 on the same resource.
            await insertCtx(db, {
                contextId:  'ctx-share-1',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att1.attempt_id,
                externalId: '3001',
                resourceId: 'host-c',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });
            await insertCtx(db, {
                contextId:  'ctx-share-2',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att2.attempt_id,
                externalId: '3002',
                resourceId: 'host-c',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            recs = await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1, { resourceId: 'host-c', power: 4.0, carbon: 0.02, water: 0.004 }) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
        });

        after(() => closeDatabase(db));

        it('produces two attribution records (one per context)', () => {
            assert.equal(recs.length, 2);
        });

        it('each record has evidence_level "shared"', () => {
            for (const r of recs) assert.equal(r.evidence_level, 'shared');
        });

        it('each record has attribution_method "equal-share-2-contexts"', () => {
            for (const r of recs) assert.equal(r.attribution_method, 'equal-share-2-contexts');
        });

        it('each record carries exactly half the power', () => {
            for (const r of recs) {
                assert.ok(Math.abs(r.attributed_power_watts - 2.0) < 1e-10);
            }
        });

        it('sum of shares equals the original measurement', () => {
            const sumPw  = recs.reduce((s, r) => s + r.attributed_power_watts,  0);
            const sumCo2 = recs.reduce((s, r) => s + r.attributed_carbon_gco2e, 0);
            const sumH2o = recs.reduce((s, r) => s + r.attributed_water_liters, 0);
            assert.ok(Math.abs(sumPw  - 4.0)  < 1e-10);
            assert.ok(Math.abs(sumCo2 - 0.02) < 1e-10);
            assert.ok(Math.abs(sumH2o - 0.004)< 1e-10);
        });
    });


    // ── 5. Resource mismatch prevents attribution ──────────────────────────────
    describe('resource mismatch prevents attribution', () => {
        let db, recs;

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'rm-wl' });

            // Context is on host-x, telemetry comes from host-y.
            await insertCtx(db, {
                contextId:  'ctx-rm',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '4000',
                resourceId: 'host-x',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            recs = await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1, { resourceId: 'host-y' }) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
        });

        after(() => closeDatabase(db));

        it('resource mismatch yields an unattributed record', () => {
            assert.equal(recs.length, 1);
            assert.equal(recs[0].evidence_level, 'unattributed');
        });

        it('context_id is null on the unattributed record', () => {
            assert.equal(recs[0].context_id, null);
        });
    });


    // ── 6. Failed attempt retains historical attribution ──────────────────────
    describe('failed attempt retains historical attribution', () => {
        let db, attempt, attrib;

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt: att } = await scaffoldAttempt(db, { workloadName: 'fail-wl' });
            attempt = att;

            await insertCtx(db, {
                contextId:  'ctx-fail',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att.attempt_id,
                externalId: '5000',
                resourceId: null,
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });

            // Fail the attempt after attribution.
            await completeAttempt(db, { attemptId: att.attempt_id, status: 'failed', reason: 'OOM' });
            attrib = await getAttemptAttribution(db, att.attempt_id);
        });

        after(() => closeDatabase(db));

        it('attribution records survive attempt failure', () => {
            assert.ok(attrib.length > 0);
        });

        it('attribution still references the failed attempt', () => {
            assert.equal(attrib[0].attempt_id, attempt.attempt_id);
        });
    });


    // ── 7. Retry attempts are distinct ────────────────────────────────────────
    describe('retry attempts remain distinct', () => {
        let db, workload, run, att1, att2, recs1, recs2;

        const T_ATT1_START = '2099-07-01T00:00:00.000Z';
        const T_ATT1_OBS   = '2099-07-01T00:01:00.000Z';
        const T_ATT1_END   = '2099-07-01T00:02:00.000Z';
        const T_ATT2_START = '2099-07-01T00:03:00.000Z';
        const T_ATT2_OBS   = '2099-07-01T00:04:00.000Z';
        const T_ATT2_END   = '2099-07-01T00:05:00.000Z';

        before(async () => {
            db = await freshDb();
            workload = await createWorkload(db, { name: 'retry-wl', type: 'ci-build' });
            run      = await startRun(db, { workloadId: workload.workload_id });
            att1     = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });

            await insertCtx(db, {
                contextId:  'ctx-retry-1',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att1.attempt_id,
                externalId: '6001',
                startedAt:  T_ATT1_START,
                endedAt:    T_ATT1_END,
            });
            await completeAttempt(db, { attemptId: att1.attempt_id, status: 'failed', reason: 'error' });

            att2 = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            await insertCtx(db, {
                contextId:  'ctx-retry-2',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att2.attempt_id,
                externalId: '6002',
                startedAt:  T_ATT2_START,
                endedAt:    T_ATT2_END,
            });

            await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T_ATT1_OBS), tRow(T_ATT2_OBS) ],
                windowStart: T_ATT1_START,
                windowEnd:   T_ATT2_END,
            });

            recs1 = await getAttemptAttribution(db, att1.attempt_id);
            recs2 = await getAttemptAttribution(db, att2.attempt_id);
        });

        after(() => closeDatabase(db));

        it('first attempt has its own attribution record', () => {
            assert.equal(recs1.length, 1);
        });

        it('second attempt has its own attribution record', () => {
            assert.equal(recs2.length, 1);
        });

        it('attempt 1 and attempt 2 attribution records are distinct', () => {
            assert.notEqual(recs1[0].attribution_id, recs2[0].attribution_id);
            assert.notEqual(recs1[0].attempt_id,     recs2[0].attempt_id);
        });

        it('workload_id is the same for both (same workload)', () => {
            assert.equal(recs1[0].workload_id, workload.workload_id);
            assert.equal(recs2[0].workload_id, workload.workload_id);
        });
    });


    // ── 8. Deterministic recomputation produces identical results ─────────────
    describe('deterministic recomputation', () => {
        let db, first, second;

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'det-wl' });

            await insertCtx(db, {
                contextId:  'ctx-det',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '7000',
                resourceId: 'host-d',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            const telemetry = [ tRow(T.t1, { resourceId: 'host-d', power: 1.5, carbon: 0.003, water: 0.001 }) ];
            const window    = { windowStart: T.s0, windowEnd: T.e2 };

            first  = await attributeTelemetryWindow(db, { telemetry, ...window });
            second = await recomputeAttribution(db,      { telemetry, ...window });
        });

        after(() => closeDatabase(db));

        it('recomputation yields the same number of records', () => {
            assert.equal(first.length, second.length);
        });

        it('recomputation yields identical evidence_level', () => {
            assert.equal(first[0].evidence_level, second[0].evidence_level);
        });

        it('recomputation yields identical attribution_method', () => {
            assert.equal(first[0].attribution_method, second[0].attribution_method);
        });

        it('recomputation yields identical measurement values', () => {
            assert.ok(Math.abs(first[0].attributed_power_watts  - second[0].attributed_power_watts)  < 1e-10);
            assert.ok(Math.abs(first[0].attributed_carbon_gco2e - second[0].attributed_carbon_gco2e) < 1e-10);
            assert.ok(Math.abs(first[0].attributed_water_liters - second[0].attributed_water_liters) < 1e-10);
        });

        it('recomputation increments attribution_version', () => {
            assert.ok(second[0].attribution_version > first[0].attribution_version);
        });
    });


    // ── 9. Attribution version is recorded ───────────────────────────────────
    describe('attribution_version is recorded', () => {
        let db;

        before(async () => { db = await freshDb(); });
        after(() => closeDatabase(db));

        it('version is >= 1 on all records', async () => {
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'ver-wl' });
            await insertCtx(db, {
                contextId:  'ctx-ver',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '8000',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });
            const recs = await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
            assert.ok(recs[0].attribution_version >= 1);
        });

        it('getAttribution retrieves a record by attribution_id', async () => {
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'get-wl' });
            await insertCtx(db, {
                contextId:  'ctx-get',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '8001',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });
            const recs   = await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
            const fetched = await getAttribution(db, recs[0].attribution_id);
            assert.equal(fetched.attribution_id, recs[0].attribution_id);
        });
    });


    // ── 10. Reconciliation: measured = attributed + unattributed ──────────────
    describe('measured = attributed + unattributed (reconciliation)', () => {
        let db, report;
        const WIN_START = '2099-08-01T00:00:00.000Z';
        const WIN_END   = '2099-08-01T01:00:00.000Z';
        const TS_A      = '2099-08-01T00:10:00.000Z';
        const TS_B      = '2099-08-01T00:20:00.000Z';
        const TS_C      = '2099-08-01T00:30:00.000Z';

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'rec-wl' });

            // Context covers TS_A and TS_B but not TS_C.
            await insertCtx(db, {
                contextId:  'ctx-rec',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '9000',
                startedAt:  WIN_START,
                endedAt:    '2099-08-01T00:25:00.000Z',  // ends before TS_C
            });

            const telemetry = [
                tRow(TS_A, { power: 2.0, carbon: 0.002, water: 0.0002 }),  // attributed
                tRow(TS_B, { power: 3.0, carbon: 0.003, water: 0.0003 }),  // attributed
                tRow(TS_C, { power: 1.0, carbon: 0.001, water: 0.0001 }),  // unattributed
            ];
            await attributeTelemetryWindow(db, { telemetry, windowStart: WIN_START, windowEnd: WIN_END });
            report = await reconcileAttribution(db, { windowStart: WIN_START, windowEnd: WIN_END, telemetry });
        });

        after(() => closeDatabase(db));

        it('measured power is the time-weighted average, not a sample sum', () => {
            assert.ok(Math.abs(report.measured.power_watts - 2.0) < 1e-10);
            assert.ok(Math.abs(report.measured.peak_power_watts - 3.0) < 1e-10);
        });

        it('attributed + unattributed power equals measured power', () => {
            const total = report.attributed.power_watts + report.unattributed.power_watts;
            assert.ok(Math.abs(total - report.measured.power_watts) < 1e-10);
        });

        it('attributed + unattributed carbon equals measured carbon', () => {
            const total = report.attributed.carbon_gco2e + report.unattributed.carbon_gco2e;
            assert.ok(Math.abs(total - report.measured.carbon_gco2e) < 1e-10);
        });

        it('attributed + unattributed water equals measured water', () => {
            const total = report.attributed.water_liters + report.unattributed.water_liters;
            assert.ok(Math.abs(total - report.measured.water_liters) < 1e-10);
        });

        it('report window matches the queried range', () => {
            assert.equal(report.window.start, WIN_START);
            assert.equal(report.window.end,   WIN_END);
        });
    });

    describe('reconciliation uses only the current attribution version', () => {
        let db;
        after(() => closeDatabase(db));

        it('does not double-count when the same window is attributed again', async () => {
            db = await freshDb();
            const { workload, run, attempt } = await scaffoldAttempt(db);
            const timestamp = '2099-09-01T00:00:02.000Z';
            await insertCtx(db, {
                contextId: 'ctx-version', workloadId: workload.workload_id,
                runId: run.run_id, attemptId: attempt.attempt_id,
                externalId: '42', resourceId: 'node-a',
                startedAt: '2099-09-01T00:00:00.000Z',
                endedAt: '2099-09-01T00:00:03.000Z',
            });
            const telemetry = [tRow(timestamp, { resourceId: 'node-a', power: 12 })];
            const window = {
                windowStart: '2099-09-01T00:00:00.000Z',
                windowEnd: '2099-09-01T00:00:03.000Z',
            };
            await attributeTelemetryWindow(db, { ...window, telemetry });
            const first = await reconcileAttribution(db, { ...window, telemetry });
            await attributeTelemetryWindow(db, { ...window, telemetry });
            const second = await reconcileAttribution(db, { ...window, telemetry });
            assert.equal(first.attributed.power_watts, 12);
            assert.equal(second.attributed.power_watts, 12);
            assert.equal(second.attribution_version, first.attribution_version + 1);
        });
    });


    // ── 11. Chronological ordering ───────────────────────────────────────────
    describe('chronological results', () => {
        let db;
        const BASE = '2099-09-01T00:';

        before(async () => { db = await freshDb(); });
        after(() => closeDatabase(db));

        it('getAttemptAttribution returns records ordered by telemetry_timestamp ASC', async () => {
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'chron-wl' });

            await insertCtx(db, {
                contextId:  'ctx-chron',
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '10000',
                startedAt:  `${BASE}00:00.000Z`,
                endedAt:    `${BASE}10:00.000Z`,
            });

            const timestamps = [
                `${BASE}05:00.000Z`,
                `${BASE}02:00.000Z`,
                `${BASE}08:00.000Z`,
                `${BASE}01:00.000Z`,
            ];
            const telemetry = timestamps.map(ts => tRow(ts));
            await attributeTelemetryWindow(db, {
                telemetry,
                windowStart: `${BASE}00:00.000Z`,
                windowEnd:   `${BASE}10:00.000Z`,
            });

            const recs = await getAttemptAttribution(db, attempt.attempt_id);
            for (let i = 1; i < recs.length; i++) {
                assert.ok(
                    recs[i].telemetry_timestamp >= recs[i - 1].telemetry_timestamp,
                    'records must be in ascending telemetry_timestamp order'
                );
            }
        });
    });


    // ── 12. Workload and attempt query isolation ──────────────────────────────
    describe('workload and attempt queries return only their own records', () => {
        let db, wl1, wl2, att1, att2;

        before(async () => {
            db = await freshDb();

            const sc1 = await scaffoldAttempt(db, { workloadName: 'iso-wl-1' });
            const sc2 = await scaffoldAttempt(db, { workloadName: 'iso-wl-2' });
            wl1  = sc1.workload;
            wl2  = sc2.workload;
            att1 = sc1.attempt;
            att2 = sc2.attempt;

            await insertCtx(db, {
                contextId:  'ctx-iso-1',
                workloadId: wl1.workload_id,
                runId:      sc1.run.run_id,
                attemptId:  att1.attempt_id,
                externalId: '11001',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });
            await insertCtx(db, {
                contextId:  'ctx-iso-2',
                workloadId: wl2.workload_id,
                runId:      sc2.run.run_id,
                attemptId:  att2.attempt_id,
                externalId: '11002',
                startedAt:  T.s0,
                endedAt:    T.e2,
            });

            // Both contexts are active at T.t1 but belong to different workloads.
            // resource_id is null on both — so both will match T.t1.
            // Two records will be produced (equal-share).
            await attributeTelemetryWindow(db, {
                telemetry:   [ tRow(T.t1) ],
                windowStart: T.s0,
                windowEnd:   T.e2,
            });
        });

        after(() => closeDatabase(db));

        it('getWorkloadAttribution for wl1 returns only wl1 records', async () => {
            const recs = await getWorkloadAttribution(db, wl1.workload_id);
            assert.ok(recs.length > 0);
            for (const r of recs) assert.equal(r.workload_id, wl1.workload_id);
        });

        it('getWorkloadAttribution for wl2 returns only wl2 records', async () => {
            const recs = await getWorkloadAttribution(db, wl2.workload_id);
            assert.ok(recs.length > 0);
            for (const r of recs) assert.equal(r.workload_id, wl2.workload_id);
        });

        it('getAttemptAttribution for att1 returns only att1 records', async () => {
            const recs = await getAttemptAttribution(db, att1.attempt_id);
            assert.ok(recs.length > 0);
            for (const r of recs) assert.equal(r.attempt_id, att1.attempt_id);
        });

        it('getAttemptAttribution for att2 returns only att2 records', async () => {
            const recs = await getAttemptAttribution(db, att2.attempt_id);
            assert.ok(recs.length > 0);
            for (const r of recs) assert.equal(r.attempt_id, att2.attempt_id);
        });
    });

    describe('component attribution and reconciliation', () => {
        let db;
        after(async () => { if (db) await closeDatabase(db); });

        it('attributes each available component and reconciles component energy independently', async () => {
            db = await freshDb();
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'components' });
            await insertCtx(db, {
                contextId: 'ctx-components', workloadId: workload.workload_id,
                runId: run.run_id, attemptId: attempt.attempt_id, externalId: 'comp-1',
                resourceId: 'host-components', startedAt: T.s0, endedAt: T.e2, processId: 111,
            });
            await insertCtx(db, {
                contextId: 'ctx-lineage-worker', workloadId: workload.workload_id,
                runId: run.run_id, attemptId: attempt.attempt_id, externalId: 'comp-child',
                resourceId: 'host-components', startedAt: T.s0, endedAt: T.e2,
                attributionEligible: false, processId: 222, parentProcessId: 111,
                classification: 'child-of-client',
            });
            const telemetry = [
                tRow(T.t1, { resourceId: 'host-components', power: 3, cpu: 1.2, gpu: 0.5, ane: 0.1 }),
                tRow(T.t3, { resourceId: 'host-components', power: 2, cpu: 0.8, gpu: 0.2, ane: null }),
            ].map(row => ({ ...row, interval_seconds: 2 }));
            telemetry[0].process_id = 222;
            const records = await attributeTelemetryWindow(db, {
                telemetry, windowStart: T.t1, windowEnd: T.t3,
            });
            const storedSplits = await dbAll(db, 'SELECT attributed_client_workload_carbon_gco2e, attributed_ecoprint_overhead_carbon_gco2e FROM attribution_records ORDER BY telemetry_timestamp');
            assert.equal(storedSplits[0].attributed_client_workload_carbon_gco2e, 0.0008);
            assert.equal(records[0].attributed_cpu_power_watts, 1.2);
            assert.equal(records[0].attributed_gpu_power_watts, 0.5);
            assert.equal(records[0].attributed_ane_power_watts, 0.1);
            assert.ok(Math.abs(records[0].attributed_client_workload_power_watts - 2.4) < 1e-12);
            assert.ok(Math.abs(records[0].attributed_client_workload_carbon_gco2e - 0.0008) < 1e-12);
            assert.equal(records[0].evidence_level, 'exact', 'provenance-only contexts do not dilute system telemetry');
            assert.equal(records[0].attribution_method, 'parent-lineage-match');
            assert.equal(records[1].attributed_ane_power_watts, null);

            const report = await reconcileAttribution(db, {
                telemetry, windowStart: T.t1, windowEnd: T.t3,
            });
            for (const component of ['cpu', 'gpu', 'ane']) {
                const energy = `${component}_energy_wh`;
                const power = `${component}_power_watts`;
                assert.ok(Math.abs(report.measured[energy] - report.attributed[energy] - report.unattributed[energy]) < 1e-12);
                assert.ok(Math.abs(report.measured[power] - report.attributed[power] - report.unattributed[power]) < 1e-12);
            }
            for (const component of ['client_workload', 'ecoprint_overhead']) {
                assert.ok(Math.abs(report.measured[`${component}_energy_wh`] - report.attributed[`${component}_energy_wh`] - report.unattributed[`${component}_energy_wh`]) < 1e-12,
                    `${component} energy: ${JSON.stringify([report.measured[`${component}_energy_wh`], report.attributed[`${component}_energy_wh`], report.unattributed[`${component}_energy_wh`]])}`);
                assert.ok(Math.abs(report.measured[`${component}_power_watts`] - report.attributed[`${component}_power_watts`] - report.unattributed[`${component}_power_watts`]) < 1e-12);
                assert.ok(Math.abs(report.measured[`${component}_carbon_gco2e`] - report.attributed[`${component}_carbon_gco2e`] - report.unattributed[`${component}_carbon_gco2e`]) < 1e-12,
                    `${component} carbon: ${JSON.stringify([report.measured[`${component}_carbon_gco2e`], report.attributed[`${component}_carbon_gco2e`], report.unattributed[`${component}_carbon_gco2e`]])}`);
                assert.ok(Math.abs(report.measured[`${component}_water_liters`] - report.attributed[`${component}_water_liters`] - report.unattributed[`${component}_water_liters`]) < 1e-12);
            }
            assert.ok(Math.abs(report.attributed.cpu_energy_wh - 2.4 / 3600) < 1e-12);
            assert.ok(Math.abs(report.unattributed.cpu_energy_wh - 1.6 / 3600) < 1e-12);
            assert.equal(report.measured.ane_duration_seconds, 2);
            assert.equal(report.unattributed.ane_energy_wh, 0);
            assert.equal(report.measured.energy_wh, 10 / 3600, 'total energy still uses total power only');
        });
    });

});
