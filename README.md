# EcoPrint Transparency

EcoPrint Transparency is a CLI-first prototype for connecting software and AI workload identity to infrastructure telemetry and a reproducible accounting trail. It combines physical or explicitly estimated telemetry with deterministic attribution, process provenance, environmental calculations, baselines, and optional AI interpretation. Its core flow is **Measure → Attribute → Account → Explain**.

Physical telemetry, logical AI usage, and calculated results are separate data: a token count is not a watt-hour, and an allocation is not an independent per-process measurement.

## Why it exists

Developers can identify that a build, test, or AI workload ran without having an easy way to connect it to the infrastructure signals observed at the same time. EcoPrint explores turning infrastructure resource consumption into an observable engineering signal associated with the workloads developers already run.

The economics and infrastructure footprint of a workload can be shaped throughout the software lifecycle—not only after deployment. Choices made during **Ideation → Architecture → Development → Testing → CI/CD → Production**, including model selection, implementation, test strategy, and infrastructure decisions, can affect the resources a workload uses. Bringing measured signals into the engineering workflow can help developers identify resource-intensive or changing workloads and investigate opportunities for efficiency. EcoPrint does not claim that it has already reduced energy use or cost. It is a standalone hackathon prototype, not a production accounting system.

## What it measures

### Physical and infrastructure data

- Total power in watts and integrated energy in Wh/kWh, using the recorded telemetry intervals.
- CPU, GPU, and ANE power and energy when the source provides component readings. The current Apple hardware path uses `powermetrics`; component values remain unavailable when a source does not provide them.
- Carbon dioxide equivalent in gCO2e, calculated using the available grid-intensity value, and water in liters using the configured water factor.
- Sample timestamps, elapsed intervals, measurement source/quality, grid-intensity source, workload/run/attempt identity, and process context.

The available physical source depends on the platform and its permissions. The repository includes a macOS hardware path, Linux RAPL/battery/fallback paths, and a Windows PDH-derived estimate. Estimated and fallback sources are labeled; a software estimate is not presented as a hardware measurement. Electricity Maps can provide live grid intensity when configured and reachable; otherwise the configured fallback is used and identified.

### Logical AI usage

When a provider returns the fields, EcoPrint records its provider and model, input/output/total token counts, inference latency, request latency, and a safe request identifier. Token counts and provider timing are provider-reported logical usage metadata. **They are not physical energy measurements.** The current CLI does not bracket the AI call in its own SigSense measurement window, so it does not claim energy, carbon, or water for inference or energy per token.

## How it works

```text
Developer workload
        ↓
Transparency CLI — workload / run / attempt identity
        ↓
Process provenance and BEGIN / END service markers
        ↓
SigSense physical telemetry ───── optional AI provider usage metadata
        ↓                                      ↓
Read-only telemetry adapter              Separate logical record
        ↓
Deterministic integration, attribution, and accounting
        ↓
Baseline comparison, evidence, and deterministic insights
        ↓
Optional AI interpretation
        ↓
Terminal report
```

SigSense collects telemetry and writes its own SQLite database. Transparency reads that database, correlates rows to a run window, and stores workload identity, context, attribution, run metrics, and experience cases in a separate SQLite database. The AI provider receives selected structured facts and deterministic insights; it does not receive database access and cannot change the measurements or calculations.

### Attribution and shared infrastructure

Attribution is a progression, not a solved physical-isolation problem. The current system tracks workload identity, run identity, attempt identity, process provenance, timing and context, telemetry observations, deterministic attribution, and reconciliation. This gives workload-level accounting a stronger evidence base than aggregate infrastructure measurements alone.

In shared infrastructure, workloads can overlap, and system-level telemetry may not isolate watts to an individual process. **Identity and provenance tell us which workload is associated with an observation; they do not by themselves prove exclusive physical ownership of the measured energy.** The current implementation establishes deterministic context matching and attribution evidence. Deeper multi-tenant physical isolation remains future work. Attribution coverage describes reconciliation under those rules; it must not be read as a percentage of system power physically owned by one workload. Any client/EcoPrint split and related carbon/water values are allocations where the source supports a reconciled split, and are labeled as allocations.

## AI interpretation

AI is optional. Without `ECOPRINT_AI=1`, the CLI uses the same deterministic measurement and reporting path without calling a model. Select one provider per run:

- **OpenAI:** remote inference; requires `OPENAI_API_KEY` and may incur provider usage charges. `OPENAI_MODEL` can select a model.
- **Ollama:** local inference through `http://localhost:11434/api`; no cloud API key is required. `OLLAMA_BASE_URL` and `OLLAMA_MODEL` are configurable; the default model is `llama3.2:3b`.

The prompt asks the model to interpret structured evidence and distinguish measured facts, derived results, and prior cases. Current deterministic facts remain authoritative; historical experience is contextual only and historical measurements cannot fill missing current measurements. AI explanations can be withheld when they contradict current facts or make unsupported physical claims. AI is an interpretation layer, never the source of measurement truth.

The latest live validation demonstrated this safeguard with Ollama: the run had no current SigSense observations, and the model attempted an unsupported physical claim. EcoPrint withheld the generated explanation and preserved the deterministic report. The response validator is intentionally lightweight and bounded; it catches selected contradictions but is not perfect semantic verification. Provider failures also leave the deterministic report available.

Completed runs and relevant prior cases are stored in Transparency's SQLite `experience_cases` table. Experience memory keeps measured observations, deterministic derived facts, AI interpretations, logical usage, and later verified outcomes in separate fields. Retrieval supplies a few similar cases as context; it is case-based retrieval, not model retraining. A prior AI hypothesis is never a current measurement.

## Token usage

Token counts are captured only when the selected provider returns them; EcoPrint does not estimate tokens from text length. A reported total is used when supplied, or calculated from the returned input and output counts when both are available. Missing usage remains unavailable. Future intensity calculations require an explicitly validated SigSense interval covering the same local inference request; token counts alone cannot produce physical footprint metrics.

## Quick start

Requires Node.js 22, npm, and a supported local C++ build toolchain if building SigSense.

```sh
npm install
npm test
npm run lint

# Run a command; it still executes if the measurement service is unavailable.
node bin/ecoprint.js run --name unit-tests -- npm test
```

For local service-backed telemetry, build the engine and install/start the platform service from an administrator terminal:

```sh
cd sigsense/engine && make
cd ../..
node bin/ecoprint.js service install
node bin/ecoprint.js service start
node bin/ecoprint.js run --name project-build -- npm run build
```

Run the service commands in an administrator/elevated terminal; the exact elevation method depends on the operating system.

Service management actions are `install`, `uninstall`, `start`, `stop`, and `status`. See [docs/CLI_SERVICE.md](docs/CLI_SERVICE.md) for platform permissions, paths, and IPC details. The ordinary workload CLI runs as the user. Without usable service telemetry, the workload still runs and the report states that observations are unavailable.

### Optional AI

```sh
# Local Ollama (start Ollama and have the selected model installed first)
ECOPRINT_AI=1 ECOPRINT_AI_PROVIDER=ollama node bin/ecoprint.js run --name local-ai-context -- npm test

# OpenAI (provide the key through the environment, not source code)
export OPENAI_API_KEY="your-key"
ECOPRINT_AI=1 ECOPRINT_AI_PROVIDER=openai node bin/ecoprint.js run --name cloud-ai-context -- npm test
```

See [docs/AI_INTERPRETATION.md](docs/AI_INTERPRETATION.md) for provider configuration, data flow, logical usage metadata, and experience memory.

## Example

The saved macOS Ollama lab run used llama3.2:3b while running npm test twice. It recorded one hardware telemetry observation with live grid intensity. This is a captured demonstration, not a benchmark. The saved run predates the current AI factuality safeguard and is not presented as validated AI output.

```text
WORKLOAD   : ollama-ai-demo (cli-run)
Duration   : 1.72 s
Measurement: hardware
Grid       : live
Observations: 1

POWER
Component  Average (W)  Peak (W)
CPU             8.915      8.915
GPU             0.054      0.054
ANE             0.000      0.000
Total           8.968      8.968

Total Energy: 0.00124556 Wh (0.0000012456 kWh)
Carbon:       0.0005854111 gCO2e
Water:        0.000002391467 L
Attribution Coverage: 100%
Baseline: not available — this run establishes the comparison point.

AI USAGE
Provider: Ollama
Model: llama3.2:3b
Tokens: input 2050, output 377, total 2427
Physical inference footprint: unavailable
```

The report reconciled measured and attributed values using the deterministic attribution rules. The client/EcoPrint split and environmental shares in that run were allocations. [Saved run screenshot](bob_sessions/LAB_NOTES/4-AI%20integration/Ollama%20Local/0-Transparency%20Run.png) · [Lab note](bob_sessions/LAB_NOTES/4-AI%20integration/Ollama%20Local/LAB_NOTE_OLLAMA_LOCAL_AI_PROVIDER.md).

## Measurement integrity

- **Measured:** telemetry values and source labels recorded by SigSense. Source quality can be hardware, estimated, fallback, mixed, or unavailable.
- **Provider-reported:** AI usage fields returned by OpenAI or Ollama. Client request latency is measured by the adapter; provider inference latency is retained only when returned.
- **Derived:** interval-integrated average power and energy, grid-based carbon, configured-factor water, deterministic attribution, baseline deltas, and insights.
- **Unavailable:** a value without required observations, component readings, provider metadata, or a valid comparison remains unavailable in the report. It is not filled in with an invented measurement.

Attribution associates telemetry with workload context under deterministic matching and preserves the reconciliation `measured = attributed + unattributed`. It is evidence of that matching, not proof of process-level physical isolation. Environmental allocations are proportional to reconciled power where possible; otherwise they remain unavailable.

## Validation and project status

The current repository test run completed **266 tests across 59 suites: 266 passed, 0 failed**. `npm run lint` is the repository lint command.

Saved lab evidence records macOS Apple Silicon hardware-path runs, including CPU, GPU, and ANE component telemetry, and a local Ollama-enabled workload. Those demonstrations apply to the tested Mac and configuration; they do not establish equivalent component readings on other platforms. The current CLI does not measure the physical footprint of its own AI interpretation call.

**Implemented:** CLI workload identity and process provenance; telemetry ingestion; time-aware metrics; deterministic attribution/reconciliation; baselines and insights; launchd/systemd/Windows service support; optional OpenAI and Ollama interpretation; SQLite experience memory.

**Demonstrated:** CLI workload runs; recorded macOS hardware telemetry and grid-intensity reporting; Ollama response and logical usage metadata. AI interpretation accuracy and per-inference physical footprint are not established by those demonstrations.

**Future work:** validated inference-window correlation, deeper multi-tenant physical isolation, and stronger validation of model-generated explanations. See [docs/architecture.md](docs/architecture.md) for architecture boundaries.

EcoPrint is exploring a shift from treating infrastructure and resource consumption as something reported after the fact toward treating it as an observable signal inside the engineering workflow.
