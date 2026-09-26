# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Status

Early-stage hackathon prototype. `src/` and `tests/` directories exist but are empty.
No build tooling, test framework, or package manager has been chosen yet.
Commands below will be updated as the project evolves.

## Project Boundaries (Hard Rules)

- **No proprietary EcoPrint code.** Do not import, copy, recreate, or reference SigSense, Connect, or any proprietary EcoPrint component. Treat telemetry-engine implementation details as protected.
- **Standalone prototype only.** This repo must never be coupled to EcoPrint production systems.
- **No client, confidential, or personal data.**

## Hackathon Evidence

- `bob_sessions/` must be preserved — never delete or modify its contents.
- After any meaningful milestone, remind the developer to capture a screenshot for submission evidence.

## Architecture Intent (see docs/architecture.md)

The planned pipeline is:

```
Developer → GitHub → CI/CD → Transparency CLI → Measurement → Analysis → Developer Insight
```

Five MVP components: CLI, Workflow Integration, Measurement Layer, Normalization, Analysis/Insight.
Initial metrics: Energy, Water, CO2e, Execution duration, Baseline deltas.
Design must stay modular to allow future connection to EcoPrint's broader systems.

## Development Discipline

- Make the smallest change that satisfies the requirement.
- Explain planned changes before making significant architectural decisions.
- Do not add dependencies without justifying why they are needed.
- Do not delete or overwrite existing work without explicit approval.
- Prefer simple, modular, testable implementations.
- Identify assumptions before acting on them; ask if requirements are ambiguous.

## Bob IDE

IBM Bob is a required development component for this hackathon project. Bob must be used for meaningful tasks (planning, implementation, testing, analysis, review) throughout development.
