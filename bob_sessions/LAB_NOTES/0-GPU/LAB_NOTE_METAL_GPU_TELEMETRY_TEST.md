# Lab Note — Metal GPU Telemetry Test

**Project:** EcoPrint Transparency / SigSense  
**Test Type:** Controlled GPU workload + telemetry observation  
**Platform:** macOS  
**Date:** 2026-09-26  
**Status:** Executed successfully; GPU telemetry observed and attributed

---

## 1. Objective

Validate that EcoPrint/SigSense can observe GPU activity from a deliberately GPU-intensive workload on macOS, rather than relying on a normal CPU-heavy process that may produce little or no measurable GPU activity.

The test also verifies that a Metal-based workload can run successfully when executed directly and when wrapped by the EcoPrint Transparency CLI.

---

## 2. Hypothesis

A workload that performs sustained Metal compute operations should create observable GPU activity in SigSense telemetry.

Expected result:

- The workload executes successfully using Apple's Metal framework.
- SigSense records non-zero GPU telemetry during the run.
- EcoPrint attributes the observed telemetry to the workload execution.
- CPU activity may also be present because the process is launched and coordinated by the CPU.
- ANE activity is not expected from this workload.

---

## 3. Test Preparation

Before running the workload, laptop power-saving mode was disabled.

### Why

Disabling power saving reduces the chance that the operating system will aggressively throttle or limit sustained compute activity. This makes the GPU workload easier to observe during a short telemetry test.

This is a test-condition change, not a requirement for normal EcoPrint operation.

---

## 4. Temporary GPU Workload

A temporary Swift source file was created at:

```text
/tmp/gpu_burn.swift
```

The program uses Apple's **Metal** framework to create a GPU compute workload. It:

1. Creates the system Metal device.
2. Compiles a small Metal compute kernel.
3. Allocates a floating-point buffer.
4. Performs repeated floating-point multiply/add work on the GPU.
5. Dispatches the compute kernel repeatedly.
6. Waits for submitted command buffers to complete.

The workload was intentionally designed to create sustained GPU computation rather than simply launching an application that happens to have GPU support.

---

## 5. Direct Capability Test

First, the workload was executed without EcoPrint:

```bash
xcrun swift /tmp/gpu_burn.swift
```

### Result

The command executed successfully.

This established that the temporary Metal workload could compile/run on the test Mac and that the system's Metal GPU path was available for the experiment.

**Important:** This direct run proves workload execution, but by itself does not prove that EcoPrint measured the GPU. The telemetry observation comes from the wrapped EcoPrint run below.

---

## 6. EcoPrint Telemetry Test

The same workload was then executed through the Transparency CLI:

```bash
node bin/ecoprint.js run --name metal-gpu-check -- xcrun swift /tmp/gpu_burn.swift
```

This places the GPU workload inside an EcoPrint-tracked workload execution so that SigSense telemetry can be associated with the run.

### Measurement path

```text
Metal workload
      ↓
macOS GPU
      ↓
SigSense hardware telemetry
      ↓
Transparency telemetry adapter
      ↓
Workload / run / attempt identity
      ↓
Deterministic attribution
      ↓
CLI report
```

---

## 7. Recorded Measurements

The final EcoPrint run produced the following measurements.

### Run information

| Metric | Result |
|---|---:|
| Workload | `metal-gpu-check` |
| Workload ID | `9b977855-10a7-4fe3-81cb-c67277c94a70` |
| Run ID | `4ebff604-6e50-4d1c-9224-34db0dfd1756` |
| Attempt ID | `d475caa0-b4e2-4a78-969a-dc8650b5ee8c` |
| Context ID | `2a990cab-8e9a-43a0-8971-395a4f4f4d9e` |
| Command | `xcrun swift /tmp/gpu_burn.swift` |
| Status | SUCCESS |
| PID | `83917` |
| Resource | `MacBook-Air.local` |
| Started | `2026-09-27T01:52:01.248Z` |
| Ended | `2026-09-27T01:52:14.128Z` |
| Duration | 12.88 s |
| Observations | 9 |
| Measurement source | hardware |
| Grid source | live |
| Attribution coverage | 100% |

### Component power

| Component | Average Power | Peak Power |
|---|---:|---:|
| CPU | 0.0818 W | 0.308 W |
| GPU | **7.191 W** | **7.261 W** |
| ANE | 0.000 W | 0.000 W |
| Total | 7.272 W | 7.458 W |

### Component energy

| Component | Measured | Attributed | Unattributed |
|---|---:|---:|---:|
| CPU | 0.000229 Wh | 0.000229 Wh | 0.000 Wh |
| GPU | **0.0201 Wh** | **0.0201 Wh** | 0.000 Wh |
| ANE | 0.000 Wh | 0.000 Wh | 0.000 Wh |
| Total | **0.0204 Wh** | **0.0204 Wh** | 0.000 Wh |

### Environmental impact

| Metric | Measured | Attributed | Unattributed |
|---|---:|---:|---:|
| Carbon | 0.0100431952 gCO2e | 0.0100431952 gCO2e | 0.0000000000 gCO2e |
| Water | 0.000039113458 L | 0.000039113458 L | 0.000000000000 L |

**Total Energy:** `0.02037159 Wh` (`0.0000203716 kWh`)

**Reconciliation:** measured = attributed + unattributed

**Attribution version:** `1`

**Evidence:** deterministic — 100% attributed

**Baseline:** not available — this run establishes the comparison point.

**CLI insight:** Run this workload again to enable differential analysis.

---

## 8. Interpretation

The hypothesis was confirmed.

The Metal workload produced a **7.191 W average GPU reading and a 7.261 W peak GPU reading** during the EcoPrint-tracked execution. GPU energy was **0.0201 Wh**, and the full run had **100% deterministic attribution coverage**.

The result is materially different from the earlier CPU-focused tests, where GPU activity was near zero. That distinction is important: this experiment deliberately exercised the Metal compute path and produced a strong, non-zero GPU signal.

### Observations

- **GPU activity:** clearly observed and dominant during this run.
- **GPU energy:** 0.0201 Wh, accounting for nearly all of the 0.0204 Wh measured total energy.
- **CPU activity:** present but comparatively small at 0.0818 W average.
- **ANE activity:** 0 W, consistent with this test being designed around Metal GPU compute rather than the Apple Neural Engine.
- **Attribution:** 100% of measured energy, carbon, and water was attributed to the tracked workload under attribution version 1.
- **Grid:** live grid-intensity data was used for the environmental calculations.
- **Baseline:** none was available for this first `metal-gpu-check` run, so no differential claim can be made yet.

This demonstrates that SigSense is not merely reporting a fixed or generic GPU placeholder for this workload: the measured GPU signal changes substantially when the workload intentionally drives the GPU.

Telemetry remains measurement evidence rather than proof of causality for every system-level change. The experiment establishes that GPU activity was observed during this workload window and attributed to the corresponding execution under the deterministic model.

---

## 9. What This Test Demonstrates

This experiment is stronger than using a generic process such as `sleep` or a CPU-only loop because it intentionally targets a specific hardware execution path.

It provides a controlled validation that:

1. A real macOS Metal workload can be generated.
2. The workload can be wrapped by EcoPrint's CLI execution model.
3. SigSense can expose component-level telemetry already present in the existing telemetry schema.
4. The Transparency layer can correlate the telemetry with a named workload execution.
5. Component-level telemetry can be surfaced in the CLI as evidence for workload-level transparency.

---

## 10. Reproduction Procedure

### Step 1 — Ensure the telemetry/service path is running

Use the normal SigSense service state already configured for macOS.

### Step 2 — Disable power-saving mode temporarily

Disable the Mac's power-saving setting for the duration of the test if sustained GPU activity needs to be made easier to observe.

### Step 3 — Run the direct Metal capability test

```bash
xcrun swift /tmp/gpu_burn.swift
```

### Step 4 — Run through EcoPrint

```bash
node bin/ecoprint.js run --name metal-gpu-check -- xcrun swift /tmp/gpu_burn.swift
```

### Step 5 — Save the terminal output/screenshot

Record the component-level power, energy, carbon, water, and attribution values.

### Step 6 — Restore normal power settings

Re-enable the normal laptop power-saving configuration after the experiment if it was changed only for this test.

---

## 11. Limitations

- This is a short controlled workload, not a production workload.
- macOS power behavior can vary with thermal conditions, battery/AC state, and system load.
- A non-zero GPU reading demonstrates measured GPU activity, but it does not by itself establish causality for every system-level energy change.
- The test does not validate Apple Neural Engine attribution.
- This test does not establish that identical GPU values will be observed across different Mac models.

---

## 12. Cleanup

The temporary workload file can be removed after the experiment:

```bash
rm /tmp/gpu_burn.swift
```

The test file is temporary and is not part of the EcoPrint product source tree.

---

## 13. Conclusion

**Result: PASS**

The controlled Metal workload successfully generated sustained GPU activity that SigSense captured as hardware telemetry.

The final EcoPrint report recorded:

- **GPU average:** 7.191 W
- **GPU peak:** 7.261 W
- **GPU energy:** 0.0201 Wh
- **Total energy:** 0.02037159 Wh
- **Carbon:** 0.0100431952 gCO2e
- **Water:** 0.000039113458 L
- **Attribution coverage:** 100%

This provides a strong end-to-end validation of the component-level telemetry path:

```text
Metal compute workload
        ↓
macOS GPU
        ↓
SigSense hardware telemetry
        ↓
Transparency workload identity
        ↓
Deterministic attribution
        ↓
Component-level CLI report
```

The direct Metal run established that the workload itself could execute. The EcoPrint-wrapped run then demonstrated that the resulting GPU activity was observable, measurable, and attributable through the Transparency layer.

A follow-up run of the same workload name can establish a baseline and produce differential analysis for GPU power and energy.

This test was designed as a **hardware-path validation experiment** for EcoPrint/SigSense.

The direct Metal run confirmed that the GPU workload could execute successfully on the test Mac. The EcoPrint-wrapped run provides the actual telemetry validation needed to determine whether the GPU signal was observed and attributed by the Transparency layer.

The final CLI report should be retained with the hackathon evidence so the result can be reproduced and compared against future CPU-, GPU-, or mixed-workload experiments.
