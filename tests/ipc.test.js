import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendIpcCommand, defaultIpcEndpoint } from '../src/transparency/ipc.js';

describe('protected service IPC client protocol', () => {
    it('sends one bounded protocol command and accepts an OK response', async () => {
        let sent = '';
        const connectionFactory = () => {
            const socket = new EventEmitter();
            socket.write = value => {
                sent += value;
                queueMicrotask(() => socket.emit('data', Buffer.from('OK COLLECTING\n')));
            };
            socket.end = () => {};
            socket.destroy = error => socket.emit('error', error);
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        };
        const response = await sendIpcCommand(
            'BEGIN 123e4567-e89b-12d3-a456-426614174000',
            { endpoint: '/tmp/fake-ecoprint.sock', connectionFactory },
        );
        assert.equal(response, 'OK COLLECTING');
        assert.equal(sent, 'BEGIN 123e4567-e89b-12d3-a456-426614174000\n');
    });

    it('rejects commands outside the read/status/run-marker protocol', async () => {
        await assert.rejects(sendIpcCommand('STOP'), /Unsupported IPC command/);
        await assert.rejects(sendIpcCommand('BEGIN ../../etc/passwd'), /Unsupported IPC command/);
    });

    it('allows END to wait for an in-flight telemetry sample while keeping other commands short', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        const delays = [];
        globalThis.setTimeout = (callback, delay, ...args) => {
            delays.push(delay);
            return originalSetTimeout(callback, delay, ...args);
        };
        const connectionFactory = () => {
            const socket = new EventEmitter();
            socket.write = () => queueMicrotask(() => socket.emit('data', Buffer.from('OK IDLE\n')));
            socket.end = () => {};
            socket.destroy = error => socket.emit('error', error);
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        };
        try {
            await sendIpcCommand('END 123e4567-e89b-12d3-a456-426614174000', {
                endpoint: '/tmp/fake-ecoprint.sock', connectionFactory,
            });
            await sendIpcCommand('PING', {
                endpoint: '/tmp/fake-ecoprint.sock', connectionFactory,
            });
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
        assert.deepEqual(delays, [5000, 1500]);
    });

    it('uses a Windows named pipe endpoint on Windows', () => {
        assert.equal(defaultIpcEndpoint('win32'), '\\\\.\\pipe\\ecoprint-transparency');
    });
});
