import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** Parse `ps` PID/PPID/elapsed/executable output; arguments are intentionally omitted. */
export function parseProcessSnapshot(output, observedAt = new Date().toISOString()) {
    const observedMs = Date.parse(observedAt);
    return String(output).split(/\r?\n/).flatMap(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
        if (!match) return [];
        const elapsedSeconds = Number(match[3]);
        return [{
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            elapsedSeconds,
            executable: path.basename(match[4]),
            processStartedAt: Number.isFinite(observedMs)
                ? new Date(observedMs - elapsedSeconds * 1000).toISOString() : null,
        }];
    });
}

export async function readMacProcessSnapshot({ execFileFn = execFileAsync, clock = () => new Date() } = {}) {
    const observedAt = clock().toISOString();
    const { stdout } = await execFileFn('/bin/ps', ['-axo', 'pid=,ppid=,etimes=,comm='], {
        maxBuffer: 4 * 1024 * 1024,
    });
    return { observedAt, processes: parseProcessSnapshot(stdout, observedAt) };
}

function classifyProcess(pid, processMap, clientPid, ecoprintPid, seen = new Set()) {
    if (pid === clientPid) return 'client';
    if (pid === ecoprintPid) return 'ecoprint';
    if (seen.has(pid)) return 'unknown';
    seen.add(pid);
    const process = processMap.get(pid);
    if (!process || process.parentPid === pid) return 'unknown';
    const parentClass = classifyProcess(process.parentPid, processMap, clientPid, ecoprintPid, seen);
    if (parentClass === 'client' || parentClass === 'child-of-client') return 'child-of-client';
    if (parentClass === 'ecoprint' || parentClass === 'child-of-ecoprint') return 'child-of-ecoprint';
    return 'unknown';
}

/** Merge snapshots into run-scoped, estimated process lifetimes and lineage. */
export function deriveProcessContexts(snapshots, { clientPid, ecoprintPid, windowStart, windowEnd }) {
    const records = new Map();
    for (const snapshot of snapshots) {
        const processMap = new Map(snapshot.processes.map(process => [process.pid, process]));
        for (const process of snapshot.processes) {
            const classification = classifyProcess(process.pid, processMap, clientPid, ecoprintPid);
            if (!['child-of-client', 'child-of-ecoprint'].includes(classification)) continue;
            const key = String(process.pid);
            const record = records.get(key) ?? {
                pid: process.pid,
                parentPid: process.parentPid,
                executable: process.executable,
                processStartedAt: process.processStartedAt,
                processStartQuality: process.elapsedSeconds == null ? 'observed-only' : 'estimated-seconds',
                classification,
                firstSeenAt: snapshot.observedAt,
                lastSeenAt: snapshot.observedAt,
                presentAtEnd: false,
            };
            record.parentPid = process.parentPid;
            record.executable = process.executable;
            record.classification = classification;
            record.lastSeenAt = snapshot.observedAt;
            records.set(key, record);
        }
    }
    const lastSnapshot = snapshots.at(-1);
    const presentAtEnd = new Set(lastSnapshot?.processes.map(process => process.pid) ?? []);
    return [...records.values()].map(record => {
        const seenStart = Date.parse(record.firstSeenAt);
        const processStart = Date.parse(record.processStartedAt ?? record.firstSeenAt);
        const start = Math.max(Date.parse(windowStart), Number.isFinite(processStart) ? processStart : seenStart);
        const end = presentAtEnd.has(record.pid) ? Date.parse(windowEnd) : Date.parse(record.lastSeenAt);
        return {
            ...record,
            startedAt: new Date(Math.max(Date.parse(windowStart), start)).toISOString(),
            endedAt: new Date(Math.max(Date.parse(windowStart), Math.min(Date.parse(windowEnd), end))).toISOString(),
            parentContextPid: record.parentPid,
        };
    }).filter(record => record.endedAt >= record.startedAt);
}

/** macOS process sampler. Captures process names and lineage, never argv/environment. */
export function createProcessProvenanceMonitor({
    platform = process.platform,
    snapshotFn = readMacProcessSnapshot,
    intervalMs = 500,
} = {}) {
    const snapshots = [];
    let timer = null;
    let pending = Promise.resolve();
    let stopped = false;
    const collect = async () => {
        if (stopped || platform !== 'darwin') return;
        pending = pending.then(async () => snapshots.push(await snapshotFn())).catch(() => {});
        await pending;
    };
    return {
        async start() {
            if (platform !== 'darwin') return;
            await collect();
            timer = setInterval(collect, intervalMs);
            timer.unref?.();
        },
        async stop(options) {
            if (timer) clearInterval(timer);
            await collect();
            stopped = true;
            await pending;
            return platform === 'darwin'
                ? deriveProcessContexts(snapshots, options)
                : [];
        },
        get snapshotCount() { return snapshots.length; },
    };
}
