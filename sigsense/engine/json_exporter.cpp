#include "json_exporter.h"
#include <iostream>
#include <sstream>
#include <iomanip>

JsonExporter::JsonExporter(const std::string& dbPath, int sessionId)
    : targetSessionId(sessionId), lastProcessedId(0), readDb(nullptr) {
    int flags = SQLITE_OPEN_READONLY;
    if (sqlite3_open_v2(dbPath.c_str(), &readDb, flags, nullptr) != SQLITE_OK) {
        std::cerr << "[EXPORTER ERROR] Failed to open database read-only: "
                  << sqlite3_errmsg(readDb) << std::endl;
        readDb = nullptr;
    }
}

JsonExporter::~JsonExporter() {
    if (readDb) {
        sqlite3_close(readDb);
    }
}

std::string JsonExporter::fetchNewMetricsAsJson() {
    if (!readDb) return "[]";

    std::stringstream jsonStream;
    jsonStream << std::fixed << std::setprecision(6);
    jsonStream << "[\n";

    std::string query = "SELECT id, timestamp, cpu_mw, gpu_mw, ane_mw, "
                        "total_power_watts, client_workload_watts, ecoprint_overhead_watts, "
                        "carbon_gCO2e, water_liters, latency_ms, delta_time "
                        "FROM telemetry WHERE session_id = ? AND id > ? ORDER BY id ASC;";
    
    sqlite3_stmt* stmt;
    bool holdsData = false;

    if (sqlite3_prepare_v2(readDb, query.c_str(), -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, targetSessionId);
        sqlite3_bind_int64(stmt, 2, lastProcessedId);

        while (sqlite3_step(stmt) == SQLITE_ROW) {
            if (holdsData) jsonStream << ",\n";
            holdsData = true;

            long long rowId = sqlite3_column_int64(stmt, 0);
            lastProcessedId = rowId;

            const unsigned char* timestamp = sqlite3_column_text(stmt, 1);
            double cpu_mw = sqlite3_column_double(stmt, 2);
            double gpu_mw = sqlite3_column_double(stmt, 3);
            double ane_mw = sqlite3_column_double(stmt, 4);
            double totalPower = sqlite3_column_double(stmt, 5);
            double clientWorkload = sqlite3_column_double(stmt, 6);
            double overhead = sqlite3_column_double(stmt, 7);
            double carbon = sqlite3_column_double(stmt, 8);
            double water = sqlite3_column_double(stmt, 9);
            long long latency = sqlite3_column_int64(stmt, 10);
            double deltaTime = sqlite3_column_double(stmt, 11);

            jsonStream << "  {\n"
                       << "    \"id\": " << rowId << ",\n"
                       << "    \"timestamp\": \"" << (timestamp ? reinterpret_cast<const char*>(timestamp) : "") << "\",\n"
                       << "    \"cpu_mw\": " << cpu_mw << ",\n"
                       << "    \"gpu_mw\": " << gpu_mw << ",\n"
                       << "    \"ane_mw\": " << ane_mw << ",\n"
                       << "    \"total_power_watts\": " << totalPower << ",\n"
                       << "    \"client_workload_watts\": " << clientWorkload << ",\n"
                       << "    \"ecoprint_overhead_watts\": " << overhead << ",\n"
                       << "    \"carbon_gCO2e\": " << carbon << ",\n"
                       << "    \"water_liters\": " << water << ",\n"
                       << "    \"latency_ms\": " << latency << ",\n"
                       << "    \"delta_time\": " << deltaTime << "\n"
                       << "  }";
        }
        sqlite3_finalize(stmt);
    }

    jsonStream << "\n]";
    return jsonStream.str();
}