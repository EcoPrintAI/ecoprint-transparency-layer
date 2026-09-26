/**
 * cli.js — EcoPrint Transparency CLI lifecycle orchestrator.
 *
 * Manages the full execution lifecycle for a user-supplied command:
 *   1. Create or locate workload identity
 *   2. Start a run and attempt
 *   3. Spawn the child process, record PID as a process context
 *   4. Wait for exit, close the context, complete the attempt/run
 *   5. Query SigSense telemetry for the execution window
 *   6. Run deterministic attribution
 *   7. Return a structured result for the report formatter
 *
 * This module is pure logic — it does not write to stdout.
 * The caller (bin/ecoprint.js) handles terminal output.
 *
 * Injection points for testing:
 *   opts.spawnFn    — override child_process.spawn (default: Node built-in)
 *   opts.telemetryFn — override telemetry read (default: real SigSense DB)
 */

import { spawn }    from 'node:child_process';
import os           from 'node:os';

import {
    openDatabase,
    initSchema,
    createWorkload,
    startRun,
    startAttempt,
    completeAttempt,
    completeRun,
    attributeTelemetryWindow,
    reconcileAttribution,
} from './index.js';

import { dbRun, dbGet }                       from './db.js';
import { findBaseline, compareRunMetrics, saveRunMetrics } from './baseline.js';
import { deriveInsights } from './insights.js';
import { explainWithProvider } from './ai.js';
import { prepareTelemetryRows } from './metrics.js';
import { sendIpcCommand }                      from './ipc.js';
import { openSigSenseDb, closeSigSenseDb,
         readTelemetryWindow,
         DEFAULT_SIGSENSE_DB }                from './telemetry.js';

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Path used for the persistent Transparency identity/attribution database. */
import path         from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TRANSPARENCY_DB = process.env.ECOPRINT_TRANSPARENCY_DB ??
    path.resolve(__dirname, 'transparency.db');

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a user-supplied command under Transparency measurement.
 *
 * @param {object} opts
 * @param {string}   opts.workloadName    Human-readable workload name (from --name).
 * @param {string}   opts.workloadType    Workload type string (default 'cli-run').
 * @param {string[]} opts.command         argv for the child process ([cmd, ...args]).
 * @param {string}   [opts.transparencyDb] Override Transparency DB path (default: transparency.db).
 * @param {string}   [opts.sigsenseDb]    Override SigSense DB path.
 * @param {Function} [opts.spawnFn]       Override spawn (for testing).
 * @param {Function} [opts.telemetryFn]   Override telemetry read fn (for testing).
 *                                        Signature: (windowStart, windowEnd, resourceId) => Promise<row[]>
 * @returns {Promise<RunResult>}
 */
export async function runUnderTransparency(opts) {
    const {
        workloadName,
        workloadType  = 'cli-run',
        command,
        transparencyDb = DEFAULT_TRANSPARENCY_DB,
        sigsenseDb     = DEFAULT_SIGSENSE_DB,
        spawnFn        = spawn,
        telemetryFn    = null,
        ipcFn          = sendIpcCommand,
        aiProvider     = null,
    } = opts;

    // ── 1. Open Transparency database ─────────────────────────────────────────
    const db = await openDatabase(transparencyDb);
    await initSchema(db);

    // ── 2. Identity ───────────────────────────────────────────────────────────
    let workload = await dbGet(db,
        `SELECT * FROM workloads WHERE name = ? AND type = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
        [workloadName, workloadType]);
    if (!workload) workload = await createWorkload(db, { name: workloadName, type: workloadType });
    const run      = await startRun(db, { workloadId: workload.workload_id });
    const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });

    const resourceId = os.hostname();

    // ── 3. Spawn child process ────────────────────────────────────────────────
    const [cmd, ...args] = command;
    let   childPid  = null;
    let   exitCode  = null;
    let   ipcStarted = false;
    let   ipcError = null;
    try {
        await ipcFn(`BEGIN ${run.run_id}`);
        ipcStarted = true;
    } catch (err) {
        ipcError = err.message;
    }

    const startedAt = new Date().toISOString();

    const childResult = await new Promise((resolve) => {
        let child;
        try {
            child = spawnFn(cmd, args, { stdio: 'inherit' });
        } catch (err) {
            resolve({ pid: null, code: 1, spawnError: err.message });
            return;
        }

        childPid = child.pid ?? null;

        child.on('error', (err) => {
            resolve({ pid: childPid, code: 1, spawnError: err.message });
        });

        child.on('close', (code) => {
            resolve({ pid: childPid, code: code ?? 1, spawnError: null });
        });
    });

    exitCode = childResult.code;
    const endedAt = new Date().toISOString();
    if (ipcStarted) {
        try {
            await ipcFn(`END ${run.run_id}`);
        } catch (err) {
            ipcError ??= err.message;
        }
    }

    // ── 4. Record process context ─────────────────────────────────────────────
    // Insert context with exact start/end timestamps directly (bypass now())
    // so the window matches precisely what was measured.
    const contextId = await _insertContextDirect(db, {
        workloadId: workload.workload_id,
        runId:      run.run_id,
        attemptId:  attempt.attempt_id,
        externalId: childPid !== null ? String(childPid) : 'unknown',
        resourceId,
        startedAt,
        endedAt,
    });

    // ── 5. Complete identity lifecycle ────────────────────────────────────────
    const attemptStatus = exitCode === 0 ? 'completed' : 'failed';
    const failReason    = exitCode !== 0
        ? (childResult.spawnError ?? `exit code ${exitCode}`)
        : null;

    const completedAttempt = await completeAttempt(db, {
        attemptId: attempt.attempt_id,
        status:    attemptStatus,
        reason:    failReason,
    });
    const completedRun = await completeRun(db, {
        runId:  run.run_id,
        status: attemptStatus,
    });

    // ── 6. Read SigSense telemetry for the execution window ───────────────────
    let telemetryRows  = [];
    let telemetryError = null;

    try {
        if (telemetryFn) {
            // Injected test/override function
            telemetryRows = await telemetryFn(startedAt, endedAt, resourceId);
        } else {
            const sigDb = await openSigSenseDb(sigsenseDb);
            try {
                telemetryRows = await readTelemetryWindow(sigDb, {
                    windowStart: startedAt,
                    windowEnd:   endedAt,
                    resourceId,
                });
            } finally {
                await closeSigSenseDb(sigDb);
            }
        }
    } catch (err) {
        telemetryError = err.message;
        telemetryRows  = [];
    }

    telemetryRows = prepareTelemetryRows(telemetryRows, startedAt, endedAt);

    // ── 7. Run deterministic attribution ──────────────────────────────────────
    // The attribution window is the actual range of telemetry timestamps,
    // not the process start/end time.  This ensures reconciliation queries
    // find the records that were just inserted regardless of any clock skew
    // between the process wall clock and the telemetry source.
    let attrWindowStart = startedAt;
    let attrWindowEnd   = endedAt;

    if (telemetryRows.length > 0) {
        const timestamps = telemetryRows.map(r => r.timestamp).sort();
        attrWindowStart  = timestamps[0];
        attrWindowEnd    = timestamps[timestamps.length - 1];

        await attributeTelemetryWindow(db, {
            telemetry:   telemetryRows,
            windowStart: attrWindowStart,
            windowEnd:   attrWindowEnd,
        });
    }

    // ── 8. Reconciliation ─────────────────────────────────────────────────────
    const reconciliation = await reconcileAttribution(db, {
        windowStart: attrWindowStart,
        windowEnd:   attrWindowEnd,
        telemetry:   telemetryRows,
    });

    // ── 9. Compute duration ───────────────────────────────────────────────────
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

    const sources = new Set(telemetryRows.map(row => row.measurement_source ?? 'unknown'));
    const measurementQuality = telemetryRows.length === 0 ? 'unavailable'
        : sources.size > 1 ? 'mixed'
            : [...sources][0];
    const gridSources = new Set(telemetryRows.map(row => row.grid_intensity_source ?? 'unknown'));
    const gridIntensityQuality = telemetryRows.length === 0 ? 'unavailable'
        : gridSources.size > 1 ? 'mixed'
            : [...gridSources][0] === 'electricity-maps-live' ? 'live' : [...gridSources][0];
    const rawAttributionCoverage = reconciliation.measured.power_watts > 0
        ? reconciliation.attributed.power_watts / reconciliation.measured.power_watts * 100 : 0;
    const attributionCoverage = rawAttributionCoverage >= 100 - 1e-9
        ? 100 : Math.min(100, Math.max(0, rawAttributionCoverage));
    const runMetrics = {
        duration_ms: durationMs,
        average_power_watts: reconciliation.measured.power_watts,
        peak_power_watts: reconciliation.measured.peak_power_watts,
        energy_wh: reconciliation.measured.energy_wh,
        carbon_gco2e: reconciliation.measured.carbon_gco2e,
        water_liters: reconciliation.measured.water_liters,
        attribution_coverage: attributionCoverage,
        measurement_quality: measurementQuality,
        grid_intensity_quality: gridIntensityQuality,
    };
    const baseline = await findBaseline(db, workload.workload_id, run.run_id);
    const baselineComparison = baseline
        ? { run_id: baseline.baseline_run_id, ended_at: baseline.baseline_ended_at,
            measurement_quality: baseline.measurement_quality,
            grid_intensity_quality: baseline.grid_intensity_quality ?? 'unknown',
            metrics: compareRunMetrics(runMetrics, baseline) }
        : null;
    await saveRunMetrics(db, run.run_id, runMetrics);
    const insights = deriveInsights({
        baselineComparison,
        currentMetrics: runMetrics,
        telemetryCount: telemetryRows.length,
        resourceId,
    });
    const aiExplanation = aiProvider
        ? await explainWithProvider({ facts: runMetrics, insights, provider: aiProvider })
        : null;

    // ── 10. Close Transparency DB ─────────────────────────────────────────────
    await new Promise((resolve) => db.close(() => resolve()));

    return {
        // Identity
        workload,
        run:     completedRun,
        attempt: completedAttempt,
        contextId,

        // Execution
        command,
        exitCode,
        spawnError:    childResult.spawnError,
        startedAt,
        endedAt,
        durationMs,
        pid:           childPid,
        resourceId,

        // Telemetry
        telemetryRows,
        telemetryError,
        ipcError,
        telemetryCount: telemetryRows.length,

        // Attribution
        reconciliation,
        runMetrics,
        baselineComparison,
        insights,
        aiExplanation,
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Insert a context_event with fully controlled timestamps.
 * Bypasses startContext/endContext (which call now()) so the window
 * precisely matches startedAt/endedAt from the child process.
 *
 * @returns {Promise<string>} The new context_id.
 */
async function _insertContextDirect(db, { workloadId, runId, attemptId,
                                          externalId, resourceId,
                                          startedAt, endedAt }) {
    const { randomUUID } = await import('node:crypto');
    const context_id = randomUUID();

    await dbRun(db,
        `INSERT INTO context_events
             (context_id, workload_id, run_id, attempt_id,
              context_type, external_id, resource_id,
              started_at, ended_at, source, parent_context_id)
         VALUES (?,?,?,?, 'process',?,?, ?,?,?,NULL)`,
        [context_id, workloadId, runId, attemptId,
         externalId, resourceId ?? null,
         startedAt, endedAt, 'transparency-cli']
    );
    return context_id;
}
