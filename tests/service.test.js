import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manageService } from '../src/transparency/service.js';

const macInstaller = readFileSync(new URL('../sigsense/service/ecoprint-service.sh', import.meta.url), 'utf8');
const macTelemetry = readFileSync(new URL('../sigsense/engine/telemetry_apple.cpp', import.meta.url), 'utf8');
const ipcListener = readFileSync(new URL('../sigsense/engine/ipc_listener.cpp', import.meta.url), 'utf8');
const engineMain = readFileSync(new URL('../sigsense/engine/main.cpp', import.meta.url), 'utf8');

describe('service command dispatcher', () => {
    it('routes supported actions to the platform installer without shell interpolation', () => {
        let invocation;
        const result = manageService('status', {
            platform: 'linux',
            runner: (...args) => {
                invocation = args;
                return { status: 0 };
            },
        });
        assert.deepEqual(result, { action: 'status', platform: 'linux' });
        assert.equal(invocation[0], 'bash');
        assert.match(invocation[1][0], /ecoprint-service\.sh$/);
        assert.equal(invocation[1][1], 'status');
    });

    it('routes Windows actions to the SCM PowerShell helper', () => {
        let invocation;
        manageService('install', {
            platform: 'win32',
            runner: (...args) => {
                invocation = args;
                return { status: 0 };
            },
        });
        assert.equal(invocation[0], 'powershell.exe');
        assert.match(invocation[1][2], /ecoprint-service\.ps1$/);
    });

    it('rejects unsupported actions and propagates installer failures', () => {
        assert.throws(() => manageService('restart'), /Unsupported service action/);
        assert.throws(() => manageService('install', {
            platform: 'linux', runner: () => ({ status: 1 }),
        }), /Service install failed/);
    });
});

describe('macOS service installer permissions', () => {
    it('adds the logged-in CLI user to IPC access and replaces an already-loaded daemon', () => {
        assert.match(macInstaller, /MACOS_USER=\$\{SUDO_USER:-\$\(stat -f '%Su' \/dev\/console\)\}/);
        assert.match(macInstaller, /launchctl bootout system "\$SERVICE_FILE"[\s\S]*?launchctl bootstrap system "\$SERVICE_FILE"/);
    });

    it('keeps the telemetry directory traversable and its files read-only to the CLI group', () => {
        assert.ok(macInstaller.includes('install -d -o root -g "$GROUP" -m 0750 "$(dirname "$DB")"'));
        assert.ok(macInstaller.includes('chmod 0640 "$data_file"'));
        assert.ok(macInstaller.includes('<key>Umask</key><integer>23</integer>'));
        assert.ok(macInstaller.includes('install -d -o root -g wheel -m 0700 "$(dirname "$CONFIG")"'));
        assert.ok(macInstaller.includes('chmod 0600 "$CONFIG"'));
    });

    it('flushes active macOS samples before the CLI reads the completed run window', () => {
        assert.match(macTelemetry, /liveSession\.recordMetric\([\s\S]*?\);\s*liveSession\.forceFlush\(\);/);
        assert.match(engineMain, /telemetrySampleCondition\.wait\(lock, \[\] \{ return !telemetrySampleInFlight; \}\);/);
    });

    it('wakes the macOS sampler immediately when a workload begins', () => {
        assert.match(macTelemetry, /telemetrySampleCondition\.wait_for\(stateLock, std::chrono::milliseconds\(500\), \[\] \{\s*return \(telemetryActive && !telemetryStopRequested\) \|\| !keepRunning;\s*\}\);/);
        assert.match(engineMain, /telemetryActive = active;[\s\S]*?#ifdef __APPLE__[\s\S]*?if \(active\) telemetrySampleCondition\.notify_all\(\);/);
    });

    it('prevents the sampler from starting another read while END drains the current one', () => {
        assert.match(macTelemetry, /if \(!telemetryActive \|\| telemetryStopRequested\)/);
        assert.match(macTelemetry, /telemetryActive && !telemetryStopRequested/);
        assert.match(engineMain, /telemetryStopRequested = true;[\s\S]*?wait\(lock, \[\] \{ return !telemetrySampleInFlight; \}\);[\s\S]*?telemetryActive = active;/);
    });

    it('acknowledges macOS END after the sampler finishes and pending rows flush', () => {
        const inFlight = macTelemetry.indexOf('telemetrySampleInFlight = true;');
        const samplerStart = macTelemetry.indexOf('FILE* pipe = popen(');
        const stateLock = macTelemetry.indexOf('std::lock_guard<std::mutex> stateLock(telemetryStateMutex);');
        const sampleRecord = macTelemetry.indexOf('liveSession.recordMetric(');
        assert.ok(inFlight >= 0 && samplerStart > inFlight && stateLock > samplerStart && sampleRecord > stateLock,
            'the sampler marks itself in flight before powermetrics and records before releasing the state lock');
        assert.match(engineMain, /telemetryStopRequested = true;[\s\S]*?telemetrySampleCondition\.wait\(lock, \[\] \{ return !telemetrySampleInFlight; \}\);[\s\S]*?telemetryActive = active;[\s\S]*?tracker\.forceFlush\(\);/);
        const endCallback = ipcListener.indexOf('telemetryStateChanged(active, !begin);');
        const endResponse = ipcListener.indexOf('response = std::string("OK ") + (active ? "COLLECTING" : "IDLE")', endCallback);
        assert.ok(endCallback >= 0 && endResponse > endCallback, 'END response follows the service state callback');
    });

    it('runs the END flush barrier even when another workload keeps telemetry active', () => {
        assert.match(ipcListener, /if \(telemetryStateChanged\) telemetryStateChanged\(active, !begin\);/);
        assert.match(engineMain, /\[&tracker\]\(bool active, bool endMarker\)[\s\S]*?if \(endMarker\)[\s\S]*?telemetrySampleCondition\.wait\(lock, \[\] \{ return !telemetrySampleInFlight; \}\);[\s\S]*?tracker\.forceFlush\(\);/);
    });

    it('uses only the configured powermetrics observation interval for hardware energy', () => {
        assert.match(macTelemetry, /constexpr int powermetricsSampleIntervalMs = 500;/);
        assert.match(macTelemetry, /-i " \+\s*std::to_string\(powermetricsSampleIntervalMs\)/);
        assert.match(macTelemetry, /const double delta_time = hardwareReading\s*\?\s*powermetricsSampleIntervalMs \/ 1000\.0\s*:\s*0\.0/);
        assert.doesNotMatch(macTelemetry, /duration<double>\(sampleAt - lastSampleAt\)/,
            'idle time between polls is not part of a hardware observation');
    });
});
