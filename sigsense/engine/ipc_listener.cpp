#include "ipc_listener.h"
#include <iostream>
#include <atomic>

extern std::atomic<bool> telemetryActive;

#ifndef _WIN32
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

IPCListener::IPCListener(const std::string& path, std::atomic<bool>& keepRunningRef)
    : socketPath(path), keepRunning(keepRunningRef), listening(false), serverFd(-1) {}

IPCListener::~IPCListener() {
    stop();
}

void IPCListener::start() {
    listening = true;
    listenerThread = std::thread(&IPCListener::listenLoop, this);
}

void IPCListener::stop() {
    if (!listening) return;
    listening = false;
    
    if (serverFd != -1) {
        close(serverFd);
        serverFd = -1;
    }
    
    unlink(socketPath.c_str());
    
    if (listenerThread.joinable()) {
        listenerThread.join();
    }
}

void IPCListener::listenLoop() {
    unlink(socketPath.c_str());

    serverFd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (serverFd < 0) {
        std::cerr << "[IPC ERROR] Failed to create socket\n";
        return;
    }

    struct timeval tv{};
    tv.tv_sec = 1;
    tv.tv_usec = 0;
    setsockopt(serverFd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, socketPath.c_str(), sizeof(addr.sun_path) - 1);

    if (bind(serverFd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        std::cerr << "[IPC ERROR] Failed to bind IPC socket at " << socketPath << "\n";
        close(serverFd);
        return;
    }

    chmod(socketPath.c_str(), 0777);

    if (listen(serverFd, 5) < 0) {
        std::cerr << "[IPC ERROR] Failed to listen on IPC socket\n";
        close(serverFd);
        return;
    }

    std::cout << "[IPC ENGINE] Control socket initialized at: " << socketPath << std::endl;

    while (listening && keepRunning) {
        int clientFd = accept(serverFd, nullptr, nullptr);
        if (clientFd < 0) continue;

        char buffer[128] = {0};
        ssize_t bytesRead = read(clientFd, buffer, sizeof(buffer) - 1);
        if (bytesRead > 0) {
            std::string cmd(buffer);
            cmd.erase(cmd.find_last_not_of(" \n\r\t") + 1);

            if (cmd == "STATUS") {
                std::string response = telemetryActive ? "COLLECTING\n" : "PAUSED\n";
                write(clientFd, response.c_str(), response.length());
            } else if (cmd == "PAUSE") {
                telemetryActive = false;
                std::cout << "\n[IPC SIGNAL] Telemetry collection PAUSED.\n" << std::flush;
            } else if (cmd == "START" || cmd == "RESUME") {
                telemetryActive = true;
                std::cout << "\n[IPC SIGNAL] Telemetry collection RESUMED.\n" << std::flush;
            } else if (cmd == "TERMINATE" || cmd == "STOP") {
                std::cout << "\n[IPC SIGNAL] Shutdown command received. Terminating C++ engine.\n" << std::flush;
                telemetryActive = false;
                keepRunning = false;
                close(clientFd);
                break;
            }
        }
        close(clientFd);
    }
}

#else
// Windows implementation stub
IPCListener::IPCListener(const std::string& path, std::atomic<bool>& keepRunningRef)
    : socketPath(path), keepRunning(keepRunningRef), listening(false) {}

IPCListener::~IPCListener() {}
void IPCListener::start() {
    std::cout << "[IPC ENGINE] Windows Mode: Local POSIX IPC control disabled." << std::endl;
    std::cout << "[IPC ENGINE] Distributed telemetry transport handled via HTTP aggregator." << std::endl;
}
void IPCListener::stop() {}
void IPCListener::listenLoop() {}
#endif