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

    it('rejects providers without the contract and empty responses', async () => {
        await assert.rejects(explainWithProvider({ facts: {}, insights: {}, provider: {} }), /implement explain/);
        await assert.rejects(explainWithProvider({ facts: {}, insights: {}, provider: { explain: async () => '' } }), /non-empty/);
    });
});
