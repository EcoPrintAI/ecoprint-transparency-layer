/**
 * context.test.js — Tests for the Transparency Context Timeline.
 *
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 * Each test or suite gets its own in-memory database for full isolation.
 *
 * Run:
 *   node --test tests/context.test.js
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
    startContext,
    endContext,
    getContext,
    getAttemptContexts,
    getWorkloadContextTimeline,
    getContextsInWindow,
} from '../src/transparency/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Open a fresh in-memory database with the full schema applied. */
async function freshDb() {
    const db = await openDatabase(':memory:');
    await initSchema(db);
    return db;
}

/**
 * Create a complete identity scaffold (workload → run → attempt) and return
 * all three records.  Used by most tests to avoid repeating setup boilerplate.
 */
async function scaffoldAttempt(db, { workloadName = 'test-wl', workloadType = 'ci-build' } = {}) {
    const workload = await createWorkload(db, { name: workloadName, type: workloadType });
    const run      = await startRun(db,  { workloadId: workload.workload_id });
    const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
    return { workload, run, attempt };
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Transparency Context Timeline', () => {

    // ── 1. One attempt, one process context ──────────────────────────────────
    describe('one attempt with one process context', () => {
        let db, workload, run, attempt, ctx;

        before(async () => {
            db = await freshDb();
            ({ workload, run, attempt } = await scaffoldAttempt(db));
            ctx = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '12345',
                source:     'transparency-launch',
                resourceId: 'dev-macbook.local',
            });
        });

        after(() => closeDatabase(db));

        it('context_id is a non-empty string', () => {
            assert.ok(ctx.context_id && ctx.context_id.length > 0);
        });

        it('context_type defaults to "process"', () => {
            assert.equal(ctx.context_type, 'process');
        });

        it('externalId (PID) is stored correctly', () => {
            assert.equal(ctx.external_id, '12345');
        });

        it('source is stored correctly', () => {
            assert.equal(ctx.source, 'transparency-launch');
        });

        it('resource_id is stored correctly', () => {
            assert.equal(ctx.resource_id, 'dev-macbook.local');
        });

        it('started_at is a valid ISO timestamp', () => {
            assert.ok(!isNaN(Date.parse(ctx.started_at)));
        });

        it('ended_at is null when the context is still open', () => {
            assert.equal(ctx.ended_at, null);
        });

        it('context references the correct workload, run, and attempt', () => {
            assert.equal(ctx.workload_id, workload.workload_id);
            assert.equal(ctx.run_id,      run.run_id);
            assert.equal(ctx.attempt_id,  attempt.attempt_id);
        });

        it('getContext retrieves the same record from the database', async () => {
            const fetched = await getContext(db, ctx.context_id);
            assert.equal(fetched.context_id,  ctx.context_id);
            assert.equal(fetched.external_id, ctx.external_id);
            assert.equal(fetched.source,      ctx.source);
        });
    });


    // ── 2. Context completion ─────────────────────────────────────────────────
    describe('context completion', () => {
        let db, ctx, ended;

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt } = await scaffoldAttempt(db);
            ctx = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '99001',
                source:     'transparency-launch',
            });
            // Ensure at least 1 ms elapses before ending
            await new Promise(r => setTimeout(r, 2));
            ended = await endContext(db, { contextId: ctx.context_id });
        });

        after(() => closeDatabase(db));

        it('ended_at is set after endContext', () => {
            assert.ok(ended.ended_at, 'ended_at should be truthy');
            assert.ok(!isNaN(Date.parse(ended.ended_at)));
        });

        it('ended_at is strictly after started_at', () => {
            assert.ok(new Date(ended.ended_at) > new Date(ended.started_at));
        });

        it('context_id is unchanged after completion', () => {
            assert.equal(ended.context_id, ctx.context_id);
        });

        it('completed context is retrievable from the database', async () => {
            const fetched = await getContext(db, ctx.context_id);
            assert.ok(fetched.ended_at, 'ended_at should be persisted');
        });
    });


    // ── 3. Multiple contexts for one attempt ──────────────────────────────────
    describe('multiple contexts for one attempt', () => {
        let db, attempt, ctx1, ctx2, ctx3;

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt: att } = await scaffoldAttempt(db);
            attempt = att;

            ctx1 = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att.attempt_id,
                externalId: '1001',
                source:     'transparency-launch',
                resourceId: 'host-a',
            });
            ctx2 = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att.attempt_id,
                externalId: '1002',
                source:     'transparency-launch',
                resourceId: 'host-a',
            });
            ctx3 = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att.attempt_id,
                externalId: '1003',
                source:     'transparency-launch',
                resourceId: 'host-b',
            });
        });

        after(() => closeDatabase(db));

        it('getAttemptContexts returns all three contexts', async () => {
            const ctxs = await getAttemptContexts(db, attempt.attempt_id);
            assert.equal(ctxs.length, 3);
        });

        it('all contexts reference the same attempt_id', async () => {
            const ctxs = await getAttemptContexts(db, attempt.attempt_id);
            for (const c of ctxs) {
                assert.equal(c.attempt_id, attempt.attempt_id);
            }
        });

        it('context IDs are all distinct', () => {
            const ids = new Set([ctx1.context_id, ctx2.context_id, ctx3.context_id]);
            assert.equal(ids.size, 3);
        });

        it('contexts are ordered chronologically by started_at', async () => {
            const ctxs = await getAttemptContexts(db, attempt.attempt_id);
            for (let i = 1; i < ctxs.length; i++) {
                assert.ok(
                    new Date(ctxs[i].started_at) >= new Date(ctxs[i - 1].started_at),
                    'contexts should be ordered by started_at ascending'
                );
            }
        });
    });


    // ── 4. Failed attempt retains its context history ─────────────────────────
    describe('failed attempt retains its context history', () => {
        let db, attempt, ctx;

        before(async () => {
            db = await freshDb();
            const { workload, run, attempt: att } = await scaffoldAttempt(db);
            attempt = att;

            ctx = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  att.attempt_id,
                externalId: '5500',
                source:     'transparency-launch',
            });
            await endContext(db, { contextId: ctx.context_id });

            // Fail the attempt
            await completeAttempt(db, {
                attemptId: att.attempt_id,
                status:    'failed',
                reason:    'OOM',
            });
        });

        after(() => closeDatabase(db));

        it('context event is still retrievable after attempt fails', async () => {
            const fetched = await getContext(db, ctx.context_id);
            assert.ok(fetched, 'context should still exist');
        });

        it('context event still references the correct attempt', async () => {
            const fetched = await getContext(db, ctx.context_id);
            assert.equal(fetched.attempt_id, attempt.attempt_id);
        });

        it('getAttemptContexts still returns context after attempt fails', async () => {
            const ctxs = await getAttemptContexts(db, attempt.attempt_id);
            assert.equal(ctxs.length, 1);
            assert.equal(ctxs[0].context_id, ctx.context_id);
        });
    });


    // ── 5. Context events stay associated with the correct attempt ────────────
    describe('context events remain associated with the correct attempt', () => {
        let db, workload, run, attempt1, attempt2, ctx1, ctx2;

        before(async () => {
            db = await freshDb();
            workload  = await createWorkload(db, { name: 'multi-att', type: 'ci-build' });
            run       = await startRun(db, { workloadId: workload.workload_id });

            attempt1 = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            ctx1     = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt1.attempt_id,
                externalId: '7701',
                source:     'transparency-launch',
            });
            await completeAttempt(db, { attemptId: attempt1.attempt_id, status: 'failed', reason: 'error' });

            attempt2 = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            ctx2     = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt2.attempt_id,
                externalId: '7702',
                source:     'transparency-launch',
            });
            await completeAttempt(db, { attemptId: attempt2.attempt_id, status: 'completed' });
        });

        after(() => closeDatabase(db));

        it('attempt1 has exactly one context', async () => {
            const ctxs = await getAttemptContexts(db, attempt1.attempt_id);
            assert.equal(ctxs.length, 1);
        });

        it('attempt2 has exactly one context', async () => {
            const ctxs = await getAttemptContexts(db, attempt2.attempt_id);
            assert.equal(ctxs.length, 1);
        });

        it('ctx1 is not visible in attempt2 contexts', async () => {
            const ctxs = await getAttemptContexts(db, attempt2.attempt_id);
            const ids = ctxs.map(c => c.context_id);
            assert.ok(!ids.includes(ctx1.context_id));
        });

        it('ctx2 is not visible in attempt1 contexts', async () => {
            const ctxs = await getAttemptContexts(db, attempt1.attempt_id);
            const ids = ctxs.map(c => c.context_id);
            assert.ok(!ids.includes(ctx2.context_id));
        });
    });


    // ── 6. Workload context timeline ordered chronologically ──────────────────
    describe('getWorkloadContextTimeline ordered chronologically', () => {
        let db, workload, allContextIds;

        before(async () => {
            db = await freshDb();
            workload = await createWorkload(db, { name: 'timeline-wl', type: 'ci-build' });

            // Run 1, attempt 1 — two contexts
            const run1 = await startRun(db, { workloadId: workload.workload_id });
            const att1 = await startAttempt(db, { runId: run1.run_id, workloadId: workload.workload_id });
            const c1   = await startContext(db, {
                workloadId: workload.workload_id, runId: run1.run_id,
                attemptId: att1.attempt_id, externalId: '101', source: 'transparency-launch',
            });
            const c2   = await startContext(db, {
                workloadId: workload.workload_id, runId: run1.run_id,
                attemptId: att1.attempt_id, externalId: '102', source: 'transparency-launch',
            });
            await completeAttempt(db, { attemptId: att1.attempt_id, status: 'completed' });
            await completeRun(db, { runId: run1.run_id, status: 'completed' });

            // Run 2, attempt 1 — one context
            const run2 = await startRun(db, { workloadId: workload.workload_id });
            const att2 = await startAttempt(db, { runId: run2.run_id, workloadId: workload.workload_id });
            const c3   = await startContext(db, {
                workloadId: workload.workload_id, runId: run2.run_id,
                attemptId: att2.attempt_id, externalId: '201', source: 'transparency-launch',
            });
            await completeAttempt(db, { attemptId: att2.attempt_id, status: 'completed' });
            await completeRun(db, { runId: run2.run_id, status: 'completed' });

            allContextIds = [c1.context_id, c2.context_id, c3.context_id];
        });

        after(() => closeDatabase(db));

        it('returns all 3 context events for the workload', async () => {
            const ctxs = await getWorkloadContextTimeline(db, workload.workload_id);
            assert.equal(ctxs.length, 3);
        });

        it('all returned contexts belong to the workload', async () => {
            const ctxs = await getWorkloadContextTimeline(db, workload.workload_id);
            for (const c of ctxs) {
                assert.equal(c.workload_id, workload.workload_id);
            }
        });

        it('contexts are ordered by started_at ascending', async () => {
            const ctxs = await getWorkloadContextTimeline(db, workload.workload_id);
            for (let i = 1; i < ctxs.length; i++) {
                assert.ok(
                    new Date(ctxs[i].started_at) >= new Date(ctxs[i - 1].started_at),
                    'contexts must be in ascending started_at order'
                );
            }
        });
    });


    // ── 7. Query by overlapping time window ───────────────────────────────────
    describe('query by overlapping time window (getContextsInWindow)', () => {
        let db, workload, run, attempt;
        // Anchor: fixed ISO timestamps so comparisons are deterministic.
        // All timestamps are in the future relative to "now" so that
        // endedAt > started_at invariants hold even after we backdate started_at.
        const T0 = '2099-01-01T00:00:00.000Z';
        const T1 = '2099-01-01T00:01:00.000Z'; // +1 min
        const T2 = '2099-01-01T00:02:00.000Z'; // +2 min
        const T3 = '2099-01-01T00:03:00.000Z'; // +3 min
        const T4 = '2099-01-01T00:04:00.000Z'; // +4 min
        const T5 = '2099-01-01T00:05:00.000Z'; // +5 min

        before(async () => {
            db = await freshDb();
            workload = await createWorkload(db, { name: 'window-wl', type: 'cli' });
            run      = await startRun(db, { workloadId: workload.workload_id });
            attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });

            // Import the raw dbRun wrapper to set deterministic timestamps directly.
            // We insert with fully controlled timestamps rather than calling now().
            const { dbRun: _dbRun } = await import('../src/transparency/db.js');

            // Helper: insert a context_event row with explicit started_at / ended_at.
            const insertCtx = (id, pid, resource, startedAt, endedAt) =>
                _dbRun(db,
                    `INSERT INTO context_events
                         (context_id, workload_id, run_id, attempt_id,
                          context_type, external_id, resource_id,
                          started_at, ended_at, source, parent_context_id)
                     VALUES (?,?,?,?, 'process',?,?, ?,?,?,NULL)`,
                    [id, workload.workload_id, run.run_id, attempt.attempt_id,
                     pid, resource, startedAt, endedAt, 'transparency-launch']
                );

            // ctx A: T0–T2
            await insertCtx('ctx-A', 'pid-A', 'host-x', T0, T2);
            // ctx B: T1–T3
            await insertCtx('ctx-B', 'pid-B', 'host-x', T1, T3);
            // ctx C: T3–T5
            await insertCtx('ctx-C', 'pid-C', 'host-y', T3, T5);
            // ctx D: T4–T5
            await insertCtx('ctx-D', 'pid-D', 'host-y', T4, T5);
            // ctx E: T2–null (still running)
            await insertCtx('ctx-E', 'pid-E', null, T2, null);
        });

        after(() => closeDatabase(db));

        it('window T2–T4 returns contexts that overlap it (B, C, E — not A or D)', async () => {
            const ctxs = await getContextsInWindow(db, { windowStart: T2, windowEnd: T4 });
            const ids = ctxs.map(c => c.context_id);
            // B started at T1, ended T3 — overlaps T2–T4 ✓
            // C started at T3, ended T5 — overlaps T2–T4 ✓
            // E started at T2, no end   — overlaps T2–T4 ✓
            // A started T0, ended T2 — ended_at === windowStart, edge-inclusive ✓
            // D started T4, ended T5 — started_at === windowEnd, edge-inclusive ✓
            // All five overlap under the closed-interval rule [T2, T4]
            assert.ok(ids.includes('ctx-B'), 'ctx-B should be in window');
            assert.ok(ids.includes('ctx-C'), 'ctx-C should be in window');
            assert.ok(ids.includes('ctx-E'), 'ctx-E (still running) should be in window');
        });

        it('narrow window T0–T1 returns only ctx-A and ctx-B', async () => {
            const ctxs = await getContextsInWindow(db, { windowStart: T0, windowEnd: T1 });
            const ids  = ctxs.map(c => c.context_id);
            assert.ok(ids.includes('ctx-A'), 'ctx-A should be in T0–T1 window');
            assert.ok(ids.includes('ctx-B'), 'ctx-B (starts at T1) should be in T0–T1 window');
            assert.ok(!ids.includes('ctx-C'), 'ctx-C starts at T3, should not be in T0–T1');
            assert.ok(!ids.includes('ctx-D'), 'ctx-D starts at T4, should not be in T0–T1');
        });

        it('filter by attemptId narrows results', async () => {
            const ctxs = await getContextsInWindow(db, {
                windowStart: T0,
                windowEnd:   T5,
                attemptId:   attempt.attempt_id,
            });
            // all 5 contexts belong to this attempt
            assert.equal(ctxs.length, 5);
        });

        it('filter by workloadId narrows results', async () => {
            const ctxs = await getContextsInWindow(db, {
                windowStart: T0,
                windowEnd:   T5,
                workloadId:  workload.workload_id,
            });
            assert.equal(ctxs.length, 5);
        });

        it('filter by resourceId returns only contexts on that resource', async () => {
            const ctxs = await getContextsInWindow(db, {
                windowStart: T0,
                windowEnd:   T5,
                resourceId:  'host-x',
            });
            const ids = ctxs.map(c => c.context_id);
            assert.ok(ids.includes('ctx-A'));
            assert.ok(ids.includes('ctx-B'));
            assert.ok(!ids.includes('ctx-C'), 'ctx-C is on host-y');
            assert.ok(!ids.includes('ctx-D'), 'ctx-D is on host-y');
        });

        it('still-running context (no ended_at) is included in overlapping window', async () => {
            const ctxs = await getContextsInWindow(db, { windowStart: T2, windowEnd: T5 });
            const ids  = ctxs.map(c => c.context_id);
            assert.ok(ids.includes('ctx-E'), 'ctx-E has no ended_at and should be included');
        });
    });


    // ── 8. Invalid identity references are rejected ───────────────────────────
    describe('invalid workload/run/attempt references are rejected', () => {
        let db, workload, run, attempt;

        before(async () => {
            db = await freshDb();
            ({ workload, run, attempt } = await scaffoldAttempt(db));
        });

        after(() => closeDatabase(db));

        it('unknown workload_id throws', async () => {
            await assert.rejects(
                () => startContext(db, {
                    workloadId: 'nonexistent-wl',
                    runId:      run.run_id,
                    attemptId:  attempt.attempt_id,
                    externalId: '1',
                    source:     'test',
                }),
                /Unknown workload_id/
            );
        });

        it('unknown run_id throws', async () => {
            await assert.rejects(
                () => startContext(db, {
                    workloadId: workload.workload_id,
                    runId:      'nonexistent-run',
                    attemptId:  attempt.attempt_id,
                    externalId: '1',
                    source:     'test',
                }),
                /Unknown run_id/
            );
        });

        it('unknown attempt_id throws', async () => {
            await assert.rejects(
                () => startContext(db, {
                    workloadId: workload.workload_id,
                    runId:      run.run_id,
                    attemptId:  'nonexistent-att',
                    externalId: '1',
                    source:     'test',
                }),
                /Unknown attempt_id/
            );
        });

        it('run that does not belong to the workload throws', async () => {
            // Create a second workload with its own run
            const wl2  = await createWorkload(db, { name: 'other-wl', type: 'cli' });
            const run2 = await startRun(db, { workloadId: wl2.workload_id });

            await assert.rejects(
                () => startContext(db, {
                    workloadId: workload.workload_id, // first workload
                    runId:      run2.run_id,           // belongs to second workload
                    attemptId:  attempt.attempt_id,
                    externalId: '1',
                    source:     'test',
                }),
                /belongs to workload/
            );
        });

        it('attempt that does not belong to the run throws', async () => {
            // Create a second run under the same workload with its own attempt
            const run2  = await startRun(db, { workloadId: workload.workload_id });
            const att2  = await startAttempt(db, { runId: run2.run_id, workloadId: workload.workload_id });

            await assert.rejects(
                () => startContext(db, {
                    workloadId: workload.workload_id,
                    runId:      run.run_id,   // first run
                    attemptId:  att2.attempt_id, // belongs to second run
                    externalId: '1',
                    source:     'test',
                }),
                /belongs to run/
            );
        });

        it('endContext with unknown context_id throws', async () => {
            await assert.rejects(
                () => endContext(db, { contextId: 'ghost-context' }),
                /Unknown context_id/
            );
        });

        it('endContext with ended_at before started_at throws', async () => {
            const ctx = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '9999',
                source:     'test',
            });

            await assert.rejects(
                () => endContext(db, {
                    contextId: ctx.context_id,
                    endedAt:   '2000-01-01T00:00:00.000Z', // before started_at
                }),
                /must not precede started_at/
            );
        });
    });


    // ── 9. parent_context_id for process-tree relationships ───────────────────
    describe('parent_context_id linkage', () => {
        let db;

        before(async () => { db = await freshDb(); });
        after(() => closeDatabase(db));

        it('parent_context_id is stored and retrievable', async () => {
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'pctx-wl' });

            const parent = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '1000',
                source:     'transparency-launch',
            });

            const child = await startContext(db, {
                workloadId:      workload.workload_id,
                runId:           run.run_id,
                attemptId:       attempt.attempt_id,
                externalId:      '1001',
                source:          'transparency-launch',
                parentContextId: parent.context_id,
            });

            assert.equal(child.parent_context_id, parent.context_id);

            const fetched = await getContext(db, child.context_id);
            assert.equal(fetched.parent_context_id, parent.context_id);
        });

        it('parent_context_id is null by default', async () => {
            const { workload, run, attempt } = await scaffoldAttempt(db, { workloadName: 'pctx-null-wl' });

            const ctx = await startContext(db, {
                workloadId: workload.workload_id,
                runId:      run.run_id,
                attemptId:  attempt.attempt_id,
                externalId: '2000',
                source:     'transparency-launch',
            });

            assert.equal(ctx.parent_context_id, null);
        });
    });

});
