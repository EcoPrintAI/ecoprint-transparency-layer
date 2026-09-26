#ifndef TRACKER_H
#define TRACKER_H

#include <string>
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <sqlite3.h>
#include "grid_intensity.h"

struct TelemetrySnapshot {
    std::string timestamp;
    double cpu_mw;        // NEW: Silicon Tracking
    double gpu_mw;        // NEW: Silicon Tracking
    double ane_mw;        // NEW: Silicon Tracking
    double totalPower;
    double clientWorkload;
    double ecoPrintOverhead;
    double carbonEmissions;
    double waterConsumption;
    long long latencyMs;
    double delta_time;    // NEW: Drift Tracking
};

class EcoPrintTracker {
public:
    EcoPrintTracker(const std::string& dbPath, int sessionId, double waterFactor);
    ~EcoPrintTracker();

    // UPDATED: Added CPU, GPU, ANE, and Delta to the input parameters
    void recordMetric(double cpu_mw, double gpu_mw, double ane_mw, double clientPower, double overheadPower, long long latency, double delta_time, const std::string& gridRegion);
    void forceFlush();

private:
    void startFlushTimer();
    void flushBatchToDatabase();

    sqlite3* db;
    int currentSessionId;
    double targetWaterFactor;
    std::string nodeId;
    
    std::vector<TelemetrySnapshot> memoryBuffer;
    size_t batchFlushThreshold;
    
    std::mutex trackerMutex;
    std::thread timerThread;
    std::atomic<bool> isRunning;
    GridIntensityService gridService;

    long long sampleCounter = 0;
    double cumulativeClientEnergy = 0.0;
    double cumulativeClientCarbon = 0.0;
    double cumulativeClientWater = 0.0;
    
    double cumulativeOverheadEnergy = 0.0;
    double cumulativeOverheadCarbon = 0.0;
    double cumulativeOverheadWater = 0.0;

    long long maxLatency = 0;
    long long totalLatency = 0;
    long long latencySamples = 0;
};

#endif // TRACKER_H