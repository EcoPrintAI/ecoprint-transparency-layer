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
import { buildAIContext, explainWithProvider, normalizeAIUsage, validateAIExplanation } from './ai.js';
import { experienceContext, retrieveRelevantExperiences, saveExperienceCase } from './experience.js';
import { prepareTelemetryRows } from './metrics.js';
import { buildIdentityEnv, readIdentityEnv } from './env.js';
import { createProcessProvenanceMonitor } from './process_provenance.js';
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
 * @param {Record<string, string|undefined>} [opts.identityEnv] Explicit identity source.
 *                                        Defaults to empty to prevent ambient ID reuse.
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
        identityEnv    = {},
        processMonitorFactory = createProcessProvenanceMonitor,
    } = opts;
    const externalIdentity = readIdentityEnv(identityEnv);

    // ── 1. Open Transparency database ─────────────────────────────────────────
    const db = await openDatabase(transparencyDb);
    await initSchema(db);

    // ── 2. Identity ───────────────────────────────────────────────────────────
    let workload = externalIdentity.workloadId
        ? await dbGet(db, 'SELECT * FROM workloads WHERE workload_id = ?', [externalIdentity.workloadId])
        : await dbGet(db,
            `SELECT * FROM workloads WHERE name = ? AND type = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
            [workloadName, workloadType]);
    if (!workload) workload = await createWorkload(db, {
        name: workloadName, type: workloadType, workloadId: externalIdentity.workloadId ?? null,
    });
    const run = await startRun(db, { workloadId: workload.workload_id, runId: externalIdentity.runId ?? null });
    const attempt = await startAttempt(db, {
        runId: run.run_id, workloadId: workload.workload_id, attemptId: externalIdentity.attemptId ?? null,
    });

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
    const provenanceMonitor = processMonitorFactory();
    await provenanceMonitor.start().catch(() => {});

    const childResult = await new Promise((resolve) => {
        let child;
        try {
            child = spawnFn(cmd, args, {
                stdio: 'inherit',
                env: { ...process.env, ...buildIdentityEnv({
                    workloadId: workload.workload_id, runId: run.run_id, attemptId: attempt.attempt_id,
                }) },
            });
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
    const processContexts = await provenanceMonitor.stop({
        clientPid: childPid, ecoprintPid: process.pid, windowStart: startedAt, windowEnd: endedAt,
    }).catch(() => []);
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
    const ecoprintContextId = await _insertContextDirect(db, {
        workloadId: workload.workload_id,
        runId: run.run_id,
        attemptId: attempt.attempt_id,
        externalId: String(process.pid),
        processId: process.pid,
        parentProcessId: process.ppid,
        executableIdentity: path.basename(process.execPath),
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        processStartQuality: 'process-api',
        classification: 'ecoprint',
        provenanceSource: 'cli-process-api',
        attributionEligible: false,
        resourceId,
        startedAt,
        endedAt,
        parentContextId: null,
    });
    const contextId = await _insertContextDirect(db, {
        workloadId: workload.workload_id,
        runId:      run.run_id,
        attemptId:  attempt.attempt_id,
        externalId: childPid !== null ? String(childPid) : 'unknown',
        processId: childPid,
        parentProcessId: process.pid,
        executableIdentity: path.basename(cmd ?? 'unknown'),
        processStartedAt: startedAt,
        processStartQuality: 'spawn-observed',
        classification: childPid === null ? 'unknown' : 'client',
        provenanceSource: 'transparency-spawn',
        attributionEligible: true,
        resourceId,
        startedAt,
        endedAt,
        parentContextId: ecoprintContextId,
    });
    const contextByPid = new Map([[process.pid, ecoprintContextId], [childPid, contextId]]);
    for (const discovered of processContexts) {
        const parentContextId = contextByPid.get(discovered.parentPid) ?? null;
        const processContextId = await _insertContextDirect(db, {
            workloadId: workload.workload_id, runId: run.run_id, attemptId: attempt.attempt_id,
            externalId: String(discovered.pid), processId: discovered.pid,
            parentProcessId: discovered.parentPid, executableIdentity: discovered.executable,
            processStartedAt: discovered.processStartedAt, processStartQuality: discovered.processStartQuality,
            classification: discovered.classification, provenanceSource: 'macos-ps-process-snapshot',
            attributionEligible: false, resourceId, startedAt: discovered.startedAt,
            endedAt: discovered.endedAt, parentContextId,
        });
        contextByPid.set(discovered.pid, processContextId);
    }

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
        // END is a service-side barrier: it drains and persists the final
        // in-flight sample before the read-only telemetry window is queried.
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
        cpu_average_power_watts: reconciliation.measured.cpu_power_watts,
        cpu_peak_power_watts: reconciliation.measured.cpu_peak_power_watts,
        cpu_energy_wh: reconciliation.measured.cpu_energy_wh,
        gpu_average_power_watts: reconciliation.measured.gpu_power_watts,
        gpu_peak_power_watts: reconciliation.measured.gpu_peak_power_watts,
        gpu_energy_wh: reconciliation.measured.gpu_energy_wh,
        ane_average_power_watts: reconciliation.measured.ane_power_watts,
        ane_peak_power_watts: reconciliation.measured.ane_peak_power_watts,
        ane_energy_wh: reconciliation.measured.ane_energy_wh,
        client_workload_average_power_watts: reconciliation.measured.client_workload_power_watts,
        client_workload_peak_power_watts: reconciliation.measured.client_workload_peak_power_watts,
        client_workload_energy_wh: reconciliation.measured.client_workload_energy_wh,
        client_workload_carbon_gco2e: reconciliation.measured.client_workload_carbon_gco2e,
        client_workload_water_liters: reconciliation.measured.client_workload_water_liters,
        ecoprint_overhead_average_power_watts: reconciliation.measured.ecoprint_overhead_power_watts,
        ecoprint_overhead_peak_power_watts: reconciliation.measured.ecoprint_overhead_peak_power_watts,
        ecoprint_overhead_energy_wh: reconciliation.measured.ecoprint_overhead_energy_wh,
        ecoprint_overhead_carbon_gco2e: reconciliation.measured.ecoprint_overhead_carbon_gco2e,
        ecoprint_overhead_water_liters: reconciliation.measured.ecoprint_overhead_water_liters,
        measurement_efficiency_pct: measurementEfficiency(reconciliation.measured),
        measurement_method: [...new Set(telemetryRows.map(row => row.measurement_source ?? 'unknown'))].sort().join('+') || 'unavailable',
        allocation_method: [...new Set(telemetryRows.map(row => row.allocation_basis ?? 'unavailable'))].sort().join('+') || 'unavailable',
        provenance_quality: provenanceQuality(telemetryRows),
        process_context_count: processContexts.length + 2,
        process_lineage_coverage: processLineageCoverage(processContexts, childPid),
        component_telemetry_counts: Object.fromEntries(['cpu', 'gpu', 'ane'].map(component =>
            [component, telemetryRows.filter(row => row[`${component}_power_watts`] != null).length])),
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
        processContexts,
        workload,
        run,
        attempt,
    });
    const aiFacts = {
        execution: { started_at: startedAt, ended_at: endedAt, duration_ms: durationMs },
        telemetry_observation_count: telemetryRows.length,
        identity: {
            workload: { workload_id: workload.workload_id, name: workload.name, identity_source: workload.identity_source },
            run: { run_id: run.run_id, identity_source: run.identity_source },
            attempt: { attempt_id: attempt.attempt_id, attempt_no: attempt.attempt_no, identity_source: attempt.identity_source },
        },
        process_lineage: [
            { pid: process.pid, parent_pid: process.ppid, executable: path.basename(process.execPath), classification: 'ecoprint' },
            { pid: childPid, parent_pid: process.pid, executable: path.basename(cmd ?? 'unknown'), classification: childPid == null ? 'unknown' : 'client' },
            ...processContexts.map(({ pid, parentPid, executable, classification, startedAt: processStart, endedAt: processEnd }) => ({
                pid, parent_pid: parentPid, executable, classification, started_at: processStart, ended_at: processEnd,
            })),
        ],
        measurement: runMetrics,
        self_measurement: {
            client_workload: {
                energy_wh: runMetrics.client_workload_energy_wh,
                carbon_gco2e: runMetrics.client_workload_carbon_gco2e,
                water_liters: runMetrics.client_workload_water_liters,
            },
            ecoprint_overhead: {
                energy_wh: runMetrics.ecoprint_overhead_energy_wh,
                carbon_gco2e: runMetrics.ecoprint_overhead_carbon_gco2e,
                water_liters: runMetrics.ecoprint_overhead_water_liters,
            },
            efficiency_pct: runMetrics.measurement_efficiency_pct,
            method: runMetrics.measurement_method,
            allocation_method: runMetrics.allocation_method,
            provenance_quality: runMetrics.provenance_quality,
        },
        attribution: {
            coverage: runMetrics.attribution_coverage,
            version: reconciliation.attribution_version,
            reconciliation,
        },
        baseline: baselineComparison,
        system_context: { other_process_details: 'not collected; process arguments and unrelated process identities are not persisted' },
        measured_observations: telemetryRows.map(row => ({
            timestamp: row.timestamp,
            interval_seconds: row.interval_seconds,
            total_power_watts: row.total_power_watts,
            cpu_power_watts: row.cpu_power_watts,
            gpu_power_watts: row.gpu_power_watts,
            ane_power_watts: row.ane_power_watts,
            measurement_source: row.measurement_source,
        })),
        deterministic_derived_facts: {
            metrics: runMetrics,
            environmental_impact: telemetryRows.map(row => ({
                timestamp: row.timestamp,
                carbon_gco2e: row.carbon_gCO2e,
                water_liters: row.water_liters,
                grid_intensity_source: row.grid_intensity_source,
            })),
        },
    };
    let experienceMemoryError = null;
    if (aiProvider) {
        try {
            const cases = await retrieveRelevantExperiences(db, { workload, facts: aiFacts });
            aiFacts.experience_memory = experienceContext(cases);
        } catch (err) {
            experienceMemoryError = err.message;
            aiFacts.experience_memory = experienceContext([], 'unavailable');
        }
    }

    let aiExplanation = null;
    let aiError = null;
    let aiGroundingError = null;
    let aiUsage = null;
    if (aiProvider) {
        const aiContext = buildAIContext({ facts: aiFacts, insights });
        try {
            const candidate = await explainWithProvider({
                facts: aiContext.facts, insights: aiContext.insights, provider: aiProvider,
            });
            const validation = validateAIExplanation({
                explanation: candidate, facts: aiContext.facts, providerUsage: aiProvider.usageMetadata,
            });
            if (validation.valid) aiExplanation = candidate;
            else aiGroundingError = validation.reason;
        } catch (err) {
            aiError = err.message || 'AI provider request failed';
        } finally {
            aiUsage = normalizeAIUsage(aiProvider.usageMetadata, {
                identity: {
                    workload_id: workload.workload_id,
                    run_id: run.run_id,
                    attempt_id: attempt.attempt_id,
                    attempt_no: attempt.attempt_no,
                },
            });
            if (aiUsage) aiFacts.logical_ai_usage = aiUsage;
        }
    }

    try {
        await saveExperienceCase(db, {
            workload, run: completedRun, telemetryRows, runMetrics, reconciliation,
            processLineage: aiFacts.process_lineage, baselineComparison, insights,
            aiExplanation, aiProvider, aiUsage,
        });
    } catch (err) {
        experienceMemoryError ??= err.message || 'could not store experience case';
    }

    // ── 10. Close Transparency DB ─────────────────────────────────────────────
    await new Promise((resolve) => db.close(() => resolve()));

    return {
        // Identity
        workload,
        run:     completedRun,
        attempt: completedAttempt,
        contextId,
        ecoprintContextId,
        processContexts,
        aiFacts,

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
        aiUsage,
        aiError,
        aiGroundingError,
        experienceMemoryError,
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
                                          startedAt, endedAt, processId = null,
                                          parentProcessId = null, executableIdentity = null,
                                          processStartedAt = null, processStartQuality = null,
                                          classification = 'unknown', provenanceSource = 'transparency-cli',
        attributionEligible = true, parentContextId = null }) {
    const { randomUUID } = await import('node:crypto');
    const context_id = randomUUID();

    await dbRun(db,
        `INSERT INTO context_events
             (context_id, workload_id, run_id, attempt_id,
              context_type, external_id, resource_id,
              started_at, ended_at, source, parent_context_id, process_id, parent_process_id,
              executable_identity, process_started_at, process_start_quality,
              provenance_classification, provenance_source, attribution_eligible)
         VALUES (?,?,?,?, 'process',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [context_id, workloadId, runId, attemptId,
         externalId, resourceId ?? null,
         startedAt, endedAt, provenanceSource, parentContextId, processId, parentProcessId,
         executableIdentity, processStartedAt, processStartQuality, classification,
         provenanceSource, attributionEligible ? 1 : 0]
    );
    return context_id;
}

function measurementEfficiency(metrics) {
    const client = metrics.client_workload_energy_wh;
    const overhead = metrics.ecoprint_overhead_energy_wh;
    const total = client == null || overhead == null ? null : client + overhead;
    return total > 0 ? client / total * 100 : null;
}

function provenanceQuality(rows) {
    if (!rows.length) return 'unavailable';
    const available = rows.filter(row => row.split_provenance === 'allocated').length;
    if (!available) return 'unavailable';
    if (available !== rows.length) return 'partial';
    return rows.every(row => (row.measurement_source ?? '').startsWith('hardware'))
        ? 'hardware-total-with-allocated-split' : 'estimated-total-with-allocated-split';
}

function processLineageCoverage(rows, clientPid) {
    if (!clientPid) return null;
    const linkable = rows.filter(row => row.parentPid != null).length;
    return (linkable + 1) / (rows.length + 1) * 100;
}
