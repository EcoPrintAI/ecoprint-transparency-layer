# EcoPrint Transparency — Technical Architecture

## Purpose

EcoPrint Transparency is a standalone hackathon prototype designed to
connect software-development workflow activity with infrastructure
measurements and produce useful developer-facing insight.

## Core Workflow

Developer
→ GitHub
→ CI/CD workflow
→ Transparency CLI
→ Measurement
→ Analysis
→ Developer insight

## MVP Components

### 1. CLI
Primary developer interface for running measurements and viewing results.

### 2. Workflow Integration
Captures relevant build, test, and deployment execution context.

### 3. Measurement Layer
Collects or receives infrastructure/resource measurements.

Initial metrics:

- Energy
- Water
- CO2e
- Execution duration
- Baseline deltas

### 4. Normalization
Converts measurements into a consistent structure regardless of source.

### 5. Analysis
Identifies meaningful changes and patterns across executions.

### 6. Developer Insight
Returns concise, actionable information explaining what changed and
where further investigation may be useful.

## Future Architecture

The prototype should remain modular so it can eventually connect with
EcoPrint's broader measurement, attribution, and accounting systems.

Full attribution, enterprise accounting, dashboards, and proprietary
EcoPrint systems are outside the MVP scope.

## Workload Provenance and Self-Measurement Boundary

The total power, energy, carbon, and water series remain the observed system
totals. The existing client-workload and EcoPrint-overhead power series are
carried through as allocations; they are not presented as directly measured
per-process watts. Carbon and water splits are proportional allocations from
the observed totals and are shown only when the power split reconciles to total
power.

On macOS, the CLI records its own process context, the launched workload
process, and discovered descendants from periodic process snapshots. It stores
PID/parent PID, executable name, approximate process start time, observed
window, and provenance class in the existing derived context table. It does
not store argv or environment variables. Process existence and lineage are
provenance evidence, not proof of watt ownership; discovered process contexts
do not divide system-wide telemetry unless a future telemetry source supplies
a matching process identity.

The hardware measurement covers the system while the measurement service and
CLI are active, so their work is part of the observed total. The current model
does not isolate sampler energy directly. The client/observer split therefore
retains the source's allocation method and must be treated as allocated or
unavailable, never as independently measured process energy. Background
process identity and kernel-level work remain outside the current capture
boundary.

## Constraints

- Standalone hackathon project
- No proprietary SigSense or Connect implementation
- No client data
- No confidential data
- No personal information
- Bob IDE must remain a core development component
