# EcoPrint Transparency Layer — Project Rules

## Project Boundaries
- This project is a hackathon prototype and must remain separate from proprietary EcoPrint systems.
- Do not import, copy, recreate, or modify proprietary EcoPrint components unless explicitly instructed.
- Do not assume access to SigSense, Connect, or other proprietary EcoPrint code.
- SigSense may be modified only when necessary to implement, validate, harden, or expose the EcoPrint self-measurement, workload/process provenance, attribution, measurement-quality, or related accounting architecture in the current task.
- Keep SigSense changes scoped to this task. Preserve existing raw telemetry contracts where reasonably possible, do not create duplicate raw telemetry systems or a second raw telemetry database, avoid unrelated refactoring/cleanup, and preserve backwards compatibility where practical.
- Add or update tests for every behavioral change.
- Identify each SigSense change as either required for the current implementation or a directly related hardening/improvement discovered during implementation.
- Document useful SigSense improvements discovered in this work for later upstreaming into the canonical SigSense repository.
- This is a narrow task authorization and does not permit unrelated SigSense redesign.

## Development Workflow
- Make the smallest necessary change for each task.
- Explain the planned change before making significant architectural changes.
- Do not add dependencies without explaining why they are needed.
- Do not delete or overwrite existing work without explicit approval.
- Prefer simple, modular, testable implementations.

## Hackathon Evidence
- Preserve the bob_sessions/ directory.
- Do not delete or modify previously captured hackathon evidence.
- When a task produces a meaningful milestone, remind the developer to capture the required screenshot.

## Communication
- Be concise and direct.
- Identify assumptions before acting on them.
- If requirements are ambiguous, ask before making a consequential change.
