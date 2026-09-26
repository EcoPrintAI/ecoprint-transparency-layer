#ifndef IPC_LISTENER_H
#define IPC_LISTENER_H

#include <string>
#include <atomic>
#include <thread>

class IPCListener {
public:
    IPCListener(const std::string& path, std::atomic<bool>& keepRunningRef);
    ~IPCListener();

    void start();
    void stop();

private:
    void listenLoop();

    std::string socketPath;
    std::atomic<bool>& keepRunning;
    bool listening;
#ifndef _WIN32
    int serverFd;
#endif
    std::thread listenerThread;
};

#endif // IPC_LISTENER_H