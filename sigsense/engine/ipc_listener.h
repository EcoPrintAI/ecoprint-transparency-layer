#ifndef IPC_LISTENER_H
#define IPC_LISTENER_H

#include <string>
#include <atomic>
#include <thread>
#include <set>
#include <mutex>
#include <functional>

class IPCListener {
public:
    IPCListener(const std::string& path, std::atomic<bool>& keepRunningRef,
                std::function<void(bool, bool)> telemetryStateChanged = {});
    ~IPCListener();

    void start();
    void stop();

private:
    void listenLoop();

    std::string socketPath;
    std::atomic<bool>& keepRunning;
    std::atomic<bool> listening;
    // Arguments are (whether any run remains active, whether this was END).
    std::function<void(bool, bool)> telemetryStateChanged;
#ifndef _WIN32
    int serverFd;
#else
    void* serverHandle;
#endif
    std::set<std::string> activeRuns;
    std::mutex runsMutex;
    std::thread listenerThread;
};

#endif // IPC_LISTENER_H
