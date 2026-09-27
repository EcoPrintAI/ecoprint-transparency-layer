# LAB NOTE — AI Interpretation & Case-Based Experience Memory

## Purpose

Document the first implementation and live validation of the EcoPrint Transparency AI layer.

This milestone adds an optional large-language-model interpretation layer and a persistent case-based experience memory system on top of the existing deterministic measurement, attribution, provenance, baseline, and insight systems.

Core rule:

> Deterministic measurement and accounting are the source of truth. AI interprets those facts; it does not create or replace them.

## 1. Starting Point

Before this milestone, EcoPrint Transparency already had:

```text
SigSense hardware telemetry
        ↓
Workload / Run / Attempt identity
        ↓
Process provenance
        ↓
Deterministic attribution
        ↓
Baseline comparison
        ↓
Deterministic insights
        ↓
Human-readable terminal report
```

There was already a small provider adapter in `src/transparency/ai.js`, but there was no real LLM provider and no persistent experience store.

The adapter established the boundary: a provider receives structured facts and deterministic insights and is instructed to explain only the supplied evidence.

## 2. What Was Added

### Real LLM Provider

A real OpenAI provider was implemented behind the existing `provider.explain(...)` contract.

It:
- uses the OpenAI Responses API;
- uses Node's built-in `fetch`, with no SDK dependency;
- reads `OPENAI_API_KEY` from the environment;
- allows `OPENAI_MODEL` to override the default;
- remains optional so deterministic CLI operation works without AI;
- returns the AI explanation into the terminal report.

AI is enabled with:

```text
ECOPRINT_AI=1
```

### AI Guardrails

The AI receives structured evidence rather than direct database access.

It is constrained to:
- explain supplied measured and derived facts;
- distinguish measured values from allocated/derived values;
- avoid inventing measurements or contributors;
- avoid claiming causality when evidence only supports co-occurrence or plausibility;
- preserve unavailable values;
- treat client/EcoPrint environmental splits as allocations, not independent process measurements.

This keeps the architecture:

```text
SigSense + deterministic accounting
            ↓
      structured facts
            ↓
         AI layer
            ↓
    explanation only
```

## 3. Experience Memory / Case-Based Learning

A persistent SQLite experience store was added.

This is not model retraining. The model does not change its weights after every run. Instead, EcoPrint stores prior completed cases and retrieves relevant experience for later runs.

Stored experience can include:
- workload identity/type;
- measured observations;
- deterministic derived facts;
- provenance/context;
- baseline deltas;
- measurement quality;
- AI interpretation;
- confidence/evidence metadata;
- later outcomes/feedback.

The system distinguishes:

```text
MEASURED FACT
DETERMINISTIC DERIVATION
AI INTERPRETATION / HYPOTHESIS
LATER VERIFIED OUTCOME
```

Historical AI interpretations cannot overwrite current measured facts.

Relevant prior cases are retrieved using structured similarity such as workload identity/name/type, component power profiles, baseline deltas, measurement quality, and provenance/context. The first implementation can supply up to three prior cases.

This creates an experience loop:

```text
Run → Measure → Attribute → Interpret → Store case
                                    ↓
Future run → Retrieve similar cases → Interpret with context
```

## 4. Deterministic Insights vs. AI

The deterministic `insights.js` layer is rule-based. It selects and constructs evidence-bound statements based on programmed conditions, such as missing telemetry, changed components, measurement quality, and baseline comparability.

The AI layer is different:

```text
Deterministic:
"Given these conditions, produce this evidence-bound statement."

AI:
"Given this complete structured evidence set, explain what it means,
what changed, what relationships are plausible, and what should be
investigated next — without exceeding the evidence."
```

This is the transition from a finite rule system to a real language-model interpretation layer.

## 5. First Live AI Validation

The first live API-backed EcoPrint run was:

```bash
ECOPRINT_AI=1 node bin/ecoprint.js run --name ai-layer-live-demo -- sh -c 'npm test && npm test'
```

The real workload completed successfully.

### Deterministic measurement

```text
Duration:              1.63 s
Measurement:           hardware
Grid:                  live
Telemetry observations: 1
Average/peak power:    9.75 W
Total energy:          0.00135417 Wh
Carbon:                0.0006283333 gCO2e
Water:                  0.0000026 L
Attribution coverage:  100%
Lineage coverage:       100%
Measurement efficiency: 99.50%
```

The workload test suite reported:

```text
255 tests
59 suites
255 passed
0 failed
```

### Self-measurement accounting

The run reported approximately:

```text
Client energy:    0.00135 Wh
EcoPrint energy:  0.00000676 Wh
```

The report explicitly states that client/EcoPrint environmental values are allocated from the observed total by power share.

## 6. Actual AI Interpretation

The terminal report included:

```text
AI EXPLANATION
Prior cases: 1 (historical-experience-available)
```

The AI then synthesized:
- workload and execution facts;
- hardware component measurements;
- energy/carbon/water;
- attribution and provenance;
- baseline deltas;
- measurement quality;
- historical experience.

It described the client/EcoPrint split as a deterministic proportional-to-power allocation rather than independent direct process-energy measurement.

It compared the current run with the previous comparable run, including:
- shorter duration;
- higher average and peak power;
- higher total energy;
- higher CPU energy;
- higher GPU activity;
- lower EcoPrint allocated overhead;
- increased carbon and water.

It identified higher CPU activity as a plausible contributor while explicitly avoiding a causal claim.

It recommended additional repeated runs and investigation of CPU/GPU activity.

This demonstrates that the model is synthesizing multiple structured evidence fields rather than merely selecting a hard-coded deterministic sentence.

## 7. API Access / Cost Discovery

The first API invocation returned:

```text
OpenAI Responses API request failed (HTTP 429)
```

The API account initially had no usable API quota/credits configured.

API access was then funded so the live demonstration could proceed.

The API key is kept outside source control and was never included in the repository, terminal evidence, or lab note.

## 8. Ollama / Local AI Path

Ollama was installed locally:

```text
ollama-app was successfully installed!
ollama 0.34.4
```

At this milestone, Ollama was installed but not yet integrated as an EcoPrint provider.

The provider abstraction allows the intended structure:

```text
EcoPrint AI provider contract
        │
        ├── OpenAI / cloud LLM
        │
        └── Ollama / local LLM
```

A future local provider can enable offline/local interpretation and makes it possible to measure the physical footprint of the AI inference itself through SigSense.

## 9. Token / Model Usage Expansion

A major follow-on capability is AI request metadata and token accounting.

For AI workloads, the eventual logical context should include:

```text
AI request
 ├── model/provider
 ├── input tokens
 ├── output tokens
 ├── total tokens
 ├── latency
 ├── workload/run/attempt identity
 ├── process provenance
 └── physical hardware telemetry
```

This can support derived metrics such as:

```text
energy per 1K tokens
carbon per 1K tokens
latency per 1K tokens
energy per request
```

Tokens are additional logical attribution/context signals; they do not replace physical hardware telemetry.

## 10. Validation Status

After implementation:

```text
npm test
→ 255 passed
→ 59 suites
→ 0 failures

npm run lint
→ passed

git diff --check
→ passed
```

A real OpenAI-backed run was successfully demonstrated afterward.

## 11. Evidence Screenshots

Use these five screenshot labels:

### 0 — AI-Enabled Transparency Run — Workload Execution

### 1 — Live Hardware Telemetry, Energy & Environmental Accounting

### 2 — Deterministic Baseline Insights & Evidence

### 3 — AI Interpretation — Evidence-Grounded Analysis

### 4 — AI Recommendations — Context-Aware Next Steps

Together they show:

```text
Execution → Measurement → Deterministic reasoning → AI interpretation → AI recommendations
```

## 12. Architecture After This Milestone

```text
                    DEVELOPER WORKLOAD
                           │
                           ▼
                  Workload / Run / Attempt
                           │
                           ▼
                    Process Provenance
                           │
                           ▼
                 ┌─────────────────────┐
                 │      SigSense       │
                 │ hardware telemetry  │
                 └──────────┬──────────┘
                            │
                            ▼
                 Deterministic Metrics
                            │
                 ┌──────────┴──────────┐
                 │                     │
                 ▼                     ▼
            Attribution             Baseline
                 │                     │
                 └──────────┬──────────┘
                            ▼
                  Deterministic Insights
                            │
                            ▼
                     Structured Facts
                            │
                 ┌──────────┴──────────┐
                 │                     │
                 ▼                     ▼
            AI Provider          Experience Memory
                 │                     │
                 └──────────┬──────────┘
                            ▼
                    AI Interpretation
                            │
                            ▼
                 Human Developer Report
```

## 13. Remaining Work

The next engineering opportunities are:

### Local AI provider
Add Ollama behind the same provider contract and validate local inference.

### Token accounting
Capture model/request/token metadata where available and connect it to workload identity and attribution.

### AI self-measurement
Measure the physical resource footprint of local or cloud-assisted AI inference where the underlying infrastructure is observable.

### Richer feedback
Capture verified outcomes so historical AI interpretations can be compared with what actually happened later.

### Broader provenance
Expand process/context visibility for more complex background and multi-tenant environments.

## Final Result

This milestone moves EcoPrint Transparency from:

```text
measure → calculate → apply programmed insight rules
```

to:

```text
measure
   ↓
attribute
   ↓
calculate deterministic facts
   ↓
generate deterministic evidence
   ↓
retrieve prior experience
   ↓
have an LLM interpret the evidence
   ↓
produce context-aware explanations and recommendations
   ↓
store the case for future retrieval
```

The governing boundary remains:

> **EcoPrint measures and calculates the truth. The AI explains and reasons over that truth.**

The first live demonstration confirms that this works end-to-end with real hardware telemetry, baseline data, provenance, deterministic accounting, historical case context, and a real LLM response.
