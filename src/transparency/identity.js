/**
 * identity.js — Transparency Identity Core service.
 *
 * Owns workload identity, run identity, execution-attempt identity, and
 * lifecycle context.  SigSense remains responsible for all physical/resource
 * measurement; this module never touches the SigSense database.
 *
 * All timestamps are ISO-8601 UTC strings (e.g. "2025-09-26T08:00:00.000Z").
 *
 * Identity source
 * ───────────────
 * Each record carries an identity_source field:
 *   'local'    — ID was generated locally by Transparency (UUID fallback)
 *   'external' — ID was supplied by an authoritative orchestration layer,
 *                CI system, scheduler, or calling process
 *
 * External IDs are never replaced.  If a caller supplies an ID, it is
 * written exactly as supplied and identity_source is set to 'external'.
 */

import { randomUUID } from 'node:crypto';
import { dbRun, dbGet, dbAll } from './db.js';

// ── Internal helpers ─────────────────────────────────────────────────────────

/** @returns {string} Current UTC timestamp as ISO-8601 string */
function now() {
    return new Date().toISOString();
}

// ── Workload ─────────────────────────────────────────────────────────────────

/**
 * Create a new workload with a stable, permanent workload_id.
 *
 * A workload represents a repeatable unit of work (e.g. a CI job definition,
 * a named pipeline stage, a CLI command type).  The same workload_id should
 * be reused across all runs and retries of that logical work item.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.name               Human-readable workload name.
 * @param {string} opts.type               Workload type (e.g. 'ci-build', 'cli', 'test-suite').
 * @param {string} [opts.workloadId]       Optional externally supplied workload_id.
 *   When provided, preserved exactly and identity_source is set to 'external'.
 *   When absent, a UUID is generated locally and identity_source is 'local'.
 * @param {string} [opts.parentWorkloadId] Optional parent workload_id for hierarchical composition.
 * @returns {Promise<{workload_id: string, name: string, type: string,
 *                    created_at: string, parent_workload_id: string|null,
 *                    status: string, identity_source: string}>}
 */
export async function createWorkload(db, { name, type, workloadId = null, parentWorkloadId = null }) {
    const identity_source = workloadId ? 'external' : 'local';
    const workload_id     = workloadId ?? randomUUID();
    const created_at      = now();

    await dbRun(
        db,
        `INSERT INTO workloads (workload_id, name, type, created_at, parent_workload_id, status, identity_source)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        [workload_id, name, type, created_at, parentWorkloadId, identity_source]
    );

    return { workload_id, name, type, created_at, parent_workload_id: parentWorkloadId, status: 'active', identity_source };
}

/**
 * Retrieve a workload by its ID.
 *
 * @param {sqlite3.Database} db
 * @param {string} workloadId
 * @returns {Promise<object|null>}
 */
export async function getWorkload(db, workloadId) {
    return dbGet(db, `SELECT * FROM workloads WHERE workload_id = ?`, [workloadId]);
}

// ── Run ──────────────────────────────────────────────────────────────────────

/**
 * Start a new run for a workload.
 *
 * A run represents one execution of a workload.  A single workload may have
 * many runs over its lifetime.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.workloadId
 * @param {string} [opts.runId]  Optional externally supplied run_id.
 *   When provided, preserved exactly and identity_source is set to 'external'.
 *   When absent, a UUID is generated locally and identity_source is 'local'.
 * @returns {Promise<{run_id: string, workload_id: string,
 *                    started_at: string, ended_at: null, status: string,
 *                    identity_source: string}>}
 */
export async function startRun(db, { workloadId, runId = null }) {
    const identity_source = runId ? 'external' : 'local';
    const run_id          = runId ?? randomUUID();
    const started_at      = now();

    await dbRun(
        db,
        `INSERT INTO runs (run_id, workload_id, started_at, ended_at, status, identity_source)
         VALUES (?, ?, ?, NULL, 'running', ?)`,
        [run_id, workloadId, started_at, identity_source]
    );

    return { run_id, workload_id: workloadId, started_at, ended_at: null, status: 'running', identity_source };
}

/**
 * Complete a run, recording its final status.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.runId
 * @param {'completed'|'failed'} opts.status
 * @returns {Promise<object>} Updated run record.
 */
export async function completeRun(db, { runId, status }) {
    const ended_at = now();

    await dbRun(
        db,
        `UPDATE runs SET ended_at = ?, status = ? WHERE run_id = ?`,
        [ended_at, status, runId]
    );

    return dbGet(db, `SELECT * FROM runs WHERE run_id = ?`, [runId]);
}

/**
 * Retrieve a run by its ID.
 *
 * @param {sqlite3.Database} db
 * @param {string} runId
 * @returns {Promise<object|null>}
 */
export async function getRun(db, runId) {
    return dbGet(db, `SELECT * FROM runs WHERE run_id = ?`, [runId]);
}

// ── Attempt ──────────────────────────────────────────────────────────────────

/**
 * Start a new attempt within a run.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.workloadId
 * @param {string}  [opts.attemptId] Optional externally supplied attempt_id.
 *   When provided, preserved exactly and identity_source is set to 'external'.
 *   When absent, a UUID is generated locally and identity_source is 'local'.
 * @param {number}  [opts.attemptNo] Optional externally supplied attempt sequence number.
 *   When provided by an authoritative caller, preserved exactly.
 *   When absent, the next 1-based integer in the run's sequence is derived.
 * @returns {Promise<{attempt_id: string, run_id: string, workload_id: string,
 *                    attempt_no: number, started_at: string,
 *                    ended_at: null, status: string, reason: null,
 *                    identity_source: string}>}
 */
export async function startAttempt(db, { runId, workloadId, attemptId = null, attemptNo = null }) {
    const identity_source = attemptId ? 'external' : 'local';
    const attempt_id      = attemptId ?? randomUUID();

    // Derive attempt_no: use the externally supplied value when present;
    // otherwise determine the next integer in the run's sequence (1-based).
    let attempt_no;
    if (attemptNo != null) {
        attempt_no = attemptNo;
    } else {
        const row = await dbGet(
            db,
            `SELECT COALESCE(MAX(attempt_no), 0) AS max_no FROM attempts WHERE run_id = ?`,
            [runId]
        );
        attempt_no = (row?.max_no ?? 0) + 1;
    }

    const started_at = now();

    await dbRun(
        db,
        `INSERT INTO attempts (attempt_id, run_id, workload_id, attempt_no, started_at, ended_at, status, reason, identity_source)
         VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, ?)`,
        [attempt_id, runId, workloadId, attempt_no, started_at, identity_source]
    );

    return { attempt_id, run_id: runId, workload_id: workloadId, attempt_no, started_at, ended_at: null, status: 'running', reason: null, identity_source };
}

/**
 * Complete an attempt, recording its final status and optional reason.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.attemptId
 * @param {'completed'|'failed'} opts.status
 * @param {string} [opts.reason] Required when status is 'failed'; optional for 'completed'.
 * @returns {Promise<object>} Updated attempt record.
 */
export async function completeAttempt(db, { attemptId, status, reason = null }) {
    const ended_at = now();

    await dbRun(
        db,
        `UPDATE attempts SET ended_at = ?, status = ?, reason = ? WHERE attempt_id = ?`,
        [ended_at, status, reason, attemptId]
    );

    return dbGet(db, `SELECT * FROM attempts WHERE attempt_id = ?`, [attemptId]);
}

/**
 * Retrieve an attempt by its ID.
 *
 * @param {sqlite3.Database} db
 * @param {string} attemptId
 * @returns {Promise<object|null>}
 */
export async function getAttempt(db, attemptId) {
    return dbGet(db, `SELECT * FROM attempts WHERE attempt_id = ?`, [attemptId]);
}

// ── Timeline queries ─────────────────────────────────────────────────────────

/**
 * Retrieve the full timeline for a workload: all runs and their attempts,
 * ordered chronologically.
 *
 * @param {sqlite3.Database} db
 * @param {string} workloadId
 * @returns {Promise<{workload: object, runs: Array<object & {attempts: object[]}>}>}
 */
export async function getWorkloadTimeline(db, workloadId) {
    const workload = await getWorkload(db, workloadId);
    if (!workload) return null;

    const runs = await dbAll(
        db,
        `SELECT * FROM runs WHERE workload_id = ? ORDER BY started_at ASC`,
        [workloadId]
    );

    for (const run of runs) {
        run.attempts = await dbAll(
            db,
            `SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_no ASC`,
            [run.run_id]
        );
    }

    return { workload, runs };
}
