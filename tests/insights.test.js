import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveInsights } from '../src/transparency/insights.js';
import { explainWithProvider } from '../src/transparency/ai.js';

describe('deterministic insights', () => {
    it('reports missing observations and does not invent a contributor', () => {
        const insight = deriveInsights({
            currentMetrics: { measurement_quality: 'unavailable', attribution_coverage: 0 },
            telemetryCount: 0,
        });
        assert.match(insight.OBSERVED[0], /No telemetry observations/);
        assert.match(insight['LIKELY CONTRIBUTOR'][0], /No contributor/);
        assert.ok(insight.RECOMMENDATION.some(item => /service/.test(item)));
    });

    it('labels co-occurring duration and energy changes as plausible, not causal', () => {
        const insight = deriveInsights({
            telemetryCount: 8,
            resourceId: 'node-1',
            currentMetrics: { measurement_quality: 'hardware', attribution_coverage: 75 },
            baselineComparison: {
                measurement_quality: 'hardware',
                metrics: {
                    duration_ms: { label: 'Duration (ms)', baseline: 1000, current: 1500, absolute_delta: 500, percent_change: 50 },
                    average_power_watts: { label: 'Average Power (W)', baseline: 10, current: 12, absolute_delta: 2, percent_change: 20 },
                    peak_power_watts: { label: 'Peak Power (W)', baseline: 20, current: 22, absolute_delta: 2, percent_change: 10 },
                    energy_wh: { label: 'Energy (Wh)', baseline: 0.01, current: 0.02, absolute_delta: 0.01, percent_change: 100 },
                    carbon_gco2e: { label: 'Carbon', baseline: 1, current: 2, absolute_delta: 1, percent_change: 100 },
                    water_liters: { label: 'Water', baseline: 1, current: 2, absolute_delta: 1, percent_change: 100 },
                    attribution_coverage: { label: 'Coverage', baseline: 100, current: 75, absolute_delta: -25, percent_change: -25 },
                },
            },
        });
        assert.equal(insight.EVIDENCE.filter(item => item.kind === 'baseline_delta').length, 7);
        assert.ok(insight['LIKELY CONTRIBUTOR'].every(item => /plausible|No contributor/.test(item)));
        assert.ok(insight.RECOMMENDATION.some(item => /unattributed/.test(item)));
        assert.ok(insight['LIKELY CONTRIBUTOR'].every(item => !/caused|causes/.test(item)));
    });

    it('uses component deltas and measured component coverage as evidence', () => {
        const insight = deriveInsights({
            telemetryCount: 6,
            currentMetrics: {
                measurement_quality: 'hardware', grid_intensity_quality: 'live',
                attribution_coverage: 100, component_telemetry_counts: { cpu: 6, gpu: 5, ane: 4 },
                cpu_average_power_watts: 4, gpu_average_power_watts: 2, ane_average_power_watts: 1,
                cpu_energy_wh: 0.02, gpu_energy_wh: 0.01, ane_energy_wh: 0.005,
            },
            baselineComparison: {
                measurement_quality: 'hardware', grid_intensity_quality: 'live',
                metrics: {
                    energy_wh: { label: 'Energy (Wh)', baseline: 0.03, current: 0.04, absolute_delta: 0.01, percent_change: 33.3 },
                    cpu_average_power_watts: { label: 'CPU Average Power (W)', baseline: 3, current: 4, absolute_delta: 1, percent_change: 33.3 },
                    gpu_average_power_watts: { label: 'GPU Average Power (W)', baseline: 3, current: 2, absolute_delta: -1, percent_change: -33.3 },
                    ane_average_power_watts: { label: 'ANE Average Power (W)', baseline: 1, current: 1, absolute_delta: 0, percent_change: 0 },
                    cpu_energy_wh: { label: 'CPU Energy (Wh)', baseline: 0.01, current: 0.02, absolute_delta: 0.01, percent_change: 100 },
                    gpu_energy_wh: { label: 'GPU Energy (Wh)', baseline: 0.012, current: 0.01, absolute_delta: -0.002, percent_change: -16.7 },
                    ane_energy_wh: { label: 'ANE Energy (Wh)', baseline: 0.005, current: 0.005, absolute_delta: 0, percent_change: 0 },
                },
            },
        });
        assert.ok(insight.OBSERVED.some(line => /CPU Average Power increased/.test(line)));
        assert.ok(insight.OBSERVED.some(line => /GPU Average Power decreased/.test(line)));
        assert.ok(insight.OBSERVED.some(line => /ANE Average Power was unchanged/.test(line)));
        assert.ok(insight['LIKELY CONTRIBUTOR'].some(line => /concentrated in CPU energy/.test(line)));
        assert.ok(insight['LIKELY CONTRIBUTOR'].every(line => !/caused|causes/.test(line)));
        const current = insight.EVIDENCE.find(item => item.kind === 'current_run');
        assert.deepEqual(current.component_telemetry_counts, { cpu: 6, gpu: 5, ane: 4 });
        assert.equal(current.attribution_coverage, 100);
        assert.ok(insight.EVIDENCE.some(item => item.kind === 'baseline_delta' && item.metric === 'cpu_energy_wh'
            && item.baseline === 0.01 && item.current === 0.02));
    });

    it('reports client and EcoPrint changes only as coincident measured allocation facts', () => {
        const insight = deriveInsights({
            telemetryCount: 4,
            currentMetrics: { measurement_quality: 'hardware', attribution_coverage: 100,
                allocation_method: 'macos-parser-time-allocation', process_context_count: 3,
                client_workload_energy_wh: 0.08, ecoprint_overhead_energy_wh: 0.02 },
            baselineComparison: { metrics: {
                client_workload_energy_wh: { label: 'Client Energy (Wh)', baseline: 0.04, current: 0.08, absolute_delta: 0.04, percent_change: 100 },
                ecoprint_overhead_energy_wh: { label: 'EcoPrint Energy (Wh)', baseline: 0.02, current: 0.02, absolute_delta: 0, percent_change: 0 },
            } },
            processContexts: [{ classification: 'child-of-client' }],
        });
        assert.ok(insight.OBSERVED.some(line => /Client Energy increased/.test(line)));
        assert.ok(insight.OBSERVED.some(line => /EcoPrint Energy was unchanged/.test(line)));
        assert.ok(insight.EVIDENCE.some(item => item.kind === 'provenance' && item.process_context_count === 3));
        assert.ok(insight['LIKELY CONTRIBUTOR'].every(line => !/caused|causes/.test(line)));
    });

    it('does not produce deltas when methods are incomparable', () => {
        const insight = deriveInsights({
            telemetryCount: 1,
            currentMetrics: { measurement_quality: 'hardware', attribution_coverage: 100 },
            baselineComparison: { metrics: {
                comparison_status: 'incomparable', comparison_reason: 'allocation method differs',
                energy_wh: { absolute_delta: null },
            } },
        });
        assert.ok(insight.OBSERVED.some(line => /incomparable/.test(line)));
        assert.ok(insight.RECOMMENDATION.some(line => /matching measurement source and allocation method/.test(line)));
        assert.equal(insight.EVIDENCE.some(item => item.metric === 'energy_wh'), false);
    });
});

describe('optional AI explanation adapter', () => {
    it('does nothing without a provider and passes structured facts when provided', async () => {
        assert.equal(await explainWithProvider({ facts: {}, insights: {}, provider: null }), null);
        let received;
        const result = await explainWithProvider({
            facts: { energy_wh: 0.25 }, insights: { OBSERVED: ['Energy increased'] },
            provider: { async explain(input) { received = input; return '  Energy was higher.  '; } },
        });
        assert.equal(result, 'Energy was higher.');
        assert.equal(received.facts.energy_wh, 0.25);
        assert.match(received.instruction, /Do not add measurements/);
    });

    it('passes provenance, self-measurement, attribution, and baseline facts without mutation', async () => {
        const facts = { identity: { run: { run_id: 'run-1' } }, process_lineage: [{ classification: 'ecoprint' }],
            self_measurement: { allocation_method: 'fixed-92-8-allocation' }, attribution: { coverage: 90 }, baseline: null };
        let received;
        await explainWithProvider({ facts, insights: {}, provider: { explain: async ({ facts: input }) => { received = input; return 'ok'; } } });
        assert.equal(received.process_lineage[0].classification, 'ecoprint');
        assert.equal(received.self_measurement.allocation_method, 'fixed-92-8-allocation');
        assert.equal(received.attribution.coverage, 90);
        assert.equal(facts.baseline, null);
    });

    it('rejects providers without the contract and empty responses', async () => {
        await assert.rejects(explainWithProvider({ facts: {}, insights: {}, provider: {} }), /implement explain/);
        await assert.rejects(explainWithProvider({ facts: {}, insights: {}, provider: { explain: async () => '' } }), /non-empty/);
    });
});
