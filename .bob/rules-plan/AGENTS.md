# AGENTS.md — Plan Mode

This file provides guidance to agents when working with code in this repository.

## Architectural constraints (from docs/architecture.md)

- The pipeline is linear: CLI → Measurement → Normalization → Analysis → Insight. Do not collapse or merge stages.
- Normalization is a mandatory stage — measurements from any source must pass through it before analysis.
- The prototype must remain modular so it can eventually connect to EcoPrint's broader systems without requiring a rewrite.
- Full attribution, enterprise accounting, dashboards, and proprietary EcoPrint systems are explicitly out of MVP scope.

## Prototype boundary constraints (from docs/project-brief.md)

- SigSense and Connect are off-limits. Do not design integrations that depend on them even as future extensions unless explicitly approved.
- The prototype must be demonstrable end-to-end: ingestion → normalization → context association → calculation → developer output.
- IBM Bob IDE must remain a core component of the development process throughout — plan Bob usage into task breakdowns.

## Planning process rules

- Explain planned architectural changes before proposing implementation.
- Identify assumptions explicitly before proposing a design.
- When a milestone is complete, include a reminder to capture hackathon evidence (screenshot of Bob session).
