#include <iostream>
#include <chrono>
#include <thread>
#include <csignal>
#include <atomic>
#include <cstdlib>
#include "tracker.h"
#include "telemetry.h"
#include "ipc_listener.h"

std::atomic<bool> keepRunning(true);
std::atomic<bool> telemetryActive(true); // Sampling state control

void signalHandler(int signum) {
    if (signum == SIGINT) {
        std::cout << "\n[SIGNAL] Control+C intercepted! Requesting graceful shutdown...\n" << std::flush;
        keepRunning = false;
    }
}

int main() {
    std::signal(SIGINT, signalHandler);

    std::cout << "==================================================" << std::endl;
    std::cout << "    ECOPRINT AI — PERFORMANCE TELEMETRY ENGINE    " << std::endl;
    std::cout << "==================================================" << std::endl;
    std::cout << "Master Relational DB Session Engaged [TARGET GRID: US-MIDW-MISO]" << std::endl;

    EcoPrintTracker tracker("ecoprint_telemetry.db", 1, 1.92);

    IPCListener ipc("/tmp/ecoprint.sock", keepRunning);
    ipc.start();

    #if defined(_WIN32)
        std::cout << "[SYSTEM] Windows Platform Detected. Starting PDH Telemetry Loop..." << std::endl;
        runContinuousTelemetry(tracker);

    #elif defined(__linux__)
        std::cout << "[SYSTEM] Linux Platform Detected. Starting SysFS Telemetry Loop..." << std::endl;
        runLinuxTelemetryLoop(tracker);

    #elif defined(__APPLE__)
        std::cout << "[SYSTEM] Apple Silicon Detected. Engaging Native SMC Hardware Telemetry..." << std::endl;
        runMacTelemetryLoop(tracker);

    #else
        std::cout << "[SYSTEM] Sandbox Simulator Pipeline Active..." << std::endl;
        double mockClientPower = 0.320;
        double mockOverheadPower = 0.001;
        long long mockLatency = 30;

        while (keepRunning) {
            if (telemetryActive) {
                tracker.recordMetric(150.0, 45.0, 0.0, mockClientPower, mockOverheadPower, mockLatency, 1.015, "US-MIDW-MISO");
                mockClientPower += 0.005;
                if (mockClientPower > 0.400) mockClientPower = 0.295;
                mockLatency = 25 + (std::rand() % 10);
            }
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    #endif

    std::cout << "[SHUTDOWN] Halting background loops safely..." << std::endl;
    tracker.forceFlush();

    return 0;
}