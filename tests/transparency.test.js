/**
 * transparency.test.js — Tests for the Transparency Identity Core.
 *
 * Uses Node.js built-in test runner (node:test) — no extra dependencies.
 * Each test gets its own in-memory database so tests are fully isolated.
 *
 * Run:
 *   node --test tests/transparency.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
    openDatabase,
    initSchema,
    closeDatabase,
    createWorkload,
    getWorkload,
    startRun,
    completeRun,
    getRun,
    startAttempt,
    completeAttempt,
    getAttempt,
    getWorkloadTimeline,
    buildIdentityEnv,
    readIdentityEnv,
    ENV_WORKLOAD_ID,
    ENV_RUN_ID,
    ENV_ATTEMPT_ID,
} from '../src/transparency/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Open a fresh in-memory database with the schema applied. */
async function freshDb() {
    const db = await openDatabase(':memory:');
    await initSchema(db);
    return db;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Transparency Identity Core', () => {

    // ── 1. One workload, one run, one successful attempt ─────────────────────
    describe('single workload / single run / single successful attempt', () => {
        let db, workload, run, attempt;

        before(async () => {
            db = await freshDb();
            workload = await createWorkload(db, { name: 'build-main', type: 'ci-build' });
            run      = await startRun(db, { workloadId: workload.workload_id });
            attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            attempt  = await completeAttempt(db, { attemptId: attempt.attempt_id, status: 'completed' });
            run      = await completeRun(db, { runId: run.run_id, status: 'completed' });
        });

        after(() => closeDatabase(db));

        it('workload has a non-empty workload_id', () => {
            assert.ok(workload.workload_id, 'workload_id should be truthy');
        });

        it('workload has correct name and type', () => {
            assert.equal(workload.name, 'build-main');
            assert.equal(workload.type, 'ci-build');
        });

        it('workload created_at is an ISO string', () => {
            assert.ok(!isNaN(Date.parse(workload.created_at)), 'created_at should be a valid date');
        });

        it('workload initial status is active', () => {
            assert.equal(workload.status, 'active');
        });

        it('run has a non-empty run_id', () => {
            assert.ok(run.run_id, 'run_id should be truthy');
        });

        it('run references the correct workload_id', () => {
            assert.equal(run.workload_id, workload.workload_id);
        });

        it('run final status is completed', () => {
            assert.equal(run.status, 'completed');
        });

        it('run has valid started_at and ended_at timestamps', () => {
            assert.ok(!isNaN(Date.parse(run.started_at)));
            assert.ok(!isNaN(Date.parse(run.ended_at)));
        });

        it('ended_at is at or after started_at', () => {
            assert.ok(new Date(run.ended_at) >= new Date(run.started_at));
        });

        it('attempt has a non-empty attempt_id', () => {
            assert.ok(attempt.attempt_id, 'attempt_id should be truthy');
        });

        it('attempt references the correct run_id and workload_id', () => {
            assert.equal(attempt.run_id, run.run_id);
            assert.equal(attempt.workload_id, workload.workload_id);
        });

        it('attempt_no is 1 (first attempt in the run)', () => {
            assert.equal(attempt.attempt_no, 1);
        });

        it('attempt final status is completed', () => {
            assert.equal(attempt.status, 'completed');
        });

        it('attempt has valid started_at and ended_at timestamps', () => {
            assert.ok(!isNaN(Date.parse(attempt.started_at)));
            assert.ok(!isNaN(Date.parse(attempt.ended_at)));
        });
    });


    // ── 2. One run: failed first attempt, then successful second attempt ──────
    describe('failed first attempt followed by a second successful attempt', () => {
        let db, workload, run, attempt1, attempt2;

        before(async () => {
            db = await freshDb();
            workload  = await createWorkload(db, { name: 'flaky-test', type: 'test-suite' });
            run       = await startRun(db, { workloadId: workload.workload_id });

            // First attempt — fails
            attempt1  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            attempt1  = await completeAttempt(db, {
                attemptId: attempt1.attempt_id,
                status: 'failed',
                reason: 'timeout after 30s',
            });

            // Second attempt — succeeds
            attempt2  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            attempt2  = await completeAttempt(db, { attemptId: attempt2.attempt_id, status: 'completed' });

            run = await completeRun(db, { runId: run.run_id, status: 'completed' });
        });

        after(() => closeDatabase(db));

        it('first attempt status is failed', () => {
            assert.equal(attempt1.status, 'failed');
        });

        it('first attempt has a reason', () => {
            assert.equal(attempt1.reason, 'timeout after 30s');
        });

        it('second attempt status is completed', () => {
            assert.equal(attempt2.status, 'completed');
        });

        it('second attempt has no reason', () => {
            assert.equal(attempt2.reason, null);
        });

        it('attempt sequence numbers are 1 and 2', () => {
            assert.equal(attempt1.attempt_no, 1);
            assert.equal(attempt2.attempt_no, 2);
        });

        it('run final status is completed', () => {
            assert.equal(run.status, 'completed');
        });
    });


    // ── 3. Stable workload_id across retries ─────────────────────────────────
    describe('stable workload_id across retries', () => {
        let db, workload;

        before(async () => {
            db = await freshDb();
            workload = await createWorkload(db, { name: 'stable-job', type: 'ci-build' });
        });

        after(() => closeDatabase(db));

        it('workload_id is identical when retrieved from the database', async () => {
            const fetched = await getWorkload(db, workload.workload_id);
            assert.equal(fetched.workload_id, workload.workload_id);
        });

        it('workload_id stays the same across multiple runs', async () => {
            const run1 = await startRun(db, { workloadId: workload.workload_id });
            const run2 = await startRun(db, { workloadId: workload.workload_id });

            assert.equal(run1.workload_id, workload.workload_id);
            assert.equal(run2.workload_id, workload.workload_id);
        });
    });


    // ── 4. Distinct attempt IDs for distinct attempts ─────────────────────────
    describe('distinct attempt IDs for distinct attempts', () => {
        let db;

        before(async () => {
            db = await freshDb();
        });

        after(() => closeDatabase(db));

        it('every attempt_id is unique', async () => {
            const workload = await createWorkload(db, { name: 'multi-attempt', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });

            const a1 = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            await completeAttempt(db, { attemptId: a1.attempt_id, status: 'failed', reason: 'error' });

            const a2 = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            await completeAttempt(db, { attemptId: a2.attempt_id, status: 'failed', reason: 'error' });

            const a3 = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            await completeAttempt(db, { attemptId: a3.attempt_id, status: 'completed' });

            const ids = [a1.attempt_id, a2.attempt_id, a3.attempt_id];
            const unique = new Set(ids);
            assert.equal(unique.size, 3, 'all three attempt IDs must be distinct');
        });

        it('attempt IDs differ from run IDs and workload IDs', async () => {
            const workload = await createWorkload(db, { name: 'id-check', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });

            assert.notEqual(attempt.attempt_id, run.run_id);
            assert.notEqual(attempt.attempt_id, workload.workload_id);
            assert.notEqual(run.run_id,         workload.workload_id);
        });
    });


    // ── 5. Correct timestamps and lifecycle status ────────────────────────────
    describe('correct start/end timestamps and lifecycle status', () => {
        let db;

        before(async () => {
            db = await freshDb();
        });

        after(() => closeDatabase(db));

        it('run started_at precedes ended_at', async () => {
            const workload = await createWorkload(db, { name: 'ts-run', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            // Ensure at least 1 ms passes
            await new Promise(r => setTimeout(r, 2));
            const completed = await completeRun(db, { runId: run.run_id, status: 'completed' });

            assert.ok(new Date(completed.ended_at) > new Date(completed.started_at),
                'ended_at must be strictly after started_at');
        });

        it('attempt started_at precedes ended_at', async () => {
            const workload = await createWorkload(db, { name: 'ts-attempt', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            await new Promise(r => setTimeout(r, 2));
            const completed = await completeAttempt(db, { attemptId: attempt.attempt_id, status: 'completed' });

            assert.ok(new Date(completed.ended_at) > new Date(completed.started_at),
                'ended_at must be strictly after started_at');
        });

        it('run status transitions: running → completed', async () => {
            const workload = await createWorkload(db, { name: 'ts-status', type: 'ci-build' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            assert.equal(run.status, 'running');

            const completed = await completeRun(db, { runId: run.run_id, status: 'completed' });
            assert.equal(completed.status, 'completed');
        });

        it('run status transitions: running → failed', async () => {
            const workload = await createWorkload(db, { name: 'ts-fail', type: 'ci-build' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            const failed   = await completeRun(db, { runId: run.run_id, status: 'failed' });
            assert.equal(failed.status, 'failed');
        });

        it('attempt status transitions: running → completed', async () => {
            const workload = await createWorkload(db, { name: 'ts-att-ok', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            assert.equal(attempt.status, 'running');

            const completed = await completeAttempt(db, { attemptId: attempt.attempt_id, status: 'completed' });
            assert.equal(completed.status, 'completed');
        });

        it('attempt status transitions: running → failed', async () => {
            const workload = await createWorkload(db, { name: 'ts-att-fail', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
            const failed   = await completeAttempt(db, { attemptId: attempt.attempt_id, status: 'failed', reason: 'OOM' });
            assert.equal(failed.status, 'failed');
            assert.equal(failed.reason, 'OOM');
        });

        it('ended_at is null while attempt is still running', async () => {
            const workload = await createWorkload(db, { name: 'ts-in-progress', type: 'cli' });
            const run      = await startRun(db, { workloadId: workload.workload_id });
            const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });

            const live = await getAttempt(db, attempt.attempt_id);
            assert.equal(live.ended_at, null);
        });
    });


    // ── 6. Timeline retrieval ─────────────────────────────────────────────────
    describe('getWorkloadTimeline', () => {
        let db, workloadId;

        before(async () => {
            db = await freshDb();

            const workload = await createWorkload(db, { name: 'timeline-job', type: 'ci-build' });
            workloadId     = workload.workload_id;

            // Run 1: one failed attempt, one successful attempt
            const run1 = await startRun(db, { workloadId });
            const a1   = await startAttempt(db, { runId: run1.run_id, workloadId });
            await completeAttempt(db, { attemptId: a1.attempt_id, status: 'failed', reason: 'flake' });
            const a2   = await startAttempt(db, { runId: run1.run_id, workloadId });
            await completeAttempt(db, { attemptId: a2.attempt_id, status: 'completed' });
            await completeRun(db, { runId: run1.run_id, status: 'completed' });

            // Run 2: one successful attempt
            const run2 = await startRun(db, { workloadId });
            const a3   = await startAttempt(db, { runId: run2.run_id, workloadId });
            await completeAttempt(db, { attemptId: a3.attempt_id, status: 'completed' });
            await completeRun(db, { runId: run2.run_id, status: 'completed' });
        });

        after(() => closeDatabase(db));

        it('returns the workload record', async () => {
            const timeline = await getWorkloadTimeline(db, workloadId);
            assert.equal(timeline.workload.workload_id, workloadId);
        });

        it('returns 2 runs', async () => {
            const { runs } = await getWorkloadTimeline(db, workloadId);
            assert.equal(runs.length, 2);
        });

        it('first run has 2 attempts', async () => {
            const { runs } = await getWorkloadTimeline(db, workloadId);
            assert.equal(runs[0].attempts.length, 2);
        });

        it('second run has 1 attempt', async () => {
            const { runs } = await getWorkloadTimeline(db, workloadId);
            assert.equal(runs[1].attempts.length, 1);
        });

        it('attempts are ordered by attempt_no', async () => {
            const { runs } = await getWorkloadTimeline(db, workloadId);
            const nos = runs[0].attempts.map(a => a.attempt_no);
            assert.deepEqual(nos, [1, 2]);
        });
    });


    // ── 7. Identity propagation via environment variables ────────────────────
    describe('identity propagation environment variables', () => {
        it('buildIdentityEnv produces the correct variable names', () => {
            const env = buildIdentityEnv({
                workloadId: 'wl-abc',
                runId:      'run-def',
                attemptId:  'att-ghi',
            });

            assert.equal(env[ENV_WORKLOAD_ID], 'wl-abc');
            assert.equal(env[ENV_RUN_ID],      'run-def');
            assert.equal(env[ENV_ATTEMPT_ID],  'att-ghi');
        });

        it('readIdentityEnv reads back what buildIdentityEnv produced', () => {
            const built = buildIdentityEnv({
                workloadId: 'wl-1',
                runId:      'run-2',
                attemptId:  'att-3',
            });

            const identity = readIdentityEnv(built);
            assert.equal(identity.workloadId, 'wl-1');
            assert.equal(identity.runId,      'run-2');
            assert.equal(identity.attemptId,  'att-3');
        });

        it('readIdentityEnv returns null for unset variables', () => {
            const identity = readIdentityEnv({});
            assert.equal(identity.workloadId, null);
            assert.equal(identity.runId,      null);
            assert.equal(identity.attemptId,  null);
        });

        it('ENV constants match the canonical variable names', () => {
            assert.equal(ENV_WORKLOAD_ID, 'ECOPRINT_WORKLOAD_ID');
            assert.equal(ENV_RUN_ID,      'ECOPRINT_RUN_ID');
            assert.equal(ENV_ATTEMPT_ID,  'ECOPRINT_ATTEMPT_ID');
        });
    });


    // ── 8. External identity — all three record types ─────────────────────────
    describe('external identity contract', () => {
        let db;

        before(async () => { db = await freshDb(); });
        after(() => closeDatabase(db));

        // ── 8a. External workload_id is preserved ─────────────────────────────
        it('external workload_id is preserved exactly', async () => {
            const ext = 'ext-wl-github-actions-build-001';
            const wl  = await createWorkload(db, { name: 'ext-wl', type: 'ci-build', workloadId: ext });
            assert.equal(wl.workload_id, ext);

            const fetched = await getWorkload(db, ext);
            assert.equal(fetched.workload_id, ext);
        });

        it('external workload_id → identity_source is "external"', async () => {
            const wl = await createWorkload(db, { name: 'ext-src-wl', type: 'ci-build', workloadId: 'ext-wl-src-check' });
            assert.equal(wl.identity_source, 'external');

            const fetched = await getWorkload(db, wl.workload_id);
            assert.equal(fetched.identity_source, 'external');
        });

        // ── 8b. External run_id is preserved ─────────────────────────────────
        it('external run_id is preserved exactly', async () => {
            const wl    = await createWorkload(db, { name: 'ext-run-wl', type: 'ci-build' });
            const extId = 'ext-run-github-check-suite-9988';
            const run   = await startRun(db, { workloadId: wl.workload_id, runId: extId });
            assert.equal(run.run_id, extId);

            const fetched = await getRun(db, extId);
            assert.equal(fetched.run_id, extId);
        });

        it('external run_id → identity_source is "external"', async () => {
            const wl  = await createWorkload(db, { name: 'ext-run-src', type: 'ci-build' });
            const run = await startRun(db, { workloadId: wl.workload_id, runId: 'ext-run-src-001' });
            assert.equal(run.identity_source, 'external');

            const fetched = await getRun(db, run.run_id);
            assert.equal(fetched.identity_source, 'external');
        });

        // ── 8c. External attempt_id is preserved ──────────────────────────────
        it('external attempt_id is preserved exactly', async () => {
            const wl      = await createWorkload(db, { name: 'ext-att-wl', type: 'cli' });
            const run     = await startRun(db, { workloadId: wl.workload_id });
            const extId   = 'ext-att-jenkins-retry-1-job-77';
            const attempt = await startAttempt(db, { runId: run.run_id, workloadId: wl.workload_id, attemptId: extId });
            assert.equal(attempt.attempt_id, extId);

            const fetched = await getAttempt(db, extId);
            assert.equal(fetched.attempt_id, extId);
        });

        it('external attempt_id → identity_source is "external"', async () => {
            const wl      = await createWorkload(db, { name: 'ext-att-src', type: 'cli' });
            const run     = await startRun(db, { workloadId: wl.workload_id });
            const attempt = await startAttempt(db, { runId: run.run_id, workloadId: wl.workload_id, attemptId: 'ext-att-src-001' });
            assert.equal(attempt.identity_source, 'external');

            const fetched = await getAttempt(db, attempt.attempt_id);
            assert.equal(fetched.identity_source, 'external');
        });

        // ── 8d. Externally supplied attempt_no is preserved ───────────────────
        it('externally supplied attempt_no is preserved when provided', async () => {
            const wl      = await createWorkload(db, { name: 'ext-no-wl', type: 'ci-build' });
            const run     = await startRun(db, { workloadId: wl.workload_id });
            // Orchestration layer tells us this is attempt #7 (e.g. after 6 earlier attempts
            // tracked outside Transparency)
            const attempt = await startAttempt(db, {
                runId:      run.run_id,
                workloadId: wl.workload_id,
                attemptId:  'ext-att-no-007',
                attemptNo:  7,
            });
            assert.equal(attempt.attempt_no, 7);

            const fetched = await getAttempt(db, attempt.attempt_id);
            assert.equal(fetched.attempt_no, 7);
        });

        // ── 8e. Local IDs still work unchanged ────────────────────────────────
        it('locally generated workload_id is a non-empty string', async () => {
            const wl = await createWorkload(db, { name: 'local-wl', type: 'cli' });
            assert.ok(wl.workload_id.length > 0);
        });

        it('local workload_id → identity_source is "local"', async () => {
            const wl = await createWorkload(db, { name: 'local-src-wl', type: 'cli' });
            assert.equal(wl.identity_source, 'local');

            const fetched = await getWorkload(db, wl.workload_id);
            assert.equal(fetched.identity_source, 'local');
        });

        it('local run_id → identity_source is "local"', async () => {
            const wl  = await createWorkload(db, { name: 'local-run-wl', type: 'cli' });
            const run = await startRun(db, { workloadId: wl.workload_id });
            assert.equal(run.identity_source, 'local');

            const fetched = await getRun(db, run.run_id);
            assert.equal(fetched.identity_source, 'local');
        });

        it('local attempt_id → identity_source is "local"', async () => {
            const wl      = await createWorkload(db, { name: 'local-att-wl', type: 'cli' });
            const run     = await startRun(db, { workloadId: wl.workload_id });
            const attempt = await startAttempt(db, { runId: run.run_id, workloadId: wl.workload_id });
            assert.equal(attempt.identity_source, 'local');

            const fetched = await getAttempt(db, attempt.attempt_id);
            assert.equal(fetched.identity_source, 'local');
        });

        // ── 8f. External IDs are stable across retries ────────────────────────
        it('external workload_id is stable across multiple runs', async () => {
            const extWlId = 'ext-wl-stable-retry-scenario';
            const wl      = await createWorkload(db, { name: 'stable-ext', type: 'ci-build', workloadId: extWlId });

            const run1 = await startRun(db, { workloadId: extWlId, runId: 'ext-run-retry-1' });
            const run2 = await startRun(db, { workloadId: extWlId, runId: 'ext-run-retry-2' });

            assert.equal(run1.workload_id, extWlId);
            assert.equal(run2.workload_id, extWlId);
            assert.equal(wl.workload_id,   extWlId);

            // Retrieve from DB to confirm persistence
            const fetched1 = await getRun(db, 'ext-run-retry-1');
            const fetched2 = await getRun(db, 'ext-run-retry-2');
            assert.equal(fetched1.workload_id, extWlId);
            assert.equal(fetched2.workload_id, extWlId);
        });

        // ── 8g. Retry creates a distinct attempt preserving workload identity ──
        it('a retry creates a distinct attempt_id while preserving workload_id', async () => {
            const extWlId = 'ext-wl-retry-distinct-att';
            await createWorkload(db, { name: 'retry-wl', type: 'test-suite', workloadId: extWlId });
            const run = await startRun(db, { workloadId: extWlId });

            // First attempt — external ID, fails
            const a1 = await startAttempt(db, {
                runId:      run.run_id,
                workloadId: extWlId,
                attemptId:  'ext-att-retry-001',
            });
            await completeAttempt(db, { attemptId: a1.attempt_id, status: 'failed', reason: 'infrastructure error' });

            // Second attempt — new external ID, succeeds
            const a2 = await startAttempt(db, {
                runId:      run.run_id,
                workloadId: extWlId,
                attemptId:  'ext-att-retry-002',
            });
            await completeAttempt(db, { attemptId: a2.attempt_id, status: 'completed' });

            // Attempt IDs are distinct
            assert.notEqual(a1.attempt_id, a2.attempt_id);

            // Both reference the same workload
            assert.equal(a1.workload_id, extWlId);
            assert.equal(a2.workload_id, extWlId);

            // Sequence numbers auto-derived correctly
            assert.equal(a1.attempt_no, 1);
            assert.equal(a2.attempt_no, 2);
        });

        // ── 8h. Mixed: external workload + local run + external attempt ────────
        it('identity_source is tracked independently per record type', async () => {
            const extWlId = 'ext-wl-mixed-identity';
            const wl      = await createWorkload(db, { name: 'mixed', type: 'ci-build', workloadId: extWlId });
            const run     = await startRun(db, { workloadId: extWlId });          // local run
            const attempt = await startAttempt(db, {                               // external attempt
                runId:      run.run_id,
                workloadId: extWlId,
                attemptId:  'ext-att-mixed-001',
            });

            assert.equal(wl.identity_source,      'external');
            assert.equal(run.identity_source,     'local');
            assert.equal(attempt.identity_source, 'external');
        });
    });

});
