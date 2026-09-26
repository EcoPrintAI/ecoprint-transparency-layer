#ifndef GRID_INTENSITY_H
#define GRID_INTENSITY_H

#include <atomic>
#include <mutex>
#include <string>
#include <thread>

struct GridIntensitySnapshot {
    double carbonIntensity = 0.0;
    std::string zone;
    std::string provider;
    std::string updatedAt;
    bool live = false;
};

class GridIntensityService {
public:
    GridIntensityService(const std::string& configPath,
                         const std::string& provider = "WATTTIME");
    ~GridIntensityService();

    void start();
    void stop();

    GridIntensitySnapshot getSnapshot() const;

private:
    void workerLoop();
    bool loadConfiguration();
    bool fetchElectricityMapsIntensity();
    void setFallback();

    std::string configPath;
    std::string provider;

    std::string apiKey;
    std::string zone;

    double fallbackIntensity = 376.0;
    double currentIntensity = 376.0;

    mutable std::mutex stateMutex;
    std::thread workerThread;
    std::atomic<bool> running{false};
    bool live = false;
    std::string updatedAt;
};

#endif
