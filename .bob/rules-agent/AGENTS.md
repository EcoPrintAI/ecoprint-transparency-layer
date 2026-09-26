# AGENTS.md — Agent (Coding) Mode

This file provides guidance to agents when working with code in this repository.

## No build/test tooling yet

`src/` and `tests/` are empty. When you add a language/framework, document commands in the root AGENTS.md immediately.

## Required patterns when code lands

- CLI is the primary developer interface — `src/` code must remain invocable from the command line.
- Normalization layer must accept any measurement source and produce a consistent internal structure before passing data downstream.
- Each MVP component (CLI, Workflow Integration, Measurement, Normalization, Analysis) should be independently importable/testable.
- Do not hard-code measurement sources — the architecture requires source-agnostic ingestion.

## Forbidden

- No raw SigSense/Connect API calls or SDK imports under any circumstances.
- Do not add dependencies without explaining the reason.
- Do not delete `bob_sessions/` or any previously captured evidence files.
