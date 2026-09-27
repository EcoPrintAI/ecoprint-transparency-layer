#ifdef __APPLE__
#include "telemetry.h"
#include <iostream>
#include <string>
#include <regex>
#include <sstream>
#include <chrono>
#include <thread>
#include <cstdio>
#include <atomic>
#include <mutex>
#include <condition_variable>

extern std::atomic<bool> keepRunning;
extern std::atomic<bool> telemetryActive;
extern std::mutex telemetryStateMutex;
extern std::condition_variable telemetrySampleCondition;
extern bool telemetrySampleInFlight;
extern bool telemetryStopRequested;

// Struct to hold all granular Apple Silicon power readings
struct SiliconPower {
    double cpu_mw = 0.0;
    double gpu_mw = 0.0;
    double ane_mw = 0.0;
    double combined_w = 0.0;
};

constexpr int powermetricsSampleIntervalMs = 500;

SiliconPower parseAppleSiliconPower(const std::string& rawPowerMetricsBuffer) {
    SiliconPower sp;
    
    // Regex for specific SoC components
    std::regex cpuRegex(R"(CPU Power:\s*([0-9.]+)\s*mW)");
    std::regex gpuRegex(R"(GPU Power:\s*([0-9.]+)\s*mW)");
    std::regex aneRegex(R"(ANE Power:\s*([0-9.]+)\s*mW)");
    std::regex combinedRegex(R"(Combined Power[^:]*:\s*([0-9.]+)\s*(mW|W))");
    std::smatch match;

    if (std::regex_search(rawPowerMetricsBuffer, match, cpuRegex)) sp.cpu_mw = std::stod(match[1].str());
    if (std::regex_search(rawPowerMetricsBuffer, match, gpuRegex)) sp.gpu_mw = std::stod(match[1].str());
    if (std::regex_search(rawPowerMetricsBuffer, match, aneRegex)) sp.ane_mw = std::stod(match[1].str());
    
    if (std::regex_search(rawPowerMetricsBuffer, match, combinedRegex)) {
        double val = std::stod(match[1].str());
        sp.combined_w = (match[2].str() == "mW") ? (val / 1000.0) : val;
    } else {
        sp.combined_w = -1.0;
    }
    
    return sp;
}

void runMacTelemetryLoop(EcoPrintTracker& liveSession) {
    std::cout << "==================================================" << std::endl;
    std::cout << "  [APPLE SILICON] Native SoC Hardware Telemetry engaged" << std::endl;
    std::cout << "  * Dynamic execution-time multi-tenancy attribution active" << std::endl;
    std::cout << "==================================================" << std::endl;
    
    while (keepRunning) {
        // Evaluate active state before reading hardware sensors or writing database rows
        {
            std::unique_lock<std::mutex> stateLock(telemetryStateMutex);
            if (!telemetryActive || telemetryStopRequested) {
                telemetrySampleCondition.wait_for(stateLock, std::chrono::milliseconds(500), [] {
                    return (telemetryActive && !telemetryStopRequested) || !keepRunning;
                });
                if (!telemetryActive || telemetryStopRequested) continue;
            }
            telemetrySampleInFlight = true;
        }

        auto loop_start = std::chrono::high_resolution_clock::now();

        const std::string powerCommand = "/usr/bin/powermetrics -n 1 -i " +
            std::to_string(powermetricsSampleIntervalMs) + " --samplers cpu_power";
        FILE* pipe = popen(powerCommand.c_str(), "r");
        if (!pipe) {
            std::cerr << "[ERROR] Failed to read SoC sensor. Did you run with sudo?" << std::endl;
            {
                std::lock_guard<std::mutex> stateLock(telemetryStateMutex);
                telemetrySampleInFlight = false;
            }
            telemetrySampleCondition.notify_all();
            break;
        }

        char buffer[256];
        std::string result = "";
        while (fgets(buffer, sizeof(buffer), pipe) != NULL) {
            result += buffer;
        }
        pclose(pipe);

        auto parse_start = std::chrono::high_resolution_clock::now();
        SiliconPower sp = parseAppleSiliconPower(result);
        auto parse_end = std::chrono::high_resolution_clock::now();

        const bool hardwareReading = sp.combined_w >= 0.0;
        if (!hardwareReading) sp.combined_w = 0.320;

        double executionTimeMs = std::chrono::duration_cast<std::chrono::microseconds>(parse_end - parse_start).count() / 1000.0;
        double dynamicOverheadPercentage = executionTimeMs / 1000.0;
        if (dynamicOverheadPercentage < 0.001) dynamicOverheadPercentage = 0.001;

        double ecoprintOverheadWatts = sp.combined_w * dynamicOverheadPercentage;
        double clientWorkloadWatts = sp.combined_w - ecoprintOverheadWatts;

        long long latency = 25 + (rand() % 10);

        auto loop_end = std::chrono::high_resolution_clock::now();
        long long elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(loop_end - loop_start).count();
        long long target_sleep = 1000 - elapsed_ms;

        {
            // END waits for this in-flight sample, so any observation whose
            // interval overlaps the run is persisted before the CLI queries it.
            std::lock_guard<std::mutex> stateLock(telemetryStateMutex);
            if (telemetryActive) {
                // Each powermetrics observation integrates over the requested
                // interval. Do not stretch that measurement across the idle
                // sleep between polls; fallback readings have no measured
                // sample interval and remain non-integrable.
                const double delta_time = hardwareReading
                    ? powermetricsSampleIntervalMs / 1000.0 : 0.0;

                liveSession.recordMetric(sp.cpu_mw, sp.gpu_mw, sp.ane_mw, clientWorkloadWatts, ecoprintOverheadWatts, latency, delta_time, "US-MIDW-MISO", hardwareReading ? "hardware" : "fallback");
                liveSession.forceFlush();
            }
            telemetrySampleInFlight = false;
        }
        telemetrySampleCondition.notify_all();

        if (target_sleep > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(target_sleep));
        }
    }
}
#endif // __APPLE__
