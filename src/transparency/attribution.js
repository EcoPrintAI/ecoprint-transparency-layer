/**
 * attribution.js — Transparency Deterministic Attribution Layer.
 *
 * Correlates immutable SigSense telemetry observations with time-bounded
 * workload/process contexts and produces explainable attribution records.
 *
 * Architecture position:
 *   Identity Core → Context Timeline → Deterministic Attribution → Connect/accounting
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Telemetry interface
 * ─────────────────────────────────────────────────────────────────────────────
 * Telemetry is passed in as an array of plain objects.  This layer never
 * opens the SigSense database itself, keeping attribution independent from the
 * telemetry implementation.
 *
 * Each telemetry row must have:
 *   timestamp           (string) UTC ISO-8601
 *   resource_id         (string|null) node_id from SigSense, or null
 *   total_power_watts   (number)
 *   carbon_gCO2e        (number)
 *   water_liters        (number)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic correlation rules  (attribution_method values)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rule 1 — exact-context-match
 *   Condition : exactly one context_event overlaps the telemetry timestamp
 *               AND resource_id matches (when both sides carry one).
 *   Action    : attribute 100 % of the observation to that context.
 *   evidence_level : 'exact'
 *
 * Rule 2 — equal-share-N-contexts
 *   Condition : N > 1 contexts overlap the timestamp on the same resource.
 *   Action    : divide the observation equally by N (1/N each).
 *               This is deterministic: same input set → same split.
 *   evidence_level : 'shared'
 *
 * Rule 3 — no-context-match
 *   Condition : no context overlaps the timestamp (or resource mismatch).
 *   Action    : preserve the observation as an unattributed record.
 *               workload_id / run_id / attempt_id / context_id are NULL.
 *   evidence_level : 'unattributed'
 *
 * Resource-identity matching:
 *   - If the context has a resource_id AND the telemetry row has a resource_id,
 *     they must match for the context to be considered.
 *   - If either side has no resource_id (null), the resource constraint is not
 *     applied for that pair (resource-agnostic matching).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Versioning
 * ─────────────────────────────────────────────────────────────────────────────
 * Every attribution run is tagged with attribution_version.  recomputeAttribution
 * deletes prior records for the window and re-inserts at version + 1, ensuring
 * the full history of recomputations is not lost — only the window being
 * recomputed is replaced.
 *
 * Recomputation is deterministic: given the same telemetry rows and context
 * events, the output is identical regardless of when the function runs.
 */

import { randomUUID } from 'node:crypto';
import { dbRun, dbGet, dbAll } from './db.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const ATTRIBUTION_VERSION = 1;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** @returns {string} Current UTC timestamp as ISO-8601 string */
function now() {
    return new Date().toISOString();
}

/**
 * Find all context_events whose execution interval overlaps a single telemetry
 * timestamp, applying resource-identity matching where available.
 *
 * Overlap condition:
 *   context.started_at <= ts <= (context.ended_at ?? ∞)
 *
 * Resource matching:
 *   If BOTH context.resource_id and telemetry.resource_id are non-null,
 *   they must be equal.  If either is null, the constraint is skipped.
 *
 * @param {sqlite3.Database} db
 * @param {string}      ts           Telemetry timestamp (ISO-8601 string).
 * @param {string|null} resourceId   Telemetry resource_id (may be null).
 * @returns {Promise<object[]>} Matching context_event rows.
 */
async function findOverlappingContexts(db, ts, resourceId) {
    // Pull all contexts whose time window contains ts.
    const candidates = await dbAll(
        db,
        `SELECT * FROM context_events
         WHERE started_at <= ?
           AND (ended_at IS NULL OR ended_at >= ?)
         ORDER BY context_id ASC`,   // stable sort for determinism
        [ts, ts]
    );

    // Apply resource-identity filter.
    return candidates.filter(ctx => {
        if (ctx.resource_id && resourceId) {
            return ctx.resource_id === resourceId;
        }
        // One or both sides lack resource identity — resource constraint skipped.
        return true;
    });
}

/**
 * Determine the next attribution_version for a given telemetry window by
 * inspecting existing records.  Returns 1 if none exist yet.
 *
 * @param {sqlite3.Database} db
 * @param {string} windowStart
 * @param {string} windowEnd
 * @returns {Promise<number>}
 */
async function nextVersion(db, windowStart, windowEnd) {
    const row = await dbGet(
        db,
        `SELECT MAX(attribution_version) AS max_v FROM attribution_records
         WHERE telemetry_timestamp >= ? AND telemetry_timestamp <= ?`,
        [windowStart, windowEnd]
    );
    return (row?.max_v ?? 0) + 1;
}

// ── Core attribution ──────────────────────────────────────────────────────────

/**
 * Run attribution over a set of telemetry observations within a time window.
 *
 * For each telemetry row the function applies the three deterministic
 * correlation rules (exact-match, equal-share, unattributed) and inserts
 * one or more attribution_records rows.
 *
 * @param {sqlite3.Database} db      Transparency database (read-write).
 * @param {object} opts
 * @param {object[]} opts.telemetry  Array of normalized telemetry rows:
 *   { timestamp, resource_id, total_power_watts, carbon_gCO2e, water_liters }
 * @param {string}  opts.windowStart UTC ISO-8601 — start of the telemetry window (inclusive).
 * @param {string}  opts.windowEnd   UTC ISO-8601 — end of the telemetry window (inclusive).
 * @param {number}  [opts.version]   Override attribution_version; defaults to auto-increment.
 * @returns {Promise<object[]>}      All inserted attribution_record rows.
 */
export async function attributeTelemetryWindow(db, { telemetry, windowStart, windowEnd, version }) {
    const ver     = version ?? await nextVersion(db, windowStart, windowEnd);
    const created = now();
    const results = [];

    for (const row of telemetry) {
        const ts  = row.timestamp;
        const rid = row.resource_id ?? null;
        const pw  = row.total_power_watts  ?? 0;
        const co2 = row.carbon_gCO2e       ?? 0;
        const h2o = row.water_liters       ?? 0;

        const matches = await findOverlappingContexts(db, ts, rid);

        if (matches.length === 0) {
            // Rule 3 — no matching context
            const rec = await _insertAttribution(db, {
                telemetryTimestamp:    ts,
                workloadId:            null,
                runId:                 null,
                attemptId:             null,
                contextId:             null,
                resourceId:            rid,
                attributedPowerWatts:  pw,
                attributedCarbonGco2e: co2,
                attributedWaterLiters: h2o,
                attributionMethod:     'no-context-match',
                evidenceLevel:         'unattributed',
                version:               ver,
                createdAt:             created,
            });
            results.push(rec);

        } else if (matches.length === 1) {
            // Rule 1 — exact match
            const ctx = matches[0];
            const rec = await _insertAttribution(db, {
                telemetryTimestamp:    ts,
                workloadId:            ctx.workload_id,
                runId:                 ctx.run_id,
                attemptId:             ctx.attempt_id,
                contextId:             ctx.context_id,
                resourceId:            rid ?? ctx.resource_id,
                attributedPowerWatts:  pw,
                attributedCarbonGco2e: co2,
                attributedWaterLiters: h2o,
                attributionMethod:     'exact-context-match',
                evidenceLevel:         'exact',
                version:               ver,
                createdAt:             created,
            });
            results.push(rec);

        } else {
            // Rule 2 — equal-share across N overlapping contexts
            const n     = matches.length;
            const share = 1 / n;
            for (const ctx of matches) {
                const rec = await _insertAttribution(db, {
                    telemetryTimestamp:    ts,
                    workloadId:            ctx.workload_id,
                    runId:                 ctx.run_id,
                    attemptId:             ctx.attempt_id,
                    contextId:             ctx.context_id,
                    resourceId:            rid ?? ctx.resource_id,
                    attributedPowerWatts:  pw  * share,
                    attributedCarbonGco2e: co2 * share,
                    attributedWaterLiters: h2o * share,
                    attributionMethod:     `equal-share-${n}-contexts`,
                    evidenceLevel:         'shared',
                    version:               ver,
                    createdAt:             created,
                });
                results.push(rec);
            }
        }
    }

    return results;
}

/**
 * Recompute attribution for a telemetry window.
 *
 * Deletes all existing attribution records for the window and re-runs
 * attribution at the next version number.  The result is identical given the
 * same telemetry and context state — recomputation is deterministic.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {object[]} opts.telemetry  Same normalized telemetry rows as attributeTelemetryWindow.
 * @param {string}   opts.windowStart
 * @param {string}   opts.windowEnd
 * @returns {Promise<object[]>}  New attribution_record rows.
 */
export async function recomputeAttribution(db, { telemetry, windowStart, windowEnd }) {
    const ver = await nextVersion(db, windowStart, windowEnd);

    // Delete prior records for this window only.
    await dbRun(
        db,
        `DELETE FROM attribution_records
         WHERE telemetry_timestamp >= ? AND telemetry_timestamp <= ?`,
        [windowStart, windowEnd]
    );

    return attributeTelemetryWindow(db, { telemetry, windowStart, windowEnd, version: ver });
}

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Retrieve a single attribution record by ID.
 *
 * @param {sqlite3.Database} db
 * @param {string} attributionId
 * @returns {Promise<object|null>}
 */
export async function getAttribution(db, attributionId) {
    return dbGet(
        db,
        `SELECT * FROM attribution_records WHERE attribution_id = ?`,
        [attributionId]
    );
}

/**
 * Retrieve all attribution records for a specific attempt, ordered by
 * telemetry_timestamp ascending.
 *
 * @param {sqlite3.Database} db
 * @param {string} attemptId
 * @returns {Promise<object[]>}
 */
export async function getAttemptAttribution(db, attemptId) {
    return dbAll(
        db,
        `SELECT * FROM attribution_records
         WHERE  attempt_id = ?
         ORDER BY telemetry_timestamp ASC`,
        [attemptId]
    );
}

/**
 * Retrieve all attribution records for a workload (across all runs/attempts),
 * ordered by telemetry_timestamp ascending.
 *
 * @param {sqlite3.Database} db
 * @param {string} workloadId
 * @returns {Promise<object[]>}
 */
export async function getWorkloadAttribution(db, workloadId) {
    return dbAll(
        db,
        `SELECT * FROM attribution_records
         WHERE  workload_id = ?
         ORDER BY telemetry_timestamp ASC`,
        [workloadId]
    );
}

/**
 * Retrieve all unattributed records within a time window, ordered
 * chronologically.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string} opts.windowStart
 * @param {string} opts.windowEnd
 * @returns {Promise<object[]>}
 */
export async function getUnattributedTelemetry(db, { windowStart, windowEnd }) {
    return dbAll(
        db,
        `SELECT * FROM attribution_records
         WHERE  evidence_level   = 'unattributed'
           AND  telemetry_timestamp >= ?
           AND  telemetry_timestamp <= ?
         ORDER BY telemetry_timestamp ASC`,
        [windowStart, windowEnd]
    );
}

/**
 * Reconciliation report for a telemetry window.
 *
 * Returns the measured totals, attributed totals, and unattributed totals so
 * that callers can verify:
 *   measured = attributed + unattributed
 *
 * No telemetry observation is silently discarded — the equation must balance.
 *
 * @param {sqlite3.Database} db
 * @param {object} opts
 * @param {string}   opts.windowStart
 * @param {string}   opts.windowEnd
 * @param {object[]} opts.telemetry  Original normalized telemetry rows (used for measured totals).
 * @returns {Promise<{
 *   window: { start: string, end: string },
 *   measured:      { power_watts: number, carbon_gco2e: number, water_liters: number },
 *   attributed:    { power_watts: number, carbon_gco2e: number, water_liters: number },
 *   unattributed:  { power_watts: number, carbon_gco2e: number, water_liters: number },
 * }>}
 */
export async function reconcileAttribution(db, { windowStart, windowEnd, telemetry }) {
    // Measured totals come from the raw telemetry input — one row per observation.
    // For multi-context splits, each observation is counted once in measured.
    const measured = telemetry.reduce(
        (acc, row) => {
            acc.power_watts  += row.total_power_watts ?? 0;
            acc.carbon_gco2e += row.carbon_gCO2e      ?? 0;
            acc.water_liters += row.water_liters       ?? 0;
            return acc;
        },
        { power_watts: 0, carbon_gco2e: 0, water_liters: 0 }
    );

    // Attributed and unattributed from the attribution_records table.
    const rows = await dbAll(
        db,
        `SELECT evidence_level,
                SUM(attributed_power_watts)   AS pw,
                SUM(attributed_carbon_gco2e)  AS co2,
                SUM(attributed_water_liters)  AS h2o
         FROM   attribution_records
         WHERE  telemetry_timestamp >= ? AND telemetry_timestamp <= ?
         GROUP  BY evidence_level`,
        [windowStart, windowEnd]
    );

    const attributed   = { power_watts: 0, carbon_gco2e: 0, water_liters: 0 };
    const unattributed = { power_watts: 0, carbon_gco2e: 0, water_liters: 0 };

    for (const r of rows) {
        if (r.evidence_level === 'unattributed') {
            unattributed.power_watts  += r.pw  ?? 0;
            unattributed.carbon_gco2e += r.co2 ?? 0;
            unattributed.water_liters += r.h2o ?? 0;
        } else {
            attributed.power_watts  += r.pw  ?? 0;
            attributed.carbon_gco2e += r.co2 ?? 0;
            attributed.water_liters += r.h2o ?? 0;
        }
    }

    return {
        window:      { start: windowStart, end: windowEnd },
        measured,
        attributed,
        unattributed,
    };
}

// ── Internal insert helper ────────────────────────────────────────────────────

async function _insertAttribution(db, {
    telemetryTimestamp,
    workloadId,
    runId,
    attemptId,
    contextId,
    resourceId,
    attributedPowerWatts,
    attributedCarbonGco2e,
    attributedWaterLiters,
    attributionMethod,
    evidenceLevel,
    version,
    createdAt,
}) {
    const attribution_id = randomUUID();

    await dbRun(
        db,
        `INSERT INTO attribution_records (
             attribution_id, telemetry_timestamp,
             workload_id, run_id, attempt_id, context_id, resource_id,
             attributed_power_watts, attributed_carbon_gco2e, attributed_water_liters,
             attribution_method, evidence_level, attribution_version, created_at
         ) VALUES (?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?)`,
        [
            attribution_id, telemetryTimestamp,
            workloadId, runId, attemptId, contextId, resourceId,
            attributedPowerWatts, attributedCarbonGco2e, attributedWaterLiters,
            attributionMethod, evidenceLevel, version, createdAt,
        ]
    );

    return {
        attribution_id,
        telemetry_timestamp:      telemetryTimestamp,
        workload_id:              workloadId,
        run_id:                   runId,
        attempt_id:               attemptId,
        context_id:               contextId,
        resource_id:              resourceId,
        attributed_power_watts:   attributedPowerWatts,
        attributed_carbon_gco2e:  attributedCarbonGco2e,
        attributed_water_liters:  attributedWaterLiters,
        attribution_method:       attributionMethod,
        evidence_level:           evidenceLevel,
        attribution_version:      version,
        created_at:               createdAt,
    };
}
