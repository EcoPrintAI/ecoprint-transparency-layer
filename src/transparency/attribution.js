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
import { summarizeTelemetry } from './metrics.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const ATTRIBUTION_VERSION = 1;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** @returns {string} Current UTC timestamp as ISO-8601 string */
function now() {
    return new Date().toISOString();
}

function componentPowers(row, share = 1) {
    return Object.fromEntries(['cpu', 'gpu', 'ane', 'client_workload', 'ecoprint_overhead'].map(component => {
        const value = row[`${component}_power_watts`];
        return [component, value == null || !Number.isFinite(Number(value)) ? null : Number(value) * share];
    }));
}

function allocationEnvironment(row, share = 1) {
    return Object.fromEntries(['carbon_gCO2e', 'water_liters'].flatMap(metric =>
        ['client_workload', 'ecoprint_overhead'].map(component => {
            const key = `${component}_${metric}`;
            return [key, row[key] == null || !Number.isFinite(Number(row[key])) ? null : Number(row[key]) * share];
        })));
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
           AND attribution_eligible = 1
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

async function findIdentityContext(db, row) {
    const sameResource = context => !context.resource_id || !row.resource_id || context.resource_id === row.resource_id;
    const timestamp = row.attribution_timestamp ?? row.timestamp;
    if (row.context_id) {
        const direct = await dbGet(db,
            `SELECT * FROM context_events WHERE context_id = ? AND attribution_eligible = 1
             AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`, [row.context_id, timestamp, timestamp]);
        if (direct && sameResource(direct)) return { context: direct, method: 'direct-context-identity' };
    }
    if (row.attempt_id || row.run_id || row.workload_id) {
        const direct = await dbGet(db, `SELECT * FROM context_events
            WHERE attribution_eligible = 1
              AND (? IS NULL OR attempt_id = ?)
              AND (? IS NULL OR run_id = ?)
              AND (? IS NULL OR workload_id = ?)
              AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
            ORDER BY context_id LIMIT 1`, [
            row.attempt_id ?? null, row.attempt_id ?? null,
            row.run_id ?? null, row.run_id ?? null,
            row.workload_id ?? null, row.workload_id ?? null,
            timestamp, timestamp,
        ]);
        if (direct && sameResource(direct)) return { context: direct, method: 'authoritative-workload-identity' };
    }
    if (row.process_id != null) {
        let process = await dbGet(db, `SELECT * FROM context_events WHERE process_id = ?
            AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`, [row.process_id, timestamp, timestamp]);
        const seen = new Set();
        let usedLineage = false;
        while (process && !seen.has(process.process_id)) {
            if (process.attribution_eligible === 1) {
                if (sameResource(process)) return { context: process, method: usedLineage ? 'parent-lineage-match' : 'direct-process-identity' };
                return null;
            }
            seen.add(process.process_id);
            process = process.parent_process_id == null ? null
                : await dbGet(db, `SELECT * FROM context_events WHERE process_id = ?
                    AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`, [process.parent_process_id, timestamp, timestamp]);
            usedLineage = true;
        }
    }
    return null;
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
        const durationSeconds = row.interval_seconds ?? row.delta_time ?? 0;

        const identityMatch = await findIdentityContext(db, row);
        const matches = identityMatch ? [identityMatch.context]
            : await findOverlappingContexts(db, row.attribution_timestamp ?? ts, rid);

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
                attributedComponentPowerWatts: componentPowers(row),
                attributedAllocationCarbon: allocationEnvironment(row),
                attributedCarbonGco2e: co2,
                attributedWaterLiters: h2o,
                durationSeconds,
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
                attributedComponentPowerWatts: componentPowers(row),
                attributedAllocationCarbon: allocationEnvironment(row),
                attributedCarbonGco2e: co2,
                attributedWaterLiters: h2o,
                durationSeconds,
                attributionMethod:     identityMatch?.method ?? 'exact-context-match',
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
                    attributedComponentPowerWatts: componentPowers(row, share),
                    attributedAllocationCarbon: allocationEnvironment(row, share),
                    attributedCarbonGco2e: co2 * share,
                    attributedWaterLiters: h2o * share,
                    durationSeconds,
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
    const measured = summarizeTelemetry(telemetry);

    // Attributed and unattributed from the attribution_records table.
    const rows = await dbAll(
        db,
         `SELECT evidence_level,
                attribution_version,
                SUM(attributed_power_watts * duration_seconds) AS watt_seconds,
                SUM(attributed_cpu_power_watts * duration_seconds) AS cpu_watt_seconds,
                SUM(attributed_gpu_power_watts * duration_seconds) AS gpu_watt_seconds,
                SUM(attributed_ane_power_watts * duration_seconds) AS ane_watt_seconds,
                SUM(attributed_client_workload_power_watts * duration_seconds) AS client_watt_seconds,
                SUM(attributed_ecoprint_overhead_power_watts * duration_seconds) AS overhead_watt_seconds,
                SUM(attributed_client_workload_carbon_gco2e) AS client_carbon_gco2e,
                SUM(attributed_ecoprint_overhead_carbon_gco2e) AS overhead_carbon_gco2e,
                SUM(attributed_client_workload_water_liters) AS client_water_liters,
                SUM(attributed_ecoprint_overhead_water_liters) AS overhead_water_liters,
                SUM(attributed_carbon_gco2e)  AS co2,
                SUM(attributed_water_liters)  AS h2o
         FROM   attribution_records
         WHERE  telemetry_timestamp >= ? AND telemetry_timestamp <= ?
           AND  attribution_version = (
                SELECT MAX(attribution_version) FROM attribution_records
                WHERE telemetry_timestamp >= ? AND telemetry_timestamp <= ?
           )
         GROUP  BY evidence_level, attribution_version`,
        [windowStart, windowEnd, windowStart, windowEnd]
    );

    const attributed   = { power_watts: 0, energy_wh: 0, carbon_gco2e: 0, water_liters: 0 };
    const unattributed = { power_watts: 0, energy_wh: 0, carbon_gco2e: 0, water_liters: 0 };

    for (const r of rows) {
        const target = r.evidence_level === 'unattributed' ? unattributed : attributed;
        target.energy_wh += (r.watt_seconds ?? 0) / 3600;
        for (const component of ['cpu', 'gpu', 'ane']) {
            target[`${component}_energy_wh`] = (target[`${component}_energy_wh`] ?? 0) + (r[`${component}_watt_seconds`] ?? 0) / 3600;
        }
        for (const component of ['client_workload', 'ecoprint_overhead']) {
            const source = component === 'client_workload' ? 'client' : 'overhead';
            target[`${component}_energy_wh`] = (target[`${component}_energy_wh`] ?? 0) + (r[`${source}_watt_seconds`] ?? 0) / 3600;
            target[`${component}_carbon_gco2e`] = r[`${source}_carbon_gco2e`] == null
                ? null : (target[`${component}_carbon_gco2e`] ?? 0) + r[`${source}_carbon_gco2e`];
            target[`${component}_water_liters`] = r[`${source}_water_liters`] == null
                ? null : (target[`${component}_water_liters`] ?? 0) + r[`${source}_water_liters`];
        }
        target.carbon_gco2e += r.co2 ?? 0;
        target.water_liters += r.h2o ?? 0;
    }

    for (const target of [attributed, unattributed]) {
        target.power_watts = measured.duration_seconds > 0
            ? target.energy_wh * 3600 / measured.duration_seconds : 0;
        for (const component of ['cpu', 'gpu', 'ane']) {
            const duration = measured[`${component}_duration_seconds`];
            target[`${component}_energy_wh`] = duration == null ? null : target[`${component}_energy_wh`] ?? 0;
            target[`${component}_power_watts`] = duration == null
                ? null : duration > 0 ? target[`${component}_energy_wh`] * 3600 / duration : 0;
        }
        for (const component of ['client_workload', 'ecoprint_overhead']) {
            const duration = measured[`${component}_duration_seconds`];
            target[`${component}_energy_wh`] = duration == null ? null : target[`${component}_energy_wh`] ?? 0;
            target[`${component}_power_watts`] = duration == null ? null : duration > 0 ? target[`${component}_energy_wh`] * 3600 / duration : 0;
            if (measured[`${component}_carbon_gco2e`] == null) {
                target[`${component}_carbon_gco2e`] = null;
                target[`${component}_water_liters`] = null;
            }
        }
    }

    return {
        window:      { start: windowStart, end: windowEnd },
        measured,
        attributed,
        unattributed,
        attribution_version: rows.length ? rows[0].attribution_version : null,
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
    attributedComponentPowerWatts = {},
    attributedAllocationCarbon = {},
    attributedCarbonGco2e,
    attributedWaterLiters,
    durationSeconds = 0,
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
             attributed_power_watts, attributed_cpu_power_watts, attributed_gpu_power_watts,
             attributed_ane_power_watts, attributed_client_workload_power_watts,
             attributed_ecoprint_overhead_power_watts, attributed_client_workload_carbon_gco2e,
             attributed_ecoprint_overhead_carbon_gco2e, attributed_client_workload_water_liters,
             attributed_ecoprint_overhead_water_liters, attributed_carbon_gco2e, attributed_water_liters,
             duration_seconds, attribution_method, evidence_level, attribution_version, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            attribution_id, telemetryTimestamp,
            workloadId, runId, attemptId, contextId, resourceId,
            attributedPowerWatts,
            attributedComponentPowerWatts.cpu ?? null,
            attributedComponentPowerWatts.gpu ?? null,
            attributedComponentPowerWatts.ane ?? null,
            attributedComponentPowerWatts.client_workload ?? null,
            attributedComponentPowerWatts.ecoprint_overhead ?? null,
            attributedAllocationCarbon.client_workload_carbon_gCO2e ?? null,
            attributedAllocationCarbon.ecoprint_overhead_carbon_gCO2e ?? null,
            attributedAllocationCarbon.client_workload_water_liters ?? null,
            attributedAllocationCarbon.ecoprint_overhead_water_liters ?? null,
            attributedCarbonGco2e, attributedWaterLiters,
            durationSeconds,
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
        attributed_cpu_power_watts: attributedComponentPowerWatts.cpu ?? null,
        attributed_gpu_power_watts: attributedComponentPowerWatts.gpu ?? null,
        attributed_ane_power_watts: attributedComponentPowerWatts.ane ?? null,
        attributed_client_workload_power_watts: attributedComponentPowerWatts.client_workload ?? null,
        attributed_ecoprint_overhead_power_watts: attributedComponentPowerWatts.ecoprint_overhead ?? null,
        attributed_client_workload_carbon_gco2e: attributedAllocationCarbon.client_workload_carbon_gCO2e ?? null,
        attributed_ecoprint_overhead_carbon_gco2e: attributedAllocationCarbon.ecoprint_overhead_carbon_gCO2e ?? null,
        attributed_client_workload_water_liters: attributedAllocationCarbon.client_workload_water_liters ?? null,
        attributed_ecoprint_overhead_water_liters: attributedAllocationCarbon.ecoprint_overhead_water_liters ?? null,
        attributed_carbon_gco2e:  attributedCarbonGco2e,
        attributed_water_liters:  attributedWaterLiters,
        duration_seconds:         durationSeconds,
        attribution_method:       attributionMethod,
        evidence_level:           evidenceLevel,
        attribution_version:      version,
        created_at:               createdAt,
    };
}
