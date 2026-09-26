#include "tracker.h"
#include <iostream>
#include <chrono>
#include <cstdio> 
#include <iomanip>
#include <ctime>
#include <sstream>

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

static std::string getUtcTimestamp() {
    const auto now = std::chrono::system_clock::now();
    const std::time_t nowTime = std::chrono::system_clock::to_time_t(now);

    std::tm utcTime{};

#ifdef _WIN32
    gmtime_s(&utcTime, &nowTime);
#else
    gmtime_r(&nowTime, &utcTime);
#endif

    std::ostringstream timestamp;
    timestamp << std::put_time(&utcTime, "%Y-%m-%dT%H:%M:%SZ");
    return timestamp.str();
}

EcoPrintTracker::EcoPrintTracker(const std::string& dbPath, int sessionId, double waterFactor)
    : currentSessionId(sessionId),
      targetWaterFactor(waterFactor),
      nodeId("unknown-node"),
      batchFlushThreshold(10),
      isRunning(true),
      gridService("ecoprint.conf", "ELECTRICITY_MAPS") {

        #ifdef _WIN32
            char hostname[256];
            DWORD hostnameSize = sizeof(hostname);
            if (GetComputerNameA(hostname, &hostnameSize)) {
                nodeId = hostname;
            }
        #else
            char hostname[256];

            if (gethostname(hostname, sizeof(hostname)) == 0) {
                hostname[sizeof(hostname) - 1] = '\0';
                nodeId = hostname;
            }
        #endif

            std::cout << "[NODE] Runtime node ID: " << nodeId << std::endl;
    
    if (sqlite3_open(dbPath.c_str(), &db) != SQLITE_OK) {
        std::cerr << "[CRITICAL] Failed to open database: " << sqlite3_errmsg(db) << std::endl;
        db = nullptr;
        return;
    }

    char* errMsg = nullptr;
    sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nullptr, nullptr, &errMsg);

    // UPDATED: Added multi-node enterprise tags (node_id, region, building_id, department)
    std::string createTable = "CREATE TABLE IF NOT EXISTS telemetry ("
                               "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                               "session_id INTEGER, "
                               "node_id TEXT DEFAULT 'local-node-01', "
                               "region TEXT DEFAULT 'US-MIDW-MISO', "
                               "building_id TEXT DEFAULT 'HQ-Main', "
                               "department TEXT DEFAULT 'Engineering', "
                               "timestamp TEXT, "
                               "cpu_mw REAL, "
                               "gpu_mw REAL, "
                               "ane_mw REAL, "
                               "total_power_watts REAL, "
                               "client_workload_watts REAL, "
                               "ecoprint_overhead_watts REAL, "
                               "carbon_gCO2e REAL, "
                               "water_liters REAL, "
                               "latency_ms INTEGER, "
                               "delta_time REAL);";
    
    sqlite3_exec(db, "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, start_time TEXT, init_zone TEXT);", nullptr, nullptr, &errMsg);
    sqlite3_exec(db, createTable.c_str(), nullptr, nullptr, &errMsg);

    std::string timeStr = getUtcTimestamp();

    std::string insertSession = "INSERT INTO sessions (start_time, init_zone) VALUES ('" + timeStr + "', 'US-MIDW-MISO');";
    if (sqlite3_exec(db, insertSession.c_str(), nullptr, nullptr, &errMsg) == SQLITE_OK) {
        currentSessionId = static_cast<int>(sqlite3_last_insert_rowid(db));
        std::cout << "[DATABASE] Successfully registered fresh tracking session ID: #" << currentSessionId << std::endl;
    } else {
        currentSessionId = 999; 
    }
    
    startFlushTimer();
    gridService.start();

    std::cout << "[GRID] Grid-intensity service initialized." << std::endl;
}

EcoPrintTracker::~EcoPrintTracker() {
    gridService.stop();
    isRunning = false;
    if (timerThread.joinable()) timerThread.join(); 
    
    forceFlush();

    long long avgLatency = (latencySamples > 0) ? (totalLatency / latencySamples) : 0;
    double totalEnergy = cumulativeClientEnergy + cumulativeOverheadEnergy;
    double eeIndex = (totalEnergy > 0.0) ? (cumulativeClientEnergy / totalEnergy) * 100.0 : 100.0;

    std::printf("\n=====================================================\n");
    std::printf("    ECOPRINT AI: FINAL AUDIT COMPLIANCE AUDIT\n");
    std::printf("=====================================================\n");
    std::printf("Active Grid Region Target: US-MIDW-MISO\n");
    std::printf("1. CLIENT WORKLOAD EMISSIONS:\n");
    std::printf("   -> Total Energy: %.8f kWh\n", cumulativeClientEnergy); 
    std::printf("   -> Total Carbon: %.8f gCO2e\n", cumulativeClientCarbon);
    std::printf("   -> Total Water:  %.8f Liters\n", cumulativeClientWater);
    std::printf("2. ECOPRINT OBSERVER OVERHEAD:\n");
    std::printf("   -> Total Energy: %.8f kWh\n", cumulativeOverheadEnergy);
    std::printf("   -> Total Carbon: %.8f gCO2e\n", cumulativeOverheadCarbon);
    std::printf("   -> Total Water:  %.8f Liters\n", cumulativeOverheadWater);
    std::printf("-----------------------------------------------------\n");
    std::printf("SYSTEM METRIC: Energy Efficiency Index: %.1f%%\n", eeIndex);
    std::printf("Network Link Quality: Avg %lld ms | Peak %lld ms\n", avgLatency, maxLatency);
    std::printf("=====================================================\n\n");

    if (db) sqlite3_close(db);
    std::cout << "[SUCCESS] Storage Engine safely disengaged. File ecoprint_telemetry.db flushed." << std::endl;
}

void EcoPrintTracker::startFlushTimer() {
    timerThread = std::thread([this]() {
        while (isRunning) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            if (!isRunning) break;
            std::lock_guard<std::mutex> lock(trackerMutex);
            flushBatchToDatabase(); 
        }
    });
}

void EcoPrintTracker::recordMetric(double cpu_mw, double gpu_mw, double ane_mw, double clientPower, double overheadPower, long long latency, double delta_time, const std::string& gridRegion) {
    std::lock_guard<std::mutex> lock(trackerMutex); 
    std::string timeStr = getUtcTimestamp(); 

    double totalPower = clientPower + overheadPower;

    GridIntensitySnapshot grid = gridService.getSnapshot();

    double gridIntensity = grid.carbonIntensity;

    if (gridIntensity <= 0.0) {
        gridIntensity = 376.0;
    }

    double clientEnergyKwh = clientPower / 3600000.0;
    double overheadEnergyKwh = overheadPower / 3600000.0;

    double clientCarbon = clientEnergyKwh * gridIntensity;
    double overheadCarbon = overheadEnergyKwh * gridIntensity;

    cumulativeClientEnergy += clientEnergyKwh;
    cumulativeClientCarbon += (clientPower * gridIntensity / 3600000.0);
    cumulativeClientWater += (clientEnergyKwh * targetWaterFactor);

    cumulativeOverheadEnergy += overheadEnergyKwh;
    cumulativeOverheadCarbon += (overheadPower * gridIntensity / 3600000.0);
    cumulativeOverheadWater += (overheadEnergyKwh * targetWaterFactor);

    if (latency > maxLatency) maxLatency = latency;
    totalLatency += latency;
    latencySamples++;
    sampleCounter++;

    std::printf("--- Telemetry: %s [%s] | CPU: %.0f mW | GPU: %.0f mW | ANE: %.0f mW | Total Power: %.3f W ---\n", timeStr.c_str(), gridRegion.c_str(), cpu_mw, gpu_mw, ane_mw, totalPower);
    std::printf("    ├── Client Workload: %.3f W | Carbon: %.6f gCO2e | Water: %.8f L\n", clientPower, (clientCarbon), (clientPower * (targetWaterFactor / 3600000.0)));
    std::printf("    └── EcoPrint Engine: %.3f W | Carbon: %.6f gCO2e | Water: %.8f L | Latency: %lld ms | Delta: %.3f s\n", overheadPower, (overheadCarbon), (overheadPower * (targetWaterFactor / 3600000.0)), latency, delta_time);

    memoryBuffer.push_back({
        timeStr,
        cpu_mw,
        gpu_mw,
        ane_mw,
        totalPower,
        clientPower,
        overheadPower,
        (totalPower * gridIntensity / 3600000.0),
        (totalPower * (targetWaterFactor / 3600000.0)),
        latency,
        delta_time
    });

    if (sampleCounter % 10 == 0) {
        std::printf("\n>>> ECOPRINT AI: AUDIT INTERVAL SUMMARY <<<\n");
        std::printf("Total Energy: %.8f kWh\nTotal Carbon: %.8f gCO2e\nTotal Water:  %.8f Liters\n--------------------------------------------------\n\n", 
                    (cumulativeClientEnergy + cumulativeOverheadEnergy), (cumulativeClientCarbon + cumulativeOverheadCarbon), (cumulativeClientWater + cumulativeOverheadWater));
    }
    if (memoryBuffer.size() >= batchFlushThreshold) flushBatchToDatabase(); 
}

void EcoPrintTracker::forceFlush() {
    std::lock_guard<std::mutex> lock(trackerMutex); 
    flushBatchToDatabase();
}

void EcoPrintTracker::flushBatchToDatabase() {
    if (!db || memoryBuffer.empty()) return;
    char* errMsg = nullptr;
    sqlite3_exec(db, "BEGIN TRANSACTION;", nullptr, nullptr, &errMsg);
    sqlite3_stmt* stmt;
    
    // UPDATED: Insert statement now includes node_id, region, building_id, department tags
    std::string q = "INSERT INTO telemetry (session_id, node_id, region, building_id, department, timestamp, cpu_mw, gpu_mw, ane_mw, total_power_watts, client_workload_watts, ecoprint_overhead_watts, carbon_gCO2e, water_liters, latency_ms, delta_time) VALUES (?, ?, 'US-MIDW-MISO', 'HQ-Main', 'Engineering', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);";
    
    if (sqlite3_prepare_v2(db, q.c_str(), -1, &stmt, nullptr) == SQLITE_OK) {
        for (const auto& row : memoryBuffer) {
            sqlite3_bind_int(stmt, 1, currentSessionId);
            sqlite3_bind_text(stmt, 2, nodeId.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_bind_text(stmt, 3, row.timestamp.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_bind_double(stmt, 4, row.cpu_mw);
            sqlite3_bind_double(stmt, 5, row.gpu_mw);
            sqlite3_bind_double(stmt, 6, row.ane_mw);
            sqlite3_bind_double(stmt, 7, row.totalPower);
            sqlite3_bind_double(stmt, 8, row.clientWorkload);
            sqlite3_bind_double(stmt, 9, row.ecoPrintOverhead);
            sqlite3_bind_double(stmt, 10, row.carbonEmissions);
            sqlite3_bind_double(stmt, 11, row.waterConsumption);
            sqlite3_bind_int64(stmt, 12, row.latencyMs);
            sqlite3_bind_double(stmt, 13, row.delta_time);
            
            sqlite3_step(stmt);
            sqlite3_reset(stmt); 
        }
        sqlite3_finalize(stmt);
    }
    sqlite3_exec(db, "COMMIT;", nullptr, nullptr, &errMsg);
    memoryBuffer.clear(); 
}