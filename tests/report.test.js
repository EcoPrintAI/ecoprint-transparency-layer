import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport } from '../src/transparency/report.js';

const metric = (absolute_delta, percent_change) => ({ absolute_delta, percent_change });
function fixture({ baselineComparison = null, telemetryCount = 1, insights = null } = {}) {
    return {
        workload: { name: 'demo', type: 'cli-run', workload_id: 'workload-id' },
        run: { run_id: 'run-id' }, attempt: { attempt_id: 'attempt-id', attempt_no: 1 },
        contextId: 'context-id', command: ['echo', 'demo'], exitCode: 0,
        startedAt: '2026-09-26T10:00:00.000Z', endedAt: '2026-09-26T10:00:01.000Z',
        durationMs: 1001, pid: 123, resourceId: 'host', telemetryCount,
        telemetryError: null, ipcError: null,
        telemetryRows: [{ measurement_source: 'hardware', grid_intensity_source: 'electricity-maps-live' }],
        reconciliation: {
            measured: { power_watts: 3.12, peak_power_watts: 5.41, energy_wh: 0.000119,
                energy_kwh: 0.000000119, carbon_gco2e: 0.000003872, water_liters: 0.0000000087 },
            attributed: { power_watts: 3.12, energy_wh: 0.000119,
                carbon_gco2e: 0.000003872, water_liters: 0.0000000087 },
            unattributed: { power_watts: 0, energy_wh: 0, carbon_gco2e: 0, water_liters: 0 },
            attribution_version: 1,
        },
        runMetrics: { measurement_quality: 'hardware', grid_intensity_quality: 'live', attribution_coverage: 100 },
        baselineComparison, insights,
    };
}

const deltas = (overrides = {}) => ({
    duration_ms: metric(2.5053, 3223.7),
    average_power_watts: metric(-0.00368, -3.2),
    peak_power_watts: metric(2.75, 2151),
    energy_wh: metric(0.00368, 3100),
    carbon_gco2e: metric(0.00000164, 3100),
    water_liters: metric(0.000007, 3100),
    attribution_coverage: metric(0, 0),
    ...overrides,
});

describe('human-readable report formatting', () => {
    it('formats positive, negative, and zero deltas consistently', () => {
        const report = formatReport(fixture({ baselineComparison: { metrics: deltas() } }));
        assert.match(report, /Duration\s+\+2\.51 ms \(\+3224%\)/);
        assert.match(report, /Average Power\s+-0\.00368 W \(-3\.2%\)/);
        assert.match(report, /Attribution\s+0\.0 pp \(unchanged\)/);
        assert.match(report, /Peak Power\s+\+2\.75 W \(\+2151%\)/);

        const zeroDelta = formatReport(fixture({ baselineComparison: {
            metrics: deltas({ peak_power_watts: metric(0, 0) }),
        } }));
        assert.match(zeroDelta, /Peak Power\s+0\.0 W \(0\.0%\)/);
    });

    it('keeps Wh reconciliation cells consistent and displays kWh separately', () => {
        const report = formatReport(fixture());
        const energyRow = report.split('\n').find(line => line.includes('Total Energy (Wh)'));
        assert.ok(energyRow);
        assert.equal((energyRow.match(/Wh/g) ?? []).length, 1);
        assert.match(report, /Total Energy: 0\.000119 Wh \(0\.000000119 kWh\)/);
        assert.match(energyRow, /0\.000119\s+0\.000119\s+0\.00000000/);
        assert.match(report, /Peak Power: 5\.41 W/);
        assert.doesNotMatch(energyRow, /Peak Power/);
    });

    it('retains tiny meaningful energy, carbon, and water values', () => {
        const report = formatReport(fixture());
        assert.match(report, /0\.000119/);
        assert.match(report, /0\.000003872/);
        assert.match(report, /0\.0000000087/);
        assert.doesNotMatch(report, /\b0\.00000000\s+0\.00000000\s+0\.00000000/);
    });

    it('keeps the no-baseline first-run message concise', () => {
        const report = formatReport(fixture({ baselineComparison: null, insights: {
            OBSERVED: ['No previous completed run is available as a baseline.'],
            EVIDENCE: [{ kind: 'current_run', telemetry_count: 1 }],
        } }));
        assert.match(report, /BASELINE\n  None available — this run establishes the baseline\./);
        assert.match(report, /INSIGHT\n  Run this workload again to enable differential analysis\./);
        assert.doesNotMatch(report, /OBSERVED|LIKELY CONTRIBUTOR|EVIDENCE|RECOMMENDATION/);
    });

    it('renders a concise baseline table with explicit changes', () => {
        const report = formatReport(fixture({ baselineComparison: { metrics: deltas() } }));
        assert.match(report, /BASELINE COMPARISON\n[─]+\n  Metric\s+Change/);
        assert.match(report, /Energy\s+\+0\.00368 Wh \(\+3100%\)/);
        assert.match(report, /Carbon\s+\+0\.00000164 gCO2e \(\+3100%\)/);
        assert.match(report, /Water\s+\+0\.000007 L \(\+3100%\)/);
    });

    it('summarizes evidence and never prints JSON blobs in the normal report', () => {
        const insights = {
            OBSERVED: ['Energy (Wh) increased by 0.0037 (3100.0%) versus the baseline.'],
            'LIKELY CONTRIBUTOR': ['Higher average power coincided with higher energy use and is a plausible contributor; this comparison does not isolate cause.'],
            EVIDENCE: [{ kind: 'current_run', telemetry_count: 5, measurement_quality: 'hardware', grid_intensity_quality: 'live' },
                { kind: 'baseline_delta', metric: 'energy_wh', absolute_delta: 0.00368 }],
            RECOMMENDATION: ['Inspect workload activity during the run and compare it with the baseline power profile.'],
        };
        const report = formatReport(fixture({ baselineComparison: { metrics: deltas() }, insights, telemetryCount: 5 }));
        for (const header of ['OBSERVED', 'LIKELY CONTRIBUTOR', 'EVIDENCE', 'RECOMMENDATION']) assert.ok(report.includes(header));
        assert.match(report, /5 hardware telemetry observations/);
        assert.match(report, /100% deterministic attribution/);
        assert.match(report, /live grid intensity/);
        assert.match(report, /Energy: \+0\.00368 Wh \(\+3100%\)/);
        assert.match(report, /not proof of causality/);
        assert.doesNotMatch(report, /\{"kind"|baseline_delta|"metric"/);
    });

    it('shows measurement and grid source in short labels', () => {
        const report = formatReport(fixture());
        assert.match(report, /Measurement: hardware/);
        assert.match(report, /Grid: live/);
    });
});
