/**
 * index.js — Public API for the EcoPrint Transparency layer.
 *
 * Import from this module rather than from individual internal files.
 *
 * Typical usage:
 *
 *   import {
 *     openDatabase, initSchema, closeDatabase,
 *     createWorkload, startRun, startAttempt,
 *     completeAttempt, completeRun,
 *     getWorkloadTimeline,
 *     startContext, endContext,
 *     getAttemptContexts, getWorkloadContextTimeline, getContextsInWindow,
 *     buildIdentityEnv, readIdentityEnv,
 *   } from './src/transparency/index.js';
 *
 *   const db = await openDatabase();   // or openDatabase(':memory:')
 *   await initSchema(db);
 *
 *   const workload = await createWorkload(db, { name: 'my-build', type: 'ci-build' });
 *   const run      = await startRun(db,     { workloadId: workload.workload_id });
 *   const attempt  = await startAttempt(db, { runId: run.run_id, workloadId: workload.workload_id });
 *
 *   // record the process context for this attempt
 *   const ctx = await startContext(db, {
 *     workloadId: workload.workload_id,
 *     runId:      run.run_id,
 *     attemptId:  attempt.attempt_id,
 *     externalId: String(process.pid),
 *     source:     'transparency-launch',
 *     resourceId: os.hostname(),
 *   });
 *
 *   // propagate identity to a child process
 *   const childEnv = buildIdentityEnv({
 *     workloadId: workload.workload_id,
 *     runId:      run.run_id,
 *     attemptId:  attempt.attempt_id,
 *   });
 *
 *   await endContext(db,      { contextId: ctx.context_id });
 *   await completeAttempt(db, { attemptId: attempt.attempt_id, status: 'completed' });
 *   await completeRun(db,     { runId: run.run_id, status: 'completed' });
 *
 *   const timeline = await getWorkloadTimeline(db, workload.workload_id);
 *   const ctxs     = await getAttemptContexts(db,  attempt.attempt_id);
 *
 *   await closeDatabase(db);
 */

// Database lifecycle
export { openDatabase, initSchema, closeDatabase } from './db.js';

// Identity service
export {
    createWorkload,
    getWorkload,
    startRun,
    completeRun,
    getRun,
    startAttempt,
    completeAttempt,
    getAttempt,
    getWorkloadTimeline,
} from './identity.js';

// Context timeline service
export {
    startContext,
    endContext,
    getContext,
    getAttemptContexts,
    getWorkloadContextTimeline,
    getContextsInWindow,
} from './context.js';

// Attribution layer
export {
    attributeTelemetryWindow,
    recomputeAttribution,
    getAttribution,
    getAttemptAttribution,
    getWorkloadAttribution,
    getUnattributedTelemetry,
    reconcileAttribution,
    ATTRIBUTION_VERSION,
} from './attribution.js';

// Telemetry read adapter (SigSense)
export {
    openSigSenseDb,
    closeSigSenseDb,
    readTelemetryWindow,
    DEFAULT_SIGSENSE_DB,
} from './telemetry.js';

// CLI lifecycle orchestrator
export { runUnderTransparency, DEFAULT_TRANSPARENCY_DB } from './cli.js';

// Identity propagation
export {
    ENV_WORKLOAD_ID,
    ENV_RUN_ID,
    ENV_ATTEMPT_ID,
    buildIdentityEnv,
    readIdentityEnv,
} from './env.js';
