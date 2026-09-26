/**
 * index.js — Public API for the EcoPrint Transparency Identity Core.
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
 *   // propagate to a child process
 *   const childEnv = buildIdentityEnv({
 *     workloadId: workload.workload_id,
 *     runId:      run.run_id,
 *     attemptId:  attempt.attempt_id,
 *   });
 *
 *   await completeAttempt(db, { attemptId: attempt.attempt_id, status: 'completed' });
 *   await completeRun(db,     { runId: run.run_id, status: 'completed' });
 *
 *   const timeline = await getWorkloadTimeline(db, workload.workload_id);
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

// Identity propagation
export {
    ENV_WORKLOAD_ID,
    ENV_RUN_ID,
    ENV_ATTEMPT_ID,
    buildIdentityEnv,
    readIdentityEnv,
} from './env.js';
