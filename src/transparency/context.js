/**
 * context.js — Transparency Context Timeline service.
 *
 * Records the time-bounded execution context in which a workload run/attempt
 * executes.  This data is later used to correlate the attempt with SigSense
 * telemetry during attribution.
 *
 * For the MVP only 'process' contexts are supported.  The schema is designed
 * to accommodate future context types (VM, container, Kubernetes pod, etc.)
 * without structural changes.
 *
 * Context event model
 * ───────────────────
 * context_id        — stable UUID for this event
 * workload_id       — parent workload (must exist in workloads table)
 * run_id            — parent run (must exist in runs table)
 * attempt_id        — parent attempt (must exist in attempts table)
 * context_type      — 'process' (only supported type for MVP)
 * external_id       — OS-level identifier, e.g. PID as string
 * resource_id       — host/resource identifier when available (nullable)
 * started_at        — UTC ISO-8601 timestamp when the context was established
 * ended_at          — UTC ISO-8601 timestamp when the context ended (nullable)
 * source            — how the context was established, e.g. 'transparency-launch'
 * parent_context_id — optional parent context for process-tree relationships
 *
 * Identity validation
 * ───────────────────
 * startContext() verifies that the referenced workload, run, and attempt all
 * exist and that their relationships are consistent before inserting a record.
 * Missing identities raise an error — they are never silently created.
 */

import { randomUUID } from 'node:crypto';
import { dbRun, dbGet, dbAll } from './db.js';

// ── Internal helpers ─────────────────────────────────────────────────────────

/** @returns {string} Current UTC timestamp as ISO-8601 string */
function now() {
    return new Date().toISOString();
}

/**
 * Validate that a workload, run, and attempt all exist and are internally
 * consistent (run belongs to workload; attempt belongs to run and workload).
 *
 * @param {sqlite3.Database} db
 * @param {string} workloadId
 * @param {string} runId
 * @param {string} attemptId
 * @throws {Error} if any identity reference is missing or inconsistent
 */
async function validateIdentity(db, workloadId, runId, attemptId) {
    const workload = await dbGet(db, `SELECT workload_id FROM workloads WHERE workload_id = ?`, [workloadId]);
    if (!workload) {
        throw new Error(`[CONTEXT] Unknown workload_id: ${workloadId}`);
    }

    const run = await dbGet(
        db,
        `SELECT run_id, workload_id FROM runs WHERE run_id = ?`,
        [runId]
    );
    if (!run) {
        throw new Error(`[CONTEXT] Unknown run_id: ${runId}`);
    }
    if (run.workload_id !== workloadId) {
        throw new Error(
            `[CONTEXT] run_id ${runId} belongs to workload ${run.workload_id}, not ${workloadId}`
        );
    }

    const attempt = await dbGet(
        db,
        `SELECT attempt_id, run_id, workload_id FROM attempts WHERE attempt_id = ?`,
        [attemptId]
    );
    if (!attempt) {
        throw new Error(`[CONTEXT] Unknown attempt_id: ${attemptId}`);
    }
    if (attempt.run_id !== runId) {
        throw new Error(
            `[CONTEXT] attempt_id ${attemptId} belongs to run ${attempt.run_id}, not ${runId}`
        );
    }
    if (attempt.workload_id !== workloadId) {
        throw new Error(
            `[CONTEXT] attempt_id ${attemptId} belongs to workload ${attempt.workload_id}, not ${workloadId}`
        );
    }
}

// ── Context lifecycle ────────────────────────────────────────────────────────

/**
 * Record the start of an execution context for an active attempt.
 *
 * Validates that the referenced workload/run/attempt exist and are consistent
 * before inserting.  Throws if any identity reference is unknown or mismatched.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string}  opts.workloadId        Must reference an existing workload.
 * @param {string}  opts.runId             Must reference an existing run owned by workloadId.
 * @param {string}  opts.attemptId         Must reference an existing attempt owned by runId.
 * @param {string}  opts.externalId        OS-level identifier (e.g. PID as a string).
 * @param {string}  opts.source            How the context was established ('transparency-launch', etc.).
 * @param {string}  [opts.resourceId]      Optional host/resource identifier.
 * @param {string}  [opts.contextType]     Defaults to 'process'.
 * @param {string}  [opts.parentContextId] Optional parent context_id for process-tree links.
 * @param {string}  [opts.contextId]       Optional externally supplied context_id; generated if absent.
 * @returns {Promise<object>} The inserted context_event record.
 */
export async function startContext(db, {
    workloadId,
    runId,
    attemptId,
    externalId,
    source,
    resourceId       = null,
    contextType      = 'process',
    parentContextId  = null,
    contextId        = null,
}) {
    await validateIdentity(db, workloadId, runId, attemptId);

    const context_id = contextId ?? randomUUID();
    const started_at = now();

    await dbRun(
        db,
        `INSERT INTO context_events
             (context_id, workload_id, run_id, attempt_id,
              context_type, external_id, resource_id,
              started_at, ended_at, source, parent_context_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [context_id, workloadId, runId, attemptId,
         contextType, externalId, resourceId,
         started_at, source, parentContextId]
    );

    return {
        context_id,
        workload_id:       workloadId,
        run_id:            runId,
        attempt_id:        attemptId,
        context_type:      contextType,
        external_id:       externalId,
        resource_id:       resourceId,
        started_at,
        ended_at:          null,
        source,
        parent_context_id: parentContextId,
    };
}

/**
 * Record the end of an execution context.
 *
 * The context event row is updated in place (ended_at is set); it is never
 * deleted.  Time integrity is enforced: ended_at must not precede started_at.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.contextId
 * @param {string} [opts.endedAt] Override end timestamp (defaults to now()).
 * @returns {Promise<object>} The updated context_event record.
 * @throws {Error} if the context does not exist or ended_at < started_at.
 */
export async function endContext(db, { contextId, endedAt = null }) {
    const existing = await dbGet(
        db,
        `SELECT * FROM context_events WHERE context_id = ?`,
        [contextId]
    );
    if (!existing) {
        throw new Error(`[CONTEXT] Unknown context_id: ${contextId}`);
    }

    const ended_at = endedAt ?? now();

    if (new Date(ended_at) < new Date(existing.started_at)) {
        throw new Error(
            `[CONTEXT] ended_at (${ended_at}) must not precede started_at (${existing.started_at})`
        );
    }

    await dbRun(
        db,
        `UPDATE context_events SET ended_at = ? WHERE context_id = ?`,
        [ended_at, contextId]
    );

    return dbGet(db, `SELECT * FROM context_events WHERE context_id = ?`, [contextId]);
}

/**
 * Retrieve a single context event by its ID.
 *
 * @param {sqlite3.Database} db
 * @param {string} contextId
 * @returns {Promise<object|null>}
 */
export async function getContext(db, contextId) {
    return dbGet(db, `SELECT * FROM context_events WHERE context_id = ?`, [contextId]);
}

// ── Query functions ──────────────────────────────────────────────────────────

/**
 * Retrieve all context events for a specific attempt, ordered chronologically.
 *
 * @param {sqlite3.Database} db
 * @param {string} attemptId
 * @returns {Promise<object[]>}
 */
export async function getAttemptContexts(db, attemptId) {
    return dbAll(
        db,
        `SELECT * FROM context_events
         WHERE  attempt_id = ?
         ORDER BY started_at ASC`,
        [attemptId]
    );
}

/**
 * Retrieve the full context timeline for a workload: all context events
 * across all runs and attempts, ordered chronologically.
 *
 * @param {sqlite3.Database} db
 * @param {string} workloadId
 * @returns {Promise<object[]>}
 */
export async function getWorkloadContextTimeline(db, workloadId) {
    return dbAll(
        db,
        `SELECT * FROM context_events
         WHERE  workload_id = ?
         ORDER BY started_at ASC`,
        [workloadId]
    );
}

/**
 * Retrieve context events that overlap a telemetry time window.
 *
 * A context event overlaps [windowStart, windowEnd] when:
 *   started_at <= windowEnd
 *   AND (ended_at IS NULL OR ended_at >= windowStart)
 *
 * This is the standard interval-overlap test.  Contexts with no ended_at
 * (still running) are included if they started before the window closes.
 *
 * All filter parameters are optional and combinable.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string}  opts.windowStart  UTC ISO-8601 start of the window (inclusive).
 * @param {string}  opts.windowEnd    UTC ISO-8601 end of the window (inclusive).
 * @param {string}  [opts.attemptId]  Filter by attempt.
 * @param {string}  [opts.workloadId] Filter by workload.
 * @param {string}  [opts.resourceId] Filter by resource/host.
 * @returns {Promise<object[]>} Context events overlapping the window, ordered by started_at.
 */
export async function getContextsInWindow(db, { windowStart, windowEnd, attemptId, workloadId, resourceId }) {
    const conditions = [
        `started_at <= ?`,
        `(ended_at IS NULL OR ended_at >= ?)`,
    ];
    const params = [windowEnd, windowStart];

    if (attemptId)  { conditions.push(`attempt_id  = ?`); params.push(attemptId);  }
    if (workloadId) { conditions.push(`workload_id = ?`); params.push(workloadId); }
    if (resourceId) { conditions.push(`resource_id = ?`); params.push(resourceId); }

    const sql = `
        SELECT * FROM context_events
        WHERE  ${conditions.join(' AND ')}
        ORDER BY started_at ASC
    `;

    return dbAll(db, sql, params);
}
