# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Stack

- **Runtime:** Node.js 22 (ESM — `"type":"module"` in package.json; all imports use `import`/`export`)
- **C++ engine:** Apple clang++ 21, SQLite3 via Xcode SDK (no Homebrew needed)
- **Test runner:** Node.js built-in `node:test` — no Jest/Vitest/Mocha installed
- **Package manager:** npm

## Commands

```bash
# JavaScript tests
npm run test:transparency        # Transparency Identity Core tests only
npm test                         # all tests matching tests/**/*.test.js

# Build C++ engine (must cd into sigsense/engine/ first)
cd sigsense/engine && make
cd sigsense/engine && make clean && make   # clean rebuild

# Run SigSense engine (must run from sigsense/engine/ — relative paths for DB + config)
cd sigsense/engine && ./v3engine           # fallback power metrics
cd sigsense/engine && sudo ./v3engine      # real Apple Silicon hardware readings

# Run SigSense API server (from repo root — __dirname resolves DB path correctly)
node sigsense/server.js                    # starts on port 3001
```

## Transparency Identity Core (`src/transparency/`)

Public API is exported from `src/transparency/index.js`. Do not import internal files directly.

- **`db.js`** — `openDatabase(path?)`, `initSchema(db)`, `closeDatabase(db)` + promise wrappers `dbRun/dbGet/dbAll`
- **`identity.js`** — `createWorkload`, `startRun`, `completeRun`, `startAttempt`, `completeAttempt`, `getWorkloadTimeline`
- **`env.js`** — `buildIdentityEnv({workloadId, runId, attemptId})`, `readIdentityEnv(env?)`

**Database:** `src/transparency/transparency.db` (separate from `sigsense/engine/ecoprint_telemetry.db`).
Pass `':memory:'` to `openDatabase` in tests.

**Identity propagation env vars:** `ECOPRINT_WORKLOAD_ID`, `ECOPRINT_RUN_ID`, `ECOPRINT_ATTEMPT_ID`

**`attempt_no`** is auto-assigned (1-based per run) — callers never supply it.

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
