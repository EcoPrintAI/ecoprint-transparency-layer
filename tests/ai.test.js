import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_GUARDRAILS,
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_OLLAMA_MODEL,
    buildAIContext,
    buildOpenAIRequest,
    buildOllamaRequest,
    createAIProvider,
    createOpenAIProvider,
    createOllamaProvider,
    deriveAIUsageMetrics,
    explainWithProvider,
    normalizeAIUsage,
    validateAIExplanation,
} from '../src/transparency/ai.js';

describe('AI interpretation provider', () => {
    it('separates authoritative current facts from historical cases and nulls unsupported no-telemetry measurements', () => {
        const sourceFacts = {
            telemetry_observation_count: 0,
            execution: { duration_ms: 120 },
            measurement: { duration_ms: 120, average_power_watts: 0, energy_wh: 0, carbon_gco2e: 0, water_liters: 0 },
            measured_observations: [],
            baseline: { metrics: {
                duration_ms: { current: 120, baseline: 100, absolute_delta: 20, percent_change: 20 },
                energy_wh: { current: 0, baseline: 0.01, absolute_delta: -0.01, percent_change: -100 },
            } },
            experience_memory: {
                status: 'historical-experience-available',
                cases: [{ run_id: 'prior-run', measured_facts: { energy_wh: 0.01 }, ai_interpretation: { text: 'Prior hypothesis' } }],
            },
        };
        const context = buildAIContext({
            facts: sourceFacts,
            insights: { OBSERVED: ['Energy decreased by 0.01 Wh.', 'Duration increased by 20 ms.'], EVIDENCE: [] },
        });
        assert.equal(sourceFacts.measurement.energy_wh, 0, 'the deterministic result is not mutated');
        const current = context.facts.current_run_facts;
        assert.equal(current.measurement.duration_ms, 120);
        assert.equal(current.measurement.average_power_watts, null);
        assert.equal(current.measurement.energy_wh, null);
        assert.equal(current.measurement.carbon_gco2e, null);
        assert.equal(current.measurement.water_liters, null);
        assert.equal(current.baseline.metrics.duration_ms.absolute_delta, 20);
        assert.equal(current.baseline.metrics.energy_wh.absolute_delta, null);
        assert.equal(context.insights.OBSERVED.length, 1);
        assert.match(context.insights.OBSERVED[0], /^Duration/);
        assert.equal(context.facts.historical_experience_not_current_measurements.cases[0].run_id, 'prior-run');
        assert.equal(context.facts.current_run_facts.experience_memory, undefined);
        assert.match(AI_GUARDRAILS, /Never report a historical value.*as belonging to the current run/);
        assert.match(AI_GUARDRAILS, /When current telemetry_observation_count is zero/);
    });

    it('withholds obvious physical, duration, and token contradictions', () => {
        const noTelemetry = { current_run_facts: {
            telemetry_observation_count: 0,
            execution: { duration_ms: 120 },
            measurement: { duration_ms: 120 },
            baseline: { metrics: { duration_ms: { absolute_delta: 20, percent_change: 20 } } },
        } };
        assert.equal(validateAIExplanation({
            explanation: 'The current CPU averaged 8 W and current energy increased to 0.02 Wh.',
            facts: noTelemetry,
        }).valid, false);
        assert.equal(validateAIExplanation({
            explanation: 'Physical telemetry for this run is unavailable. Historically, the prior run measured CPU power at 8 W.',
            facts: noTelemetry,
        }).valid, true);
        assert.equal(validateAIExplanation({
            explanation: 'Power and energy were higher than baseline.', facts: noTelemetry,
        }).valid, false, 'a baseline label alone cannot make an unsupported current physical delta safe');
        assert.match(validateAIExplanation({
            explanation: 'The current run completed in 1.2 seconds.', facts: noTelemetry,
        }).reason, /duration/);
        assert.match(validateAIExplanation({
            explanation: 'The run was 3.43% faster than baseline.', facts: noTelemetry,
        }).reason, /duration comparison/);
        assert.match(validateAIExplanation({
            explanation: 'Current duration was 120 ms. Current AI usage: input tokens 999, output tokens 4, total tokens 1003.',
            facts: noTelemetry,
            providerUsage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }).reason, /token usage/);
        assert.equal(validateAIExplanation({
            explanation: 'Current duration was 120 ms. Current AI usage: input tokens 10, output tokens 4, total tokens 14.',
            facts: noTelemetry,
            providerUsage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }).valid, true);
    });

    it('builds a Responses API request with unchanged structured evidence and guardrails', async () => {
        const facts = {
            measurement: { average_power_watts: 12.5, energy_wh: null },
            measured_observations: [{ interval_seconds: 0.5, measurement_source: 'hardware' }],
            experience_memory: { status: 'novel-pattern-no-prior-cases', cases: [] },
        };
        const insights = { OBSERVED: ['Power increased by 2 W.'], EVIDENCE: ['Two samples.'] };
        const requestInput = { facts, insights, instruction: AI_GUARDRAILS };
        assert.deepEqual(buildOpenAIRequest({ ...requestInput, model: 'test-model' }), {
            model: 'test-model', instructions: AI_GUARDRAILS,
            input: JSON.stringify({ facts, deterministic_insights: insights }), store: false,
        });

        let request;
        const provider = createOpenAIProvider({
            apiKey: 'test-only-token', model: 'test-model',
            fetchImpl: async (url, options) => {
                request = { url, options };
                return { ok: true, json: async () => ({
                    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Evidence based explanation.' }] }],
                }) };
            },
        });
        const explanation = await explainWithProvider({ facts, insights, provider });

        assert.equal(explanation, 'Evidence based explanation.');
        assert.equal(request.url, 'https://api.openai.com/v1/responses');
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.headers.Authorization, 'Bearer test-only-token');
        assert.equal(request.options.headers['Content-Type'], 'application/json');
        const body = JSON.parse(request.options.body);
        assert.equal(body.model, 'test-model');
        assert.equal(body.instructions, AI_GUARDRAILS);
        assert.equal(body.store, false);
        assert.deepEqual(JSON.parse(body.input), { facts, deterministic_insights: insights });
    });

    it('does not rewrite facts passed through the provider contract and includes interpretation guardrails', async () => {
        const facts = Object.freeze({ measurement: Object.freeze({ water_liters: null }), provenance: [] });
        const insights = Object.freeze({ OBSERVED: [], EVIDENCE: ['measurement unavailable'] });
        let received;
        await explainWithProvider({ facts, insights, provider: {
            async explain(args) {
                received = args;
                return 'No measured water value was available.';
            },
        } });
        assert.deepEqual(received.facts, facts);
        assert.deepEqual(received.insights, insights);
        for (const phrase of [
            'Never invent, estimate, fill in, or override a measurement or unavailable value.',
            'does not establish causal effects',
            'never equate them with physical energy',
            'Historical cases are prior evidence only',
            'not independent process measurements',
        ]) assert.ok(received.instruction.toLowerCase().includes(phrase.toLowerCase()));
    });

    it('reports API failures without echoing provider response bodies', async () => {
        const provider = createOpenAIProvider({ apiKey: 'test-only-token', fetchImpl: async () => ({
            ok: false, status: 429, text: async () => 'sensitive upstream body',
        }) });
        await assert.rejects(provider.explain({ facts: {}, insights: {}, instruction: AI_GUARDRAILS }),
            error => error.message === 'OpenAI Responses API request failed (HTTP 429)'
                && !error.message.includes('sensitive upstream body'));
    });

    it('rejects empty API responses and missing API credentials', async () => {
        const emptyProvider = createOpenAIProvider({ apiKey: 'test-only-token', fetchImpl: async () => ({
            ok: true, json: async () => ({ output: [] }),
        }) });
        await assert.rejects(explainWithProvider({ facts: {}, insights: {}, provider: emptyProvider }), /empty explanation/);

        const unconfigured = createOpenAIProvider({ apiKey: '', fetchImpl: async () => assert.fail('fetch should not run') });
        await assert.rejects(unconfigured.explain({ facts: {}, insights: {}, instruction: AI_GUARDRAILS }),
            error => error.code === 'AI_CONFIGURATION' && /OPENAI_API_KEY/.test(error.message));
    });

    it('constructs Ollama chat requests with the same structured provider contract', async () => {
        const facts = { measurement: { average_power_watts: 11 }, measured_observations: [{ total_power_watts: 11 }] };
        const insights = { OBSERVED: ['Average power was 11 W.'] };
        assert.deepEqual(buildOllamaRequest({ facts, insights, instruction: 'guardrails', model: 'test:small' }), {
            model: 'test:small',
            messages: [
                { role: 'system', content: 'guardrails' },
                { role: 'user', content: JSON.stringify({ facts, deterministic_insights: insights }) },
            ],
            stream: false,
        });

        let request;
        const provider = createOllamaProvider({
            baseUrl: 'http://127.0.0.1:11435/api/', model: 'test:small',
            fetchImpl: async (url, options) => {
                request = { url, options };
                return ollamaResponse({
                    model: 'test:small', message: { role: 'assistant', content: 'Explanation from local model.' },
                    prompt_eval_count: 23, eval_count: 9, total_duration: 25_000_000,
                    id: 'ollama-request-123',
                });
            },
        });
        const result = await explainWithProvider({ facts, insights, provider });
        assert.equal(result, 'Explanation from local model.');
        assert.equal(request.url, 'http://127.0.0.1:11435/api/chat');
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(request.options.body), buildOllamaRequest({ facts, insights, instruction: AI_GUARDRAILS, model: 'test:small' }));
        assert.equal(provider.usageMetadata.provider, 'ollama');
        assert.equal(provider.usageMetadata.model, 'test:small');
        assert.equal(provider.usageMetadata.input_tokens, 23);
        assert.equal(provider.usageMetadata.output_tokens, 9);
        assert.equal(provider.usageMetadata.total_tokens, null,
            'provider extraction leaves total-token policy to the shared normalizer');
        assert.equal(provider.usageMetadata.inference_latency_ms, 25);
        assert.equal(provider.usageMetadata.request_id, 'ollama-request-123');
        assert.ok(provider.usageMetadata.local_request_latency_ms >= 0);

        const normalized = normalizeAIUsage(provider.usageMetadata, {
            identity: { workload_id: 'w-1', run_id: 'r-1', attempt_id: 'a-1', attempt_no: 2 },
            recordedAt: '2026-09-27T12:00:00.000Z',
        });
        assert.deepEqual({
            schema_version: normalized.schema_version,
            signal_type: normalized.signal_type,
            provider: normalized.provider,
            model: normalized.model,
            input_tokens: normalized.input_tokens,
            output_tokens: normalized.output_tokens,
            total_tokens: normalized.total_tokens,
            inference_latency_ms: normalized.inference_latency_ms,
            request_id: normalized.request_id,
            workload_id: normalized.workload_id,
            run_id: normalized.run_id,
            attempt_id: normalized.attempt_id,
            attempt_no: normalized.attempt_no,
            recorded_at: normalized.recorded_at,
            physical_correlation: normalized.physical_correlation,
        }, {
            schema_version: 1, signal_type: 'logical_ai_usage', provider: 'ollama', model: 'test:small',
            input_tokens: 23, output_tokens: 9, total_tokens: 32, inference_latency_ms: 25,
            request_id: 'ollama-request-123', workload_id: 'w-1', run_id: 'r-1', attempt_id: 'a-1',
            attempt_no: 2, recorded_at: '2026-09-27T12:00:00.000Z', physical_correlation: 'not-established',
        });
        assert.deepEqual(normalized.derived_metrics, {
            tokens_per_wh: null, wh_per_1k_tokens: null,
            carbon_gco2e_per_1k_tokens: null, water_liters_per_1k_tokens: null,
            status: 'unavailable', reason: 'no validated SigSense measurement for this inference window',
        });
    });

    it('uses OLLAMA model/base URL configuration and defaults to llama3.2:3b locally', async () => {
        const previousBase = process.env.OLLAMA_BASE_URL;
        const previousModel = process.env.OLLAMA_MODEL;
        try {
            delete process.env.OLLAMA_BASE_URL;
            delete process.env.OLLAMA_MODEL;
            const defaults = createAIProvider({ provider: 'ollama', fetchImpl: async () => ollamaResponse({
                model: DEFAULT_OLLAMA_MODEL, message: { content: 'ok' },
            }) });
            assert.equal(DEFAULT_OLLAMA_BASE_URL, 'http://localhost:11434/api');
            assert.equal(defaults.model, 'llama3.2:3b');
            await defaults.explain({ facts: {}, insights: {}, instruction: 'test' });

            process.env.OLLAMA_BASE_URL = 'http://localhost:11436/custom/api';
            process.env.OLLAMA_MODEL = 'override:1b';
            let requestUrl;
            const configured = createAIProvider({ provider: 'ollama', fetchImpl: async url => {
                requestUrl = url;
                return ollamaResponse({ model: 'override:1b', message: { content: 'ok' } });
            } });
            assert.equal(configured.model, 'override:1b');
            await configured.explain({ facts: {}, insights: {}, instruction: 'test' });
            assert.equal(requestUrl, 'http://localhost:11436/custom/api/chat');
        } finally {
            if (previousBase === undefined) delete process.env.OLLAMA_BASE_URL;
            else process.env.OLLAMA_BASE_URL = previousBase;
            if (previousModel === undefined) delete process.env.OLLAMA_MODEL;
            else process.env.OLLAMA_MODEL = previousModel;
        }
    });

    it('preserves unavailable usage fields instead of filling them with zero', async () => {
        const provider = createOllamaProvider({ fetchImpl: async () => ollamaResponse({ message: { content: 'No usage data.' } }) });
        await provider.explain({ facts: {}, insights: {}, instruction: 'test' });
        const normalized = normalizeAIUsage(provider.usageMetadata);
        assert.deepEqual({
            provider: normalized.provider,
            model: normalized.model,
            input_tokens: normalized.input_tokens,
            output_tokens: normalized.output_tokens,
            total_tokens: normalized.total_tokens,
            inference_latency_ms: normalized.inference_latency_ms,
            request_id: normalized.request_id,
        }, {
            provider: 'ollama', model: null, input_tokens: null, output_tokens: null,
            total_tokens: null, inference_latency_ms: null, request_id: null,
        });
        assert.ok(provider.usageMetadata.local_request_latency_ms >= 0);
    });

    it('returns a clean unavailable error for a stopped Ollama server without leaking request details', async () => {
        const provider = createOllamaProvider({ baseUrl: 'http://user:secret@localhost:11434/api', fetchImpl: async () => {
            throw new Error('fetch failed for http://user:secret@localhost:11434/api/chat');
        } });
        await assert.rejects(provider.explain({ facts: {}, insights: {}, instruction: 'test' }), error => {
            assert.equal(error.code, 'AI_PROVIDER_UNAVAILABLE');
            assert.match(error.message, /Ollama is unavailable/);
            assert.doesNotMatch(error.message, /secret|localhost/);
            return true;
        });
        assert.equal(provider.usageMetadata.provider, 'ollama');
        assert.equal(provider.usageMetadata.input_tokens, null);
        assert.ok(provider.usageMetadata.local_request_latency_ms >= 0);
    });

    it('selects one provider and keeps OpenAI selection working', async () => {
        const previousKey = process.env.OPENAI_API_KEY;
        try {
            process.env.OPENAI_API_KEY = 'test-only-token';
            const provider = createAIProvider({ provider: 'openai', fetchImpl: async () => ({
                ok: true,
                json: async () => ({
                    id: 'resp_123', model: 'test-openai',
                    output_text: 'OpenAI remains available.',
                    usage: { input_tokens: 14, output_tokens: 6, total_tokens: 20 },
                }),
            }) });
            assert.equal(provider.name, 'openai-responses');
            assert.equal(await provider.explain({ facts: {}, insights: {}, instruction: 'test' }), 'OpenAI remains available.');
            assert.deepEqual({
                provider: provider.usageMetadata.provider,
                model: provider.usageMetadata.model,
                input_tokens: provider.usageMetadata.input_tokens,
                output_tokens: provider.usageMetadata.output_tokens,
                total_tokens: provider.usageMetadata.total_tokens,
                request_id: provider.usageMetadata.request_id,
            }, {
                provider: 'openai', model: 'test-openai', input_tokens: 14,
                output_tokens: 6, total_tokens: 20, request_id: 'resp_123',
            });
            assert.equal(createAIProvider({ provider: 'ollama' }).name, 'ollama');
            const unsupported = createAIProvider({ provider: 'other' });
            await assert.rejects(unsupported.explain({}), /ECOPRINT_AI_PROVIDER/);
        } finally {
            if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previousKey;
        }
    });

    it('normalizes OpenAI usage into the same identity-correlated event as Ollama', async () => {
        const normalized = normalizeAIUsage({
            provider: 'openai', model: 'model-response', input_tokens: 16, output_tokens: 7,
            total_tokens: 25, inference_latency_ms: null, local_request_latency_ms: 3,
            request_id: 'resp_1',
        }, { identity: { workload_id: 'w', run_id: 'r', attempt_id: 'a', attempt_no: 1 }, recordedAt: '2026-01-01T00:00:00Z' });
        assert.equal(normalized.signal_type, 'logical_ai_usage');
        assert.equal(normalized.total_tokens, 25, 'preserve a provider-reported total when present');
        assert.equal(normalized.run_id, 'r');
        assert.equal(normalized.attempt_id, 'a');

        const derivedTotal = normalizeAIUsage({ provider: 'openai', input_tokens: 16, output_tokens: 7 });
        assert.equal(derivedTotal.total_tokens, 23);
        assert.equal(derivedTotal.model, null);
        assert.equal(derivedTotal.request_id, null);
    });

    it('does not fabricate token counts and gates intensity metrics on the same local inference interval', () => {
        const unavailable = normalizeAIUsage({ provider: 'ollama', input_tokens: '20', output_tokens: undefined });
        assert.equal(unavailable.input_tokens, null);
        assert.equal(unavailable.output_tokens, null);
        assert.equal(unavailable.total_tokens, null);

        const logicalTokensOnly = {
            provider: 'ollama', total_tokens: 1000,
            workload_id: 'w', run_id: 'r', attempt_id: 'a',
            request_started_at: '2026-01-01T00:00:01.000Z',
            request_completed_at: '2026-01-01T00:00:02.000Z',
        };
        const window = {
            source: 'sigsense', correlation_status: 'validated-same-inference-window',
            workload_id: 'w', run_id: 'r', attempt_id: 'a',
            started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:03.000Z',
            energy_wh: 0.25, carbon_gco2e: 0.05, water_liters: 0.01,
        };
        assert.equal(deriveAIUsageMetrics(logicalTokensOnly, {
            source: 'sigsense', correlation_status: 'workload-window-only', energy_wh: 0.25,
        }).tokens_per_wh, null);

        const correlated = deriveAIUsageMetrics(logicalTokensOnly, window);
        assert.deepEqual(correlated, {
            tokens_per_wh: 4000, wh_per_1k_tokens: 0.25,
            carbon_gco2e_per_1k_tokens: 0.05, water_liters_per_1k_tokens: 0.01,
            status: 'available', reason: null,
        });
        assert.equal(deriveAIUsageMetrics(logicalTokensOnly, {
            ...window, energy_wh: 0,
        }).tokens_per_wh, null, 'zero energy cannot be used as a denominator');
        assert.equal(deriveAIUsageMetrics({ ...logicalTokensOnly, provider: 'openai' }, window).status, 'unavailable');
        assert.equal(deriveAIUsageMetrics(logicalTokensOnly, {
            ...window, attempt_id: 'different-attempt',
        }).status, 'unavailable');
        assert.equal(deriveAIUsageMetrics(logicalTokensOnly, {
            ...window, ended_at: '2026-01-01T00:00:01.500Z',
        }).status, 'unavailable');
    });
});

function ollamaResponse(payload, options = {}) {
    return { ok: true, json: async () => payload, ...options };
}
