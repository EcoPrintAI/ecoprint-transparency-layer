# EcoPrint Transparency — Demo

## Quick start

### 1. Build the SigSense engine

```bash
cd sigsense/engine && make && cd -
```

### 2. Start the SigSense measurement engine

Open a separate terminal:

```bash
cd sigsense/engine
./v3engine
# or, for real Apple Silicon hardware readings:
sudo ./v3engine
```

The engine must be running during step 3 to produce measurements.

### 3. Run any command under EcoPrint Transparency

In your original terminal (from the repo root):

```bash
node bin/ecoprint.js run --name <workload-name> -- <your command>
```

**Examples:**

```bash
# Measure a 5-second sleep
node bin/ecoprint.js run --name sleep-demo -- sleep 5

# Measure a build
node bin/ecoprint.js run --name npm-build -- npm run build

# Measure a directory listing
node bin/ecoprint.js run --name list-src -- ls -la src/

# Measure a test suite
node bin/ecoprint.js run --name unit-tests -- npm test
```

Or using the npm shorthand:

```bash
npm run ecoprint -- run --name sleep-demo -- sleep 5
```

---

## Example terminal output

```
[EcoPrint] Starting transparency measurement for "sleep-demo"...

════════════════════════════════════════════════════════════
  ECOPRINT TRANSPARENCY — EXECUTION REPORT
════════════════════════════════════════════════════════════

  WORKLOAD IDENTITY
────────────────────────────────────────────────────────────
  Workload   : sleep-demo  (cli-run)
  Workload ID: ec85c425-3d0c-4d0c-83d0-33462133ea7f
  Run ID     : 5d51da5d-ce22-4efb-b776-9dfdbaad60be
  Attempt ID : 4a3de524-e529-4006-9f79-f61048a5b76b  (#1)
  Context ID : 1f038c19-0f23-4541-a4b0-dd6e4b71273b

  EXECUTION
────────────────────────────────────────────────────────────
  Command    : sleep 3
  Status     : ✓ SUCCESS
  PID        : 23149
  Resource   : MacBook-Air.local
  Started    : 2026-09-26T09:59:11.322Z
  Ended      : 2026-09-26T09:59:14.334Z
  Duration   : 3.01s

  ENERGY / CARBON / WATER
────────────────────────────────────────────────────────────
  Telemetry observations: 1

  Metric                         Measured   Attributed   Unattributed
  -------------------------- ------------ ------------ --------------
  Power (W avg)                    0.3200       0.3200         0.0000
  Carbon (gCO₂e total)           0.000048     0.000048       0.000000
  Water (L total)              0.00000017   0.00000017     0.00000000

  Reconciliation : measured = attributed + unattributed  ✓
  Attribution    : 100.0%
  Evidence       : deterministic — 100% attributed

════════════════════════════════════════════════════════════
```

---

## What the report shows

| Field | Description |
|---|---|
| Workload ID | Stable UUID for this type of work |
| Run ID | UUID for this execution |
| Attempt ID | UUID for this attempt (increments on retry) |
| Context ID | UUID for the recorded process context (PID) |
| PID | OS process ID of the child command |
| Resource | Hostname (used for telemetry correlation) |
| Duration | Wall-clock time from spawn to exit |
| Telemetry observations | SigSense rows within the execution window |
| Power (W avg) | Sum of `total_power_watts` across observations |
| Carbon (gCO₂e total) | Sum of `carbon_gCO2e` across observations |
| Water (L total) | Sum of `water_liters` across observations |
| Attribution % | Fraction of measured energy tied to a known context |
| Evidence | Attribution method used |

---

## Reconciliation invariant

```
measured = attributed + unattributed
```

This holds for power, carbon, and water. No telemetry observation is ever silently discarded.

---

## If the engine is not running

```
  ⚠  No SigSense observations in execution window.
     (Engine may not have been running during this window.)
```

The command still executes and all identity/context records are preserved. No measurements are fabricated.

---

## Architecture

```
ecoprint run …
    └── Identity Core         (workload / run / attempt UUIDs)
    └── Context Timeline      (PID, hostname, start/end timestamps)
    └── SigSense read adapter (node_id, power, carbon, water)
    └── Attribution Layer     (deterministic correlation)
    └── Reconciliation        (measured = attributed + unattributed)
    └── Terminal report
```

---

## Run all tests

```bash
npm test
```
