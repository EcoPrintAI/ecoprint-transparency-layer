# Lab Note — CPU Telemetry Test

**Project:** EcoPrint Transparency / SigSense  
**Test Type:** Controlled CPU workload + telemetry observation  
**Platform:** macOS  
**Date:** 2026-09-26  
**Status:** PASS — CPU telemetry successfully observed and attributed

---

## 1. Objective

Validate that EcoPrint/SigSense can observe CPU activity from a deliberately CPU-intensive workload on macOS.

This experiment provides a dedicated CPU hardware-path validation to complement the separate GPU and Apple Neural Engine tests.

The test also verifies that the observed CPU telemetry can be associated with an EcoPrint workload execution and surfaced through the Transparency CLI.

---

## 2. Hypothesis

A sustained CPU computation should produce measurable CPU activity in SigSense telemetry while GPU and ANE activity remain near zero.

Expected result:

- The CPU workload executes successfully.
- SigSense records non-zero CPU telemetry.
- GPU activity remains very low.
- ANE activity remains zero.
- EcoPrint attributes the observed telemetry to the tracked workload.

---

## 3. Test Preparation

A temporary JavaScript workload was created at:

```text
/tmp/cpu_burn.js
```

The workload was designed to run sustained integer computation for approximately eight seconds.

The laptop's normal power-saving condition was retained from the prior hardware testing session.

---

## 4. Temporary CPU Workload

The workload was:

```javascript
const end = Date.now() + 8000;
let x = 0x12345678;

while (Date.now() < end) {
  for (let i = 0; i < 500000; i++) {
    x = Math.imul(x ^ (x >>> 13), 1664525) + 1013904223;
    x = x >>> 0;
  }
}

console.log("CPU workload complete");
console.log("Checksum:", x);
```

This provides a repeatable CPU computation without intentionally targeting the GPU or Apple Neural Engine.

---

## 5. Direct Capability Test

The workload was first executed directly:

```bash
node /tmp/cpu_burn.js
```

Result:

```text
CPU workload complete
Checksum: 3109035189
```

This established that the workload itself executed successfully.

The checksum from this direct run differs from the EcoPrint-wrapped execution because the computation is time-bounded and therefore performs a different number of loop iterations depending on execution timing. The checksum is included as evidence that the workload completed.

---

## 6. EcoPrint Telemetry Test

The same workload was then executed through the Transparency CLI:

```bash
node bin/ecoprint.js run --name cpu-check -- \
  node /tmp/cpu_burn.js
```

Application output:

```text
CPU workload complete
Checksum: 723496278
```

---

## 7. Recorded Measurements

### Run information

| Metric | Result |
|---|---:|
| Workload | `cpu-check` |
| Workload ID | `236cbddd-796e-41da-891f-ee18574eb974` |
| Run ID | `740ce690-1e7d-4995-a9b4-4b30c34845b8` |
| Attempt ID | `a5ae059c-d91a-4772-b88f-acb8c65509ed` |
| Context ID | `e0b78c3d-391e-4108-864b-84e5b40e8616` |
| Command | `node /tmp/cpu_burn.js` |
| Status | SUCCESS |
| PID | `92532` |
| Resource | `MacBook-Air.local` |
| Started | `2026-09-27T03:04:46.947Z` |
| Ended | `2026-09-27T03:04:54.991Z` |
| Duration | 8.04 s |
| Observations | 6 |
| Measurement source | hardware |
| Grid source | live |
| Attribution coverage | 100% |

### Component power

| Component | Average Power | Peak Power |
|---|---:|---:|
| **CPU** | **1.595 W** | **1.73 W** |
| GPU | 0.000673 W | 0.004 W |
| ANE | 0.000 W | 0.000 W |
| Total | 1.596 W | 1.73 W |

### Component energy

| Component | Measured | Attributed | Unattributed |
|---|---:|---:|---:|
| **CPU** | **0.00286 Wh** | **0.00286 Wh** | 0.000 Wh |
| GPU | 0.0000012 Wh | 0.0000012 Wh | 0.000 Wh |
| ANE | 0.000 Wh | 0.000 Wh | 0.000 Wh |
| Total | **0.00286 Wh** | **0.00286 Wh** | 0.000 Wh |

### Environmental impact

| Metric | Measured | Attributed | Unattributed |
|---|---:|---:|---:|
| Carbon | 0.0013949238 gCO2e | 0.0013949238 gCO2e | 0.0000000000 gCO2e |
| Water | 0.000005488225 L | 0.000005488225 L | 0.000000000000 L |

**Total Energy:** `0.00285845 Wh` (`0.0000028585 kWh`)

**Reconciliation:** measured = attributed + unattributed

**Attribution version:** `1`

**Evidence:** deterministic — 100% attributed

**Baseline:** not available — this run establishes the comparison point.

**CLI insight:** Run this workload again to enable differential analysis.

---

## 8. Key Result

The test produced a clear CPU hardware signal:

```text
CPU Average Power: 1.595 W
CPU Peak Power:    1.73 W
CPU Energy:        0.00286 Wh
```

At the same time:

```text
GPU Average Power: 0.000673 W
GPU Peak Power:    0.004 W
GPU Energy:        0.0000012 Wh

ANE Average Power: 0 W
ANE Peak Power:    0 W
ANE Energy:        0 Wh
```

The CPU therefore represented essentially all measured energy for this workload.

The run generated six hardware telemetry observations and achieved 100% deterministic attribution.

---

## 9. Interpretation

### Hypothesis result: CONFIRMED

The deliberate CPU workload produced a sustained, non-zero CPU signal while GPU and ANE activity remained negligible or zero.

The combination of:

1. Successful direct CPU workload execution.
2. Eight-second tracked execution.
3. Six hardware telemetry observations.
4. 1.595 W average CPU power.
5. 1.73 W CPU peak power.
6. 0.00286 Wh CPU energy.
7. Near-zero GPU activity.
8. Zero ANE activity.
9. 100% deterministic attribution.

provides dedicated evidence that the CPU telemetry path is functioning during an intentionally CPU-bound workload.

---

## 10. Relationship to GPU and ANE Tests

This experiment completes the dedicated component-path validation set.

### CPU test

```text
CPU Average Power: 1.595 W
GPU Average Power: 0.000673 W
ANE Average Power: 0 W
```

### GPU test

```text
GPU Average Power: 7.191 W
GPU Peak Power:    7.261 W
GPU Energy:        0.0201 Wh
```

### ANE test

```text
ANE Average Power: 2.85 W
ANE Peak Power:    2.928 W
ANE Energy:        0.00544 Wh
GPU Average Power: 0.000841 W
```

These experiments were performed as separate hardware-path validations. Their durations were not standardized, so their total energy values should not be treated as a controlled apples-to-apples benchmark. The purpose of this CPU experiment is dedicated path validation.

---

## 11. End-to-End Measurement Path

```text
CPU computation
      ↓
macOS CPU
      ↓
SigSense hardware telemetry
      ↓
CPU / GPU / ANE component readings
      ↓
Transparency workload identity
      ↓
Deterministic attribution
      ↓
CLI execution report
```

---

## 12. What This Test Demonstrates

This experiment validates that:

- A deliberate CPU workload can be generated on macOS.
- The workload can be executed through the EcoPrint Transparency CLI.
- SigSense records a clear non-zero CPU hardware signal during the execution.
- GPU and ANE readings remain negligible/zero for this workload.
- Existing component-level telemetry can surface CPU power and energy.
- The Transparency layer associates the telemetry with workload/run/attempt/context identity.
- Deterministic attribution assigns the measured energy, carbon, and water to the tracked workload.
- Carbon and water calculations are produced from the measured energy using live grid data.
- The result can be presented directly in the terminal as component-level evidence.

---

## 13. Limitations

- The workload was designed for approximately eight seconds and was not standardized to the exact duration used by the separate GPU and ANE experiments.
- CPU power readings can vary with thermal conditions, operating-system scheduling, background activity, and power-management state.
- The experiment validates the CPU measurement path on the tested Mac and does not establish identical readings across other systems.
- The test is a hardware-path validation experiment, not a production workload benchmark.
- No differential baseline should be inferred from this first `cpu-check` run.

---

## 14. Cleanup

The temporary workload can be removed after the experiment:

```bash
rm /tmp/cpu_burn.js
```

---

## 15. Conclusion

**RESULT: PASS**

The dedicated CPU workload successfully produced a measurable CPU signal that SigSense captured as hardware telemetry and that EcoPrint attributed to the tracked workload.

Final recorded values:

```text
CPU Average Power: 1.595 W
CPU Peak Power:    1.73 W
CPU Energy:        0.00286 Wh

Total Average Power: 1.596 W
Total Energy:        0.00285845 Wh

Carbon: 0.0013949238 gCO2e
Water:  0.000005488225 L

Telemetry observations: 6
Attribution coverage: 100%
Measurement source: hardware
Grid source: live
```

The dedicated component validation record is now:

```text
CPU  ✅
GPU  ✅
ANE  ✅
```

The separate tests collectively demonstrate that SigSense's existing component telemetry can observe deliberately targeted CPU, GPU, and Apple Neural Engine workloads and expose those measurements through the EcoPrint Transparency CLI.
