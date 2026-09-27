# Lab Note — Apple Neural Engine (ANE) Telemetry Test

**Project:** EcoPrint Transparency / SigSense  
**Test Type:** Controlled Core ML neural-network workload + ANE telemetry observation  
**Platform:** macOS  
**Date:** 2026-09-26  
**Status:** PASS — ANE telemetry successfully observed and attributed

---

## 1. Objective

Validate that EcoPrint/SigSense can observe Apple Neural Engine activity from a deliberately neural-network workload on macOS.

This is the first documented end-to-end ANE telemetry experiment for the current SigSense engine.

The test also verifies that the observed component signal can be associated with an EcoPrint workload execution and surfaced through the Transparency CLI.

---

## 2. Hypothesis

A sufficiently long Core ML neural-network workload configured with:

```swift
configuration.computeUnits = .cpuAndNeuralEngine
```

should produce measurable ANE activity while excluding the GPU from Core ML's permitted compute units.

Expected result:

- The Core ML workload executes successfully.
- SigSense records non-zero ANE telemetry.
- GPU activity remains near zero because the GPU is excluded from the Core ML configuration.
- CPU activity may remain present because the workload is configured for CPU + Neural Engine.
- EcoPrint attributes the observed telemetry to the tracked workload.

---

## 3. Test Preparation

Laptop power-saving mode was disabled temporarily before the test.

### Why

Disabling power-saving reduces the chance of aggressive throttling during a short sustained compute experiment and makes the hardware signal easier to observe.

This is a test-condition change, not a requirement for normal EcoPrint operation.

---

## 4. Test Environment

The test used:

```text
/tmp/make_ane_model.py
/tmp/ane_burn.mlmodel
/tmp/ane_burn.swift
```

A Python virtual environment was created for Core ML Tools and NumPy:

```text
/tmp/ane-venv
```

Core ML Tools version used:

```text
9.0
```

---

## 5. Model Generation

A small convolutional neural-network model was generated with Core ML Tools.

The model contains a stack of convolution and ReLU layers intended to provide enough neural-network computation to create a telemetry window long enough for SigSense's approximately one-second sampling loop.

The final model was written to:

```text
/tmp/ane_burn.mlmodel
```

---

## 6. Initial Test Failure

The first generated model failed Core ML validation because the declared interface output was named `output`, while the final neural-network layer actually produced `relu6_out`.

Core ML reported:

```text
validator error:
Interface specifies output 'output'
which is not produced by any layer in the neural network.
```

The model generator was corrected so that the final layer produces the declared `output` interface.

A second issue was also identified during setup: `coremltools` and NumPy had been installed into the virtual environment, but the first regeneration attempt used the system Python after the environment was deactivated.

The model was subsequently regenerated successfully while `/tmp/ane-venv` was active.

---

## 7. Direct Core ML Capability Test

Before involving EcoPrint, the workload was executed directly:

```bash
xcrun swift /tmp/ane_burn.swift
```

The successful result was:

```text
Core ML model loaded
Compute units: CPU + Neural Engine
GPU excluded
ANE workload complete
Iterations: 10000
Execution time: 7.140 s
Checksum: 79.498291
```

This established that the Core ML workload itself executed successfully.

The Swift workload was then configured for 10,000 inference iterations to create a sufficiently long telemetry window.

---

## 8. EcoPrint Telemetry Test

The workload was executed through the Transparency CLI:

```bash
node bin/ecoprint.js run --name ane-check -- \
  xcrun swift /tmp/ane_burn.swift
```

The application-side workload completed successfully:

```text
Core ML model loaded
Compute units: CPU + Neural Engine
GPU excluded
ANE workload complete
Iterations: 10000
Execution time: 7.275 s
Checksum: 79.498291
```

---

## 9. Recorded Measurements

### Run information

| Metric | Result |
|---|---:|
| Workload | `ane-check` |
| Workload ID | `67a80290-9b42-40d2-b871-945d1d8a3ab1` |
| Run ID | `9d5d094a-cb8c-4cb0-84a4-a8367c2a1af7` |
| Attempt ID | `f1f91229-fa25-41b9-acd5-1950fb3e5324` |
| Context ID | `9a07a05e-ae43-40bd-bfb7-969522f9d2eb` |
| Command | `xcrun swift /tmp/ane_burn.swift` |
| Status | SUCCESS |
| PID | `91043` |
| Resource | `MacBook-Air.local` |
| Started | `2026-09-27T02:40:30.006Z` |
| Ended | `2026-09-27T02:40:38.816Z` |
| Duration | 8.81 s |
| Observations | 6 |
| Measurement source | hardware |
| Grid source | live |
| Attribution coverage | 100% |

### Component power

| Component | Average Power | Peak Power |
|---|---:|---:|
| CPU | 2.27 W | 3.106 W |
| GPU | 0.000841 W | 0.005 W |
| **ANE** | **2.85 W** | **2.928 W** |
| Total | 5.121 W | 5.833 W |

### Component energy

| Component | Measured | Attributed | Unattributed |
|---|---:|---:|---:|
| CPU | 0.00434 Wh | 0.00434 Wh | 0.000 Wh |
| GPU | 0.00000161 Wh | 0.00000161 Wh | 0.000 Wh |
| **ANE** | **0.00544 Wh** | **0.00544 Wh** | **0.000 Wh** |
| Total | **0.00978 Wh** | **0.00978 Wh** | **0.000 Wh** |

### Environmental impact

| Metric | Measured | Attributed | Unattributed |
|---|---:|---:|---:|
| Carbon | 0.0047732465 gCO2e | 0.0047732465 gCO2e | 0.0000000000 gCO2e |
| Water | 0.000018779986 L | 0.000018779986 L | 0.000000000000 L |

**Total Energy:** `0.00978124 Wh` (`0.0000097812 kWh`)

**Reconciliation:** measured = attributed + unattributed

**Attribution version:** `1`

**Evidence:** deterministic — 100% attributed

---

## 10. Key Result

The test successfully produced a substantial non-zero ANE reading:

```text
ANE Average Power: 2.85 W
ANE Peak Power:    2.928 W
ANE Energy:        0.00544 Wh
```

The signal was present across all 6 telemetry observations.

At approximately 5.121 W total average power, the ANE accounted for approximately 56% of the measured average power during the tracked window.

Likewise, 0.00544 Wh of the 0.00978 Wh total measured energy was attributed to the ANE, also approximately 56%.

The GPU signal was effectively negligible:

```text
GPU Average Power: 0.000841 W
GPU Peak Power:    0.005 W
GPU Energy:        0.00000161 Wh
```

This is consistent with the Core ML configuration excluding the GPU.

---

## 11. Interpretation

### Hypothesis result: CONFIRMED

The experiment established a non-zero ANE telemetry signal during a Core ML neural-network workload configured for CPU + Neural Engine while excluding the GPU.

The strongest evidence is the combination of:

1. A successful neural-network workload.
2. Explicit `cpuAndNeuralEngine` compute-unit configuration.
3. GPU exclusion in the Core ML configuration.
4. Six hardware telemetry observations during the execution.
5. A sustained ANE reading of 2.85 W average / 2.928 W peak.
6. Non-zero ANE energy of 0.00544 Wh.
7. 100% deterministic attribution.

This is the first documented successful ANE hardware-path test for the current SigSense implementation.

### Important measurement caveat

The result should be interpreted as strong telemetry evidence that the ANE measurement path observed activity associated with this Core ML execution.

The Core ML workload is configured to permit CPU + Neural Engine rather than Neural Engine-only execution. Therefore, the experiment does not independently prove that every operation executed on the ANE. The measured non-zero ANE telemetry is nevertheless direct evidence that the ANE power signal was observed during the workload window.

---

## 12. Comparison With Earlier GPU Test

The experiment complements the earlier Metal GPU test.

### Metal GPU test

```text
GPU Average Power: 7.191 W
GPU Peak Power:    7.261 W
GPU Energy:        0.0201 Wh
ANE:               0 W
```

### Core ML ANE test

```text
ANE Average Power: 2.85 W
ANE Peak Power:    2.928 W
ANE Energy:        0.00544 Wh
GPU Average Power: 0.000841 W
```

Together, these controlled workloads demonstrate that SigSense's existing component telemetry can respond differently to deliberately targeted GPU and Neural Engine workloads.

---

## 13. End-to-End Measurement Path

```text
Core ML neural-network workload
            ↓
CPU + Neural Engine configuration
            ↓
macOS compute execution
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

## 14. What This Test Demonstrates

This experiment validates that:

- A Core ML neural-network workload can be generated and executed on the test Mac.
- The workload can be configured to use CPU + Neural Engine while excluding the GPU.
- SigSense records a substantial non-zero ANE hardware signal during the workload.
- Existing component-level telemetry fields are sufficient to surface CPU, GPU, ANE, and total power.
- The Transparency layer correlates telemetry with workload/run/attempt/context identity.
- Deterministic attribution can assign the observed measurement to the tracked workload.
- Carbon and water calculations flow from the observed energy measurements using live grid data.
- The CLI can expose the component-level evidence directly in a terminal report.

---

## 15. Limitations

- This is a short controlled workload, not a production ML workload.
- The test uses CPU + Neural Engine rather than Neural Engine-only execution.
- The measured ANE signal should be treated as hardware telemetry evidence rather than proof that every neural-network operation executed on the ANE.
- Power behavior can vary with thermal state, battery/AC state, background processes, and system configuration.
- This test validates the ANE path on the tested Mac; it does not establish identical readings across other Apple Silicon systems.
- No clean differential baseline should be inferred from the CLI's earlier zero-observation run. The primary result of this experiment is the successful ANE measurement itself.

---

## 16. Cleanup

The temporary test environment and files can be removed after the experiment if no longer needed:

```bash
rm -rf /tmp/ane-venv
rm -f /tmp/make_ane_model.py
rm -f /tmp/ane_burn.mlmodel
rm -f /tmp/ane_burn.swift
```

Restore the Mac's normal power-saving configuration after the experiment if it was changed only for testing.

---

## 17. Conclusion

**RESULT: PASS**

This experiment successfully exercised the Apple Neural Engine measurement path for the first time in the documented SigSense test record.

The final EcoPrint report recorded:

```text
ANE Average Power: 2.85 W
ANE Peak Power:    2.928 W
ANE Energy:        0.00544 Wh

Total Average Power: 5.121 W
Total Energy:        0.00978124 Wh

Carbon: 0.0047732465 gCO2e
Water:  0.000018779986 L

Telemetry observations: 6
Attribution coverage: 100%
Measurement source: hardware
Grid source: live
```

This closes an important validation gap in the telemetry engine:

```text
CPU telemetry     ✅ tested
GPU telemetry     ✅ tested
ANE telemetry     ✅ tested
```

The GPU and ANE experiments together provide controlled hardware-path evidence that SigSense's component-level telemetry is capable of observing different classes of compute workloads and exposing those measurements through EcoPrint Transparency.
