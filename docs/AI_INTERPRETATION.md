# Optional AI interpretation and experience memory

EcoPrint's model is an optional explanation layer. Measured telemetry and the deterministic metrics, attribution, baseline, and insight code remain authoritative.

```text
SigSense
   ↓
measured telemetry
   ↓
attribution + provenance + baseline
   ↓
deterministic insights
   ↓
AI interpretation
   ↓
developer explanation / recommendations
```

## Select a provider

The CLI makes no model request unless `ECOPRINT_AI=1` is set. One provider is selected for a run with `ECOPRINT_AI_PROVIDER`; it defaults to `openai` for compatibility. `OPENAI_MODEL` and `OLLAMA_MODEL` are optional overrides.

```sh
# Cloud provider: remote inference, API credentials, and provider usage billing.
export OPENAI_API_KEY="..."
ECOPRINT_AI=1 ECOPRINT_AI_PROVIDER=openai node bin/ecoprint.js run --name openai-ai-demo -- npm test

# Local provider: local inference, no cloud API key required.
export OLLAMA_MODEL="llama3.2:3b" # optional; default for low-memory hosts
ECOPRINT_AI=1 ECOPRINT_AI_PROVIDER=ollama node bin/ecoprint.js run --name ollama-ai-demo -- npm test
```

OpenAI uses Node's built-in `fetch` to call the official Responses API, with `store: false`. Ollama uses built-in `fetch` and its local REST API at `http://localhost:11434/api/chat`; override the base with `OLLAMA_BASE_URL` and the model with `OLLAMA_MODEL`. No SDK or package is required. Ollama's default model is `llama3.2:3b`. The CLI does not create, print, or persist credentials. Cloud requests require `OPENAI_API_KEY` and may incur usage charges; Ollama does not require a cloud API key. Provider/network failures are reported in the AI section without failing the workload or suppressing deterministic output.

## Where the model is called

1. `bin/ecoprint.js` constructs exactly one selected provider only when `ECOPRINT_AI=1`.
2. `src/transparency/cli.js` runs the command, reads SigSense, then calculates metrics, attribution, baseline deltas, provenance facts, and deterministic insights.
3. The CLI retrieves up to three similar prior cases from the Transparency SQLite database.
4. `src/transparency/ai.js` builds a prompt object with separate `current_run_facts` and `historical_experience_not_current_measurements` sections, then sends that context, current deterministic insights, and guardrail instruction to the selected provider: OpenAI's Responses API or Ollama's local `/api/chat` endpoint.
5. The provider returns text only. The CLI cannot use that response to write metrics, alter attribution, or change workload success. `src/transparency/report.js` prints the explanation after deterministic insights.

The model receives selected, normalized observations (timestamps, actual intervals, power fields, and measurement source), derived run metrics and environmental totals, attribution reconciliation, baseline comparison, deterministic insights, and process lineage/context under the current-run section. Historical cases, including their measurements, baselines, prior insights, interpretations, and outcomes, remain in a distinct historical-only section. They may inform comparison, but are never current-run evidence and must be explicitly identified as historical when discussed.

When a current run has no telemetry observations, the AI-only projection sets physical power, component, energy, carbon, water, and attribution-reconciliation values to unavailable; it removes physical baseline deltas and filters physical-change insights. It retains current workload identity/provenance, actual duration, and a valid duration comparison if one exists. The report's deterministic records and measurements are not changed. Current AI usage is marked pending in the prompt because token and provider timing metadata arrive only after inference.

The model does not receive the SigSense database connection or direct database access. This limits it to evidence selected by the deterministic pipeline and keeps raw records and unrelated process arguments out of the request. Workload/run/attempt identifiers and collected process identity fields are included to support provenance interpretation; enable AI only when that metadata may be sent to the configured provider.

The instruction makes current deterministic facts authoritative, says historical values cannot fill current gaps, and requires historical facts to be labeled as historical. It prohibits invented or overridden values, unsupported causal claims, new process claims, and using historical AI hypotheses as facts. Missing values and novel patterns must remain explicit.

Before an explanation is displayed or saved, a small deterministic guard checks for obvious conflicts: positive physical claims on a zero-observation run, stated current duration values or duration-vs-baseline claims that contradict the current facts, and token counts that disagree with provider usage metadata. A conflicting response is withheld; the report then states the current duration and that physical telemetry is unavailable. This is a narrow contradiction check, not semantic proof that every model statement is correct. The deterministic report remains authoritative, and model-generated prose still requires careful interpretation.

### AI usage metadata and physical measurement

Provider token counts are logical AI usage metadata only. EcoPrint does not convert tokens or inference timings into energy. Each successful provider response is normalized as one `logical_ai_usage` event with provider/model/request metadata, provider-reported token counts and inference duration where available, client-measured request latency, and workload/run/attempt IDs. Its capture timestamp and source metadata distinguish provider usage values from client timing. The event is stored in the existing `experience_cases.ai_usage_json` field, so it remains correlated through the existing Transparency database without a second persistence system. Prior normalized usage can appear in retrieved experience context. The current request's usage is only returned after inference, so it cannot be included in that same request's prompt.

The report displays logical usage separately from SigSense measurements. Missing provider fields stay unavailable, not zero. The selected provider call is not currently bracketed by its own SigSense execution window, so the report does not claim to measure the physical footprint of the model call. Intensity metrics such as tokens/Wh, Wh/1k tokens, carbon/1k tokens, and water/1k tokens remain unavailable unless a validated SigSense measurement covers that same inference window. Because Ollama runs on the local host, SigSense may be able to observe its hardware activity in a future measurement path; the current run does not establish that correlation.

## Experience memory (case-based learning)

Completed runs are stored in the existing Transparency database's `experience_cases` table, including runs without AI enabled. The record keeps separate JSON fields for:

- **Measured facts:** normalized power observations with their timestamps, actual intervals, and source labels.
- **Deterministic derived facts:** metrics, environmental calculations, attribution reconciliation, baseline comparison, deterministic insights, and evidence metadata.
- **Process provenance:** the process lineage/context captured for that run.
- **AI interpretation:** provider/model, text, and an unverified or low-confidence status with no fabricated numeric confidence.
- **Logical AI usage:** a separate normalized event with provider token/timing data and workload/run/attempt correlation, when the provider returns usage metadata.
- **Verified outcome:** optional later feedback, marked verified only when a caller explicitly supplies `verified: true`.

On an AI-enabled run, retrieval ranks up to 100 recent cases deterministically using workload name/type, component power profile, measurement quality, provenance classifications, and component baseline deltas; the top three relevant cases are sent as context. The match score and reasons are evidence about similarity, not proof. Historical measured and derived fields stay separately labeled from AI text; an old interpretation cannot update the current run's facts. If no case matches, the prompt labels the run as a novel pattern. Missing memory never blocks interpretation.

The public functions `saveExperienceCase`, `retrieveRelevantExperiences`, and `recordExperienceOutcome` in `src/transparency/experience.js` support later applications and operator-feedback flows. This first version is local SQLite case retrieval, not retraining and not a semantic embedding system. A later EcoPrint version could add richer search and verified-outcome analysis without changing the source-of-truth boundary.
