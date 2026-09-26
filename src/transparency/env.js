/**
 * env.js — Identity propagation helpers for the Transparency layer.
 *
 * Defines the environment variable names used to propagate active attempt
 * identity into child processes.  When SigSense (or any downstream process)
 * is launched as a child, these variables allow it to tag measurements with
 * the correct workload/run/attempt context without a direct API call.
 *
 * Usage:
 *   import { buildIdentityEnv, readIdentityEnv } from './env.js';
 *
 *   // Parent process — before spawning a child:
 *   const env = buildIdentityEnv({ workloadId, runId, attemptId });
 *   spawn('some-command', [], { env: { ...process.env, ...env } });
 *
 *   // Child process — reading identity from its own environment:
 *   const identity = readIdentityEnv();
 *   // identity.workloadId, identity.runId, identity.attemptId (all may be null)
 */

// ── Canonical environment variable names ────────────────────────────────────

export const ENV_WORKLOAD_ID = 'ECOPRINT_WORKLOAD_ID';
export const ENV_RUN_ID      = 'ECOPRINT_RUN_ID';
export const ENV_ATTEMPT_ID  = 'ECOPRINT_ATTEMPT_ID';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an environment variable object suitable for spreading into a
 * child process's env.
 *
 * @param {object} opts
 * @param {string} opts.workloadId
 * @param {string} opts.runId
 * @param {string} opts.attemptId
 * @returns {Record<string, string>}
 */
export function buildIdentityEnv({ workloadId, runId, attemptId }) {
    return {
        [ENV_WORKLOAD_ID]: workloadId,
        [ENV_RUN_ID]:      runId,
        [ENV_ATTEMPT_ID]:  attemptId,
    };
}

/**
 * Read identity context from the current process's environment variables.
 * Returns null for any variable that is not set.
 *
 * @param {Record<string, string|undefined>} [env] Defaults to process.env.
 * @returns {{ workloadId: string|null, runId: string|null, attemptId: string|null }}
 */
export function readIdentityEnv(env = process.env) {
    return {
        workloadId: env[ENV_WORKLOAD_ID] ?? null,
        runId:      env[ENV_RUN_ID]      ?? null,
        attemptId:  env[ENV_ATTEMPT_ID]  ?? null,
    };
}
