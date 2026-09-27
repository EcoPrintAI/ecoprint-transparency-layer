#include <iostream>
#include <chrono>
#include <condition_variable>
#include <thread>
#include <csignal>
#include <atomic>
#include <cstdlib>
#include <string>
#include "tracker.h"
#include "telemetry.h"
#include "ipc_listener.h"

#ifdef _WIN32
#include <windows.h>
#endif

std::atomic<bool> keepRunning(true);
std::atomic<bool> telemetryActive(false);
std::mutex telemetryStateMutex;
#ifdef __APPLE__
std::condition_variable telemetrySampleCondition;
bool telemetrySampleInFlight = false;
bool telemetryStopRequested = false;
#endif

namespace {
std::string databasePath = "ecoprint_telemetry.db";
std::string configPath = "ecoprint.conf";
#ifdef _WIN32
SERVICE_STATUS serviceStatus{};
SERVICE_STATUS_HANDLE serviceStatusHandle = nullptr;

void reportServiceStatus(DWORD state, DWORD exitCode = NO_ERROR) {
    serviceStatus.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    serviceStatus.dwCurrentState = state;
    serviceStatus.dwWin32ExitCode = exitCode;
    serviceStatus.dwWaitHint = state == SERVICE_STOP_PENDING ? 10000 : 0;
    serviceStatus.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
    if (serviceStatusHandle) SetServiceStatus(serviceStatusHandle, &serviceStatus);
}
#endif

void signalHandler(int) { keepRunning = false; }

int runEngine(const std::string& socketPath) {
    keepRunning = true;
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    std::cout << "==================================================" << std::endl;
    std::cout << "    ECOPRINT TRANSPARENCY TELEMETRY SERVICE       " << std::endl;
    std::cout << "==================================================" << std::endl;

    EcoPrintTracker tracker(databasePath, 1, 1.92, configPath);
    IPCListener ipc(socketPath, keepRunning, [&tracker](bool active, bool endMarker) {
        std::unique_lock<std::mutex> lock(telemetryStateMutex);
#ifdef __APPLE__
        if (endMarker) {
            telemetryStopRequested = true;
            telemetrySampleCondition.notify_all();
            telemetrySampleCondition.wait(lock, [] { return !telemetrySampleInFlight; });
            telemetryActive = active;
            tracker.forceFlush();
            telemetryStopRequested = false;
            telemetrySampleCondition.notify_all();
            return;
        }
#endif
        telemetryActive = active;
#ifndef __APPLE__
        if (endMarker) tracker.forceFlush();
#endif
#ifdef __APPLE__
        if (active) telemetrySampleCondition.notify_all();
#endif
    });
    ipc.start();

#if defined(_WIN32)
    runContinuousTelemetry(tracker);
#elif defined(__linux__)
    runLinuxTelemetryLoop(tracker);
#elif defined(__APPLE__)
    runMacTelemetryLoop(tracker);
#else
    while (keepRunning) {
        if (telemetryActive) tracker.recordMetric(0, 0, 0, 0.320, 0.001, 0, 1.0, "unknown", "estimated-simulator");
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
#endif

    ipc.stop();
    tracker.forceFlush();
    return 0;
}

#ifdef _WIN32
DWORD WINAPI serviceControlHandler(DWORD control, DWORD, LPVOID, LPVOID) {
    if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
        reportServiceStatus(SERVICE_STOP_PENDING);
        keepRunning = false;
    }
    return NO_ERROR;
}

void WINAPI serviceMain(DWORD, LPWSTR*) {
    serviceStatusHandle = RegisterServiceCtrlHandlerExW(L"EcoPrintSigSense", serviceControlHandler, nullptr);
    if (!serviceStatusHandle) return;
    reportServiceStatus(SERVICE_START_PENDING);
    std::string pipe = "\\\\.\\pipe\\ecoprint-transparency";
    if (const char* configured = std::getenv("ECOPRINT_IPC_PATH")) pipe = configured;
    const int result = runEngine(pipe);
    reportServiceStatus(SERVICE_STOPPED, result == 0 ? NO_ERROR : ERROR_SERVICE_SPECIFIC_ERROR);
}
#endif
}

int main(int argc, char** argv) {
    bool serviceMode = false;
    std::string socketPath;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--service") serviceMode = true;
        else if ((arg == "--db" || arg == "--config" || arg == "--socket") && i + 1 < argc) {
            const std::string value = argv[++i];
            if (arg == "--db") databasePath = value;
            else if (arg == "--config") configPath = value;
            else socketPath = value;
        } else if (arg == "--help") {
            std::cout << "Usage: v3engine [--service] [--db PATH] [--config PATH] [--socket PATH]\n";
            return 0;
        } else {
            std::cerr << "Unknown argument: " << arg << '\n';
            return 2;
        }
    }
    if (socketPath.empty()) {
#ifdef _WIN32
        socketPath = "\\\\.\\pipe\\ecoprint-transparency";
#elif defined(__APPLE__)
        socketPath = "/var/run/ecoprint.sock";
#else
        socketPath = "/run/ecoprint/ecoprint.sock";
#endif
    }
#ifdef _WIN32
    _putenv_s("ECOPRINT_IPC_PATH", socketPath.c_str());
#else
    setenv("ECOPRINT_IPC_PATH", socketPath.c_str(), 1);
    std::signal(SIGPIPE, SIG_IGN);
#endif

#ifdef _WIN32
    if (serviceMode) {
        SERVICE_TABLE_ENTRYW services[] = {
            { const_cast<LPWSTR>(L"EcoPrintSigSense"), serviceMain },
            { nullptr, nullptr },
        };
        if (!StartServiceCtrlDispatcherW(services)) {
            std::cerr << "Unable to connect to Windows Service Control Manager.\n";
            return 1;
        }
        return 0;
    }
#else
    (void)serviceMode;
#endif
    return runEngine(socketPath);
}
