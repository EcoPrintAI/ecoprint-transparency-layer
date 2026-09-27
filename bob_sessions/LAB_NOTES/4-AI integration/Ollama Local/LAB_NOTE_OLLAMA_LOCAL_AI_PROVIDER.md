# LAB NOTE — Local AI (Ollama) Provider & AI Usage Metadata

## Purpose

Document the addition and first live demonstration of Ollama as a local AI provider for EcoPrint Transparency, along with the AI usage metadata now exposed by the AI layer.

Core architecture:

```text
SigSense / deterministic accounting
            ↓
      structured facts
            ↓
       AI provider
        ↙       ↘
   OpenAI       Ollama
   cloud        local
```

## 1. Why Ollama Was Added

EcoPrint's mission includes measuring AI and digital-infrastructure resource use. A local AI provider creates a second path for experimentation:

- cloud LLM inference through OpenAI;
- local LLM inference through Ollama.

EcoPrint does not assume that local inference is automatically more energy-efficient or lower-emission. That is an empirical question for measurement.

One provider is selected per run:

```text
ECOPRINT_AI=1
ECOPRINT_AI_PROVIDER=openai
```

or:

```text
ECOPRINT_AI=1
ECOPRINT_AI_PROVIDER=ollama
```

The same deterministic facts and AI guardrails are used for either provider.

## 2. Ollama Installation

Ollama was installed locally on macOS.

Installed version:

```text
ollama 0.34.4
```

The local model was downloaded:

```text
llama3.2:3b
```

Model size:

```text
2.0 GB
```

The Ollama local API was verified as reachable before the model-backed run.

No cloud API key is required for the Ollama path.

## 3. Provider Integration

Ollama was implemented behind the existing:

```text
provider.explain({ facts, insights, instruction })
```

contract.

The provider keeps logical AI metadata separate from physical SigSense measurements.

Logical AI metadata can include:

- provider;
- model;
- input tokens;
- output tokens;
- total tokens;
- provider-reported inference duration;
- local request latency;
- request ID when available.

Physical measurements remain:

- CPU/GPU/ANE power;
- total power;
- energy;
- carbon;
- water;
- deterministic attribution.

These categories are intentionally not conflated.

## 4. First Live Ollama EcoPrint Run

Command:

```bash
ECOPRINT_AI=1 ECOPRINT_AI_PROVIDER=ollama node bin/ecoprint.js run --name ollama-ai-demo -- sh -c 'npm test && npm test'
```

The real test workload completed successfully.

### Software validation

```text
261 tests
59 suites
261 passed
0 failed
```

### EcoPrint physical measurement

```text
Workload:               ollama-ai-demo
Duration:               1.72 s
Measurement:            hardware
Grid:                   live
Telemetry observations: 1
CPU average power:      8.915 W
GPU average power:      0.054 W
ANE average power:      0.000 W
Total average power:    8.968 W
Total energy:           0.00124556 Wh
Carbon:                 0.0005854111 gCO2e
Water:                   0.000002391467 L
Attribution coverage:   100%
Lineage coverage:        100%
Measurement efficiency: 99.56%
```

Client/EcoPrint environmental values remain explicitly identified as deterministic allocations from the observed total by power share.

## 5. Local AI Result

The terminal produced a real AI explanation using:

```text
Provider: Ollama
Model: llama3.2:3b
Prior cases available: 2
```

The local model produced a shorter explanation than the earlier OpenAI response while still incorporating workload facts, historical experience, baseline information, component changes, attribution/provenance context, and causality limitations.

The first live Ollama result also exposed a final-polish issue: the model can repeat contextual information from retrieved prior cases in a way that is not always perfectly aligned with the current report's presentation. This is an AI-prompt/output-formatting issue, not a measurement issue.

## 6. AI Usage Metadata Captured

The Ollama response provided real logical AI usage metadata:

```text
Input tokens:        2050
Output tokens:        377
Total tokens:        2427
Inference latency:   27916.7 ms
Local request:       28035.3 ms
Request ID:          unavailable
```

These values describe provider execution.

They are not energy, carbon, or water measurements.

```text
tokens + inference latency ≠ physical energy
```

Physical energy remains sourced from SigSense hardware telemetry.

## 7. Important Measurement Boundary

The current CLI does not yet bracket the Ollama inference itself with a dedicated SigSense measurement window.

Therefore this milestone does not claim:

- energy consumed by Ollama inference;
- carbon from Ollama inference;
- water attributable specifically to Ollama inference;
- energy per token.

What has been demonstrated:

1. EcoPrint measures a real developer workload.
2. EcoPrint can invoke a local LLM as its interpretation provider.
3. EcoPrint captures local provider token and timing metadata.
4. Logical AI metadata can coexist with physical SigSense telemetry without being conflated.

A future measurement path can explicitly bracket local AI inference and combine:

```text
AI request metadata
+
SigSense physical telemetry
+
workload identity
+
provenance
```

to derive metrics such as energy per 1K tokens when both inputs are defensibly available.

## 8. Relationship to Experience Memory

The run reported:

```text
Prior cases: 2 (historical-experience-available)
```

This confirms that the local provider participates in the same case-based experience architecture already implemented for the cloud provider.

Future runs can use relevant historical cases regardless of whether interpretation is performed by OpenAI or Ollama.

Historical AI interpretations remain contextual evidence. They do not become measurements and cannot overwrite current deterministic facts.

## 9. Architectural Result

```text
                   Deterministic EcoPrint
                           │
                   structured evidence
                           │
                    AI provider contract
                     /               \
                    /                 \
             OpenAI API             Ollama
               cloud                 local
                    \                 /
                     \               /
                      AI explanation
                           │
                    Experience Memory
```

This provides a cloud/local choice without changing the deterministic measurement core.

## 10. What This Demonstrates

EcoPrint can combine:

```text
Logical workload identity
        ↓
Process provenance
        ↓
Physical hardware telemetry
        ↓
Deterministic attribution/accounting
        ↓
AI provider
        ↓
Token + latency metadata
        ↓
Historical experience
        ↓
Developer-facing explanation
```

The AI is an interpretation layer connected to measured infrastructure context, not the source of measurement truth.

## 11. Evidence Screenshots

Recommended labels:

### 0 — Ollama-Enabled Transparency Run — Workload Execution

### 1 — Live Hardware Telemetry, Energy & Environmental Accounting

### 2 — Deterministic Attribution, Provenance & Evidence

### 3 — Ollama AI Interpretation — Evidence-Grounded Analysis

### 4 — Ollama AI Usage — Tokens & Inference Metadata

Together:

```text
Execution → Measurement → Deterministic accounting → Local AI interpretation → AI usage metadata
```

## 12. Remaining Work

The next focused layer is token/request accounting.

The Ollama provider already demonstrates real token counts, so the next step is to make AI usage a first-class workload/run/attempt record and expose derived metrics only when the required physical measurements are actually available.

Potential future derived metrics:

```text
energy per 1K tokens
carbon per 1K tokens
tokens per Wh
latency per request
```

These must never be produced from token counts alone.

## Final Result

The first local AI path is working end-to-end.

EcoPrint can now select:

```text
OpenAI → cloud interpretation
```

or:

```text
Ollama → local interpretation
```

while preserving the same deterministic measurement, attribution, provenance, and experience-memory architecture.

This establishes the foundation for a distinctive future capability:

> Measure the physical footprint of the AI that is itself interpreting EcoPrint measurements.

That requires explicit inference bracketing and physical telemetry correlation, which remains future work rather than a claim of this milestone.
