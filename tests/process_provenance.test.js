import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProcessContexts, parseProcessSnapshot } from '../src/transparency/process_provenance.js';

describe('macOS process provenance normalization', () => {
    it('parses PID, parent, elapsed time, and executable without command arguments', () => {
        const rows = parseProcessSnapshot('  10     1  120 /usr/bin/node\n  11    10    2 /usr/bin/helper tool',
            '2026-09-26T12:00:00.000Z');
        assert.deepEqual(rows.map(({ pid, parentPid, executable }) => ({ pid, parentPid, executable })), [
            { pid: 10, parentPid: 1, executable: 'node' },
            { pid: 11, parentPid: 10, executable: 'helper tool' },
        ]);
        assert.equal(rows[0].processStartedAt, '2026-09-26T11:58:00.000Z');
        assert.equal(JSON.stringify(rows).includes('secret'), false);
    });

    it('builds client and EcoPrint descendant lineage and closes processes no longer observed', () => {
        const snapshots = [
            { observedAt: '2026-09-26T12:00:00.000Z', processes: [
                { pid: 100, parentPid: 1, executable: 'node', elapsedSeconds: 30, processStartedAt: '2026-09-26T11:59:30.000Z' },
                { pid: 200, parentPid: 100, executable: 'make', elapsedSeconds: 0, processStartedAt: '2026-09-26T12:00:00.000Z' },
                { pid: 201, parentPid: 200, executable: 'clang', elapsedSeconds: 0, processStartedAt: '2026-09-26T12:00:00.000Z' },
                { pid: 300, parentPid: 1, executable: 'unrelated', elapsedSeconds: 2, processStartedAt: '2026-09-26T11:59:58.000Z' },
            ] },
            { observedAt: '2026-09-26T12:00:01.000Z', processes: [
                { pid: 100, parentPid: 1, executable: 'node', elapsedSeconds: 31, processStartedAt: '2026-09-26T11:59:30.000Z' },
                { pid: 200, parentPid: 100, executable: 'make', elapsedSeconds: 1, processStartedAt: '2026-09-26T12:00:00.000Z' },
                { pid: 101, parentPid: 100, executable: 'ps-helper', elapsedSeconds: 0, processStartedAt: '2026-09-26T12:00:01.000Z' },
            ] },
        ];
        const contexts = deriveProcessContexts(snapshots, {
            clientPid: 200, ecoprintPid: 100,
            windowStart: '2026-09-26T12:00:00.000Z', windowEnd: '2026-09-26T12:00:02.000Z',
        });
        assert.equal(contexts.find(context => context.pid === 201)?.classification, 'child-of-client');
        assert.equal(contexts.find(context => context.pid === 201)?.parentPid, 200);
        assert.equal(contexts.find(context => context.pid === 101)?.classification, 'child-of-ecoprint');
        assert.equal(contexts.some(context => context.pid === 300), false);
        assert.equal(contexts.find(context => context.pid === 201)?.endedAt, '2026-09-26T12:00:00.000Z');
    });
});
