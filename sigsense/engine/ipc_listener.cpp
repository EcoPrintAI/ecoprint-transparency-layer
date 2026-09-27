#include "ipc_listener.h"
#include <iostream>
#include <cstring>
#include <cstdlib>
#include <utility>

extern std::atomic<bool> telemetryActive;

#ifndef _WIN32
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <sys/stat.h>
#include <grp.h>
#else
#include <windows.h>
#include <sddl.h>
#endif

namespace {
bool validRunId(const std::string& id) {
    if (id.empty() || id.size() > 64) return false;
    for (unsigned char c : id) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
              (c >= 'A' && c <= 'F') || c == '-')) return false;
    }
    return true;
}
}

IPCListener::IPCListener(const std::string& path, std::atomic<bool>& keepRunningRef,
                         std::function<void(bool, bool)> telemetryStateChangedCallback)
    : socketPath(path), keepRunning(keepRunningRef), listening(false),
      telemetryStateChanged(std::move(telemetryStateChangedCallback)), serverFd(-1)
#ifdef _WIN32
      , serverHandle(INVALID_HANDLE_VALUE)
#endif
{}

IPCListener::~IPCListener() { stop(); }

void IPCListener::start() {
    if (listening.exchange(true)) return;
    listenerThread = std::thread(&IPCListener::listenLoop, this);
}

void IPCListener::stop() {
    if (!listening.exchange(false)) return;
#ifndef _WIN32
    if (serverFd != -1) {
        shutdown(serverFd, SHUT_RDWR);
        close(serverFd);
        serverFd = -1;
    }
    unlink(socketPath.c_str());
#else
    if (serverHandle != INVALID_HANDLE_VALUE) {
        CancelIoEx(static_cast<HANDLE>(serverHandle), nullptr);
        CloseHandle(static_cast<HANDLE>(serverHandle));
        serverHandle = INVALID_HANDLE_VALUE;
    }
#endif
    if (listenerThread.joinable()) listenerThread.join();
}

void IPCListener::listenLoop() {
#ifndef _WIN32
    unlink(socketPath.c_str());
    serverFd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (serverFd < 0) {
        std::cerr << "[IPC ERROR] Failed to create Unix socket\n";
        listening = false;
        return;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (socketPath.size() >= sizeof(addr.sun_path)) {
        std::cerr << "[IPC ERROR] Socket path is too long\n";
        close(serverFd);
        serverFd = -1;
        listening = false;
        return;
    }
    std::strncpy(addr.sun_path, socketPath.c_str(), sizeof(addr.sun_path) - 1);
    if (bind(serverFd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::cerr << "[IPC ERROR] Failed to bind protected socket: " << socketPath << "\n";
        close(serverFd);
        serverFd = -1;
        listening = false;
        return;
    }

    if (chmod(socketPath.c_str(), 0660) != 0) {
        std::cerr << "[IPC ERROR] Could not set socket permissions\n";
        close(serverFd);
        serverFd = -1;
        unlink(socketPath.c_str());
        listening = false;
        return;
    }
    if (const char* groupName = std::getenv("ECOPRINT_IPC_GROUP")) {
        if (group* target = getgrnam(groupName)) chown(socketPath.c_str(), 0, target->gr_gid);
    }
    if (listen(serverFd, 8) < 0) {
        close(serverFd);
        serverFd = -1;
        unlink(socketPath.c_str());
        listening = false;
        return;
    }
    std::cout << "[IPC] Protected local socket listening at " << socketPath << std::endl;

    while (listening && keepRunning) {
        const int clientFd = accept(serverFd, nullptr, nullptr);
        if (clientFd < 0) {
            if (!listening) break;
            continue;
        }
        char buffer[128]{};
        const ssize_t bytesRead = read(clientFd, buffer, sizeof(buffer) - 1);
        std::string command = bytesRead > 0 ? std::string(buffer, static_cast<size_t>(bytesRead)) : "";
        const size_t newline = command.find_first_of("\r\n");
        if (newline != std::string::npos) command.resize(newline);

        std::string response = "ERR invalid-command\n";
        if (command == "PING") {
            response = "OK PONG\n";
        } else if (command == "STATUS") {
            std::lock_guard<std::mutex> lock(runsMutex);
            response = std::string("OK ") + (activeRuns.empty() ? "IDLE" : "COLLECTING") +
                " " + std::to_string(activeRuns.size()) + "\n";
        } else if (command.rfind("BEGIN ", 0) == 0 || command.rfind("END ", 0) == 0) {
            const bool begin = command.rfind("BEGIN ", 0) == 0;
            const std::string runId = command.substr(begin ? 6 : 4);
            if (validRunId(runId)) {
                bool active;
                {
                    std::lock_guard<std::mutex> lock(runsMutex);
                    if (begin) activeRuns.insert(runId);
                    else activeRuns.erase(runId);
                    active = !activeRuns.empty();
                }
                if (telemetryStateChanged) telemetryStateChanged(active, !begin);
                else telemetryActive = active;
                response = std::string("OK ") + (active ? "COLLECTING" : "IDLE") + "\n";
            } else {
                response = "ERR invalid-run-id\n";
            }
        }
        write(clientFd, response.data(), response.size());
        close(clientFd);
    }
    if (serverFd != -1) {
        close(serverFd);
        serverFd = -1;
    }
    unlink(socketPath.c_str());
#else
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;BU)", SDDL_REVISION_1,
            &descriptor, nullptr)) {
        listening = false;
        return;
    }
    attributes.lpSecurityDescriptor = descriptor;
    std::wstring pipeName(socketPath.begin(), socketPath.end());
    std::wcout << L"[IPC] Protected named pipe listening at " << pipeName << std::endl;
    while (listening && keepRunning) {
        HANDLE pipe = CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES, 128, 128, 1000, &attributes);
        if (pipe == INVALID_HANDLE_VALUE) break;
        serverHandle = pipe;
        const BOOL connected = ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED;
        if (connected) {
            char buffer[128]{};
            DWORD bytesRead = 0;
            if (ReadFile(pipe, buffer, sizeof(buffer) - 1, &bytesRead, nullptr) && bytesRead > 0) {
                std::string command(buffer, bytesRead);
                std::string response = "ERR invalid-command\n";
                if (command == "PING\n" || command == "PING") response = "OK PONG\n";
                else if (command == "STATUS\n" || command == "STATUS") {
                    std::lock_guard<std::mutex> lock(runsMutex);
                    response = std::string("OK ") + (activeRuns.empty() ? "IDLE" : "COLLECTING") + " " + std::to_string(activeRuns.size()) + "\n";
                } else if (command.rfind("BEGIN ", 0) == 0 || command.rfind("END ", 0) == 0) {
                    const bool begin = command.rfind("BEGIN ", 0) == 0;
                    std::string id = command.substr(begin ? 6 : 4);
                    while (!id.empty() && (id.back() == '\n' || id.back() == '\r')) id.pop_back();
                    if (validRunId(id)) {
                        bool active;
                        {
                            std::lock_guard<std::mutex> lock(runsMutex);
                            if (begin) activeRuns.insert(id); else activeRuns.erase(id);
                            active = !activeRuns.empty();
                        }
                        if (telemetryStateChanged) telemetryStateChanged(active, !begin);
                        else telemetryActive = active;
                        response = std::string("OK ") + (active ? "COLLECTING" : "IDLE") + "\n";
                    } else response = "ERR invalid-run-id\n";
                }
                DWORD written = 0;
                WriteFile(pipe, response.data(), static_cast<DWORD>(response.size()), &written, nullptr);
            }
        }
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        serverHandle = INVALID_HANDLE_VALUE;
    }
    LocalFree(descriptor);
#endif
}
