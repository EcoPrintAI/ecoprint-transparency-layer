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

## Constraints

- Standalone hackathon project
- No proprietary SigSense or Connect implementation
- No client data
- No confidential data
- No personal information
- Bob IDE must remain a core development component