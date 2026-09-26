#ifdef __linux__
 
#include "telemetry.h"
#include <iostream>
#include <fstream>
#include <string>
#include <chrono>
#include <thread>
#include <cstdlib>
#include <ctime>
#include <atomic>
#include <unistd.h>
#include <sys/stat.h>

extern std::atomic<bool> keepRunning;
extern std::atomic<bool> telemetryActive;
 
// RAPL Detection & Reading (Intel/AMD Energy Counters)
bool hasRAPLSupport() {
    std::string raplPath = "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj";
    struct stat buffer;
    return (stat(raplPath.c_str(), &buffer) == 0);
}
 
double readRAPLPower() {
    std::string raplPath = "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj";
    
    auto readEnergy = [](const std::string& path) -> long long {
        std::ifstream file(path);
        if (!file.is_open()) return -1;
        std::string line;
        if (std::getline(file, line)) {
            file.close();
            try {
                return std::stoll(line);
            } catch (...) {
                return -1;
            }
        }
        file.close();
        return -1;
    };
 
    long long energy1 = readEnergy(raplPath);
    if (energy1 == -1) return -1.0;
 
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
 
    long long energy2 = readEnergy(raplPath);
    if (energy2 == -1) return -1.0;
 
    long long energyDelta = energy2 - energy1;
    if (energyDelta < 0) return -1.0;
 
    double watts = (energyDelta / 0.1) / 1000000.0;
    return watts;
}
 
// Battery Fallback (Works on Laptops)
double readBatteryPower() {
    std::string batPath = "/sys/class/power_supply/BAT0/power_now";
    
    std::ifstream file(batPath);
    if (!file.is_open()) {
        batPath = "/sys/class/power_supply/BAT1/power_now";
        file.open(batPath);
    }
 
    if (!file.is_open()) return -1.0;
 
    std::string line;
    if (std::getline(file, line)) {
        file.close();
        try {
            double microwatts = std::stod(line);
            return microwatts / 1000000.0;
        } catch (...) {
            return -1.0;
        }
    }
 
    file.close();
    return -1.0;
}
 
// Primary Power Detection Layer
double readLinuxPowerMetrics(bool& usingRAPL, bool& usingBattery) {
    double raplWatts = readRAPLPower();
    if (raplWatts > 0.0) {
        usingRAPL = true;
        usingBattery = false;
        return raplWatts;
    }
 
    double batteryWatts = readBatteryPower();
    if (batteryWatts > 0.0) {
        usingRAPL = false;
        usingBattery = true;
        return batteryWatts;
    }
 
    usingRAPL = false;
    usingBattery = false;
    return 0.250;
}
 
// Main Linux Telemetry Loop
void runLinuxTelemetryLoop(EcoPrintTracker& liveSession) {
    std::cout << "==================================================" << std::endl;
    std::cout << "  [LINUX DRIVER] Initializing Native SysFS Telemetry" << std::endl;
    std::cout << "==================================================" << std::endl;
 
    bool raplAvailable = hasRAPLSupport();
    bool usingRAPL = false;
    bool usingBattery = false;
 
    if (raplAvailable) {
        std::cout << "[DETECTION] ✓ RAPL (Running Average Power Limit) detected." << std::endl;
    } else {
        std::cout << "[DETECTION] ⚠ RAPL not detected. Checking for battery metrics..." << std::endl;
        double testBattery = readBatteryPower();
        if (testBattery > 0.0) {
            std::cout << "             ✓ Battery power_now found at /sys/class/power_supply/" << std::endl;
        } else {
            std::cout << "             ℹ No battery or RAPL detected. Sandbox mode active." << std::endl;
        }
    }
 
    std::srand(static_cast<unsigned int>(std::time(nullptr)));
 
    int iteration = 0;
    std::chrono::steady_clock::time_point lastSampleAt;
    bool hasLastSample = false;
    while (keepRunning) {
        // Pause check: prevents RAPL reads or SQLite insertion while paused
        if (!telemetryActive) {
            hasLastSample = false;
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            continue;
        }

        auto loop_start = std::chrono::high_resolution_clock::now();
 
        double rawWatts = readLinuxPowerMetrics(usingRAPL, usingBattery);
 
        double clientWorkloadWatts = rawWatts * 0.92;      
        double ecoprintOverheadWatts = rawWatts * 0.08;    
        long long simulatedLatency = 22 + (std::rand() % 8);
 
        auto loop_end = std::chrono::high_resolution_clock::now();
        long long elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(loop_end - loop_start).count();
        auto sampleAt = std::chrono::steady_clock::now();
        double delta_time = hasLastSample
            ? std::chrono::duration<double>(sampleAt - lastSampleAt).count() : 0.0;

        // Synchronized 12-channel database commit call
        liveSession.recordMetric(
            clientWorkloadWatts * 1000.0,
            0.0,                          
            0.0,                          
            clientWorkloadWatts,          
            ecoprintOverheadWatts,        
            simulatedLatency,             
            delta_time,                   
            "US-MIDW-MISO",
            usingRAPL ? "hardware-rapl" : (usingBattery ? "hardware-battery" : "fallback")
        );
        lastSampleAt = sampleAt;
        hasLastSample = true;
 
        iteration++;
 
        if (iteration % 60 == 0) {
            std::string sourceLabel = usingRAPL ? "[RAPL]" : (usingBattery ? "[BATTERY]" : "[SANDBOX]");
            std::cout << "[DIAGNOSTIC] " << iteration / 60 << " min elapsed | Source: " 
                      << sourceLabel << " | Raw: " << rawWatts << " W" << std::endl;
        }
 
        long long target_sleep = 1000 - elapsed_ms;
        if (target_sleep > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(target_sleep));
        }
    }
 
    std::cout << "\n[SHUTDOWN] Linux telemetry loop halting gracefully..." << std::endl;
}
 
#endif // __linux__
