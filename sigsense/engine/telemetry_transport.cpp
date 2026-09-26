#include <sqlite3.h>
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <chrono>
#include <cstdio>
#include <cstdlib>

const char* AGGREGATOR_URL =
    "http://10.0.0.56:3001/api/telemetry/ingest";

const char* DB_PATH = "ecoprint_telemetry.db";

int main() {
    sqlite3* db = nullptr;

    if (sqlite3_open_v2(DB_PATH, &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) {
        std::cerr << "[TRANSPORT ERROR] Cannot open telemetry database: "
                  << sqlite3_errmsg(db) << std::endl;
        return 1;
    }

    std::cout << "[TRANSPORT] EcoPrint telemetry transport started." << std::endl;
    std::cout << "[TRANSPORT] Aggregator: " << AGGREGATOR_URL << std::endl;

    long long lastProcessedId = 0;

    while (true) {
        sqlite3_stmt* stmt = nullptr;

        const char* query =
            "SELECT id, timestamp, cpu_mw, gpu_mw, ane_mw, "
            "total_power_watts, client_workload_watts, "
            "ecoprint_overhead_watts, carbon_gCO2e, water_liters, "
            "latency_ms, delta_time "
            "FROM telemetry "
            "WHERE id > ? "
            "ORDER BY id ASC;";

        if (sqlite3_prepare_v2(db, query, -1, &stmt, nullptr) != SQLITE_OK) {
            std::cerr << "[TRANSPORT ERROR] Failed to prepare query." << std::endl;
            break;
        }

        sqlite3_bind_int64(stmt, 1, lastProcessedId);

        std::stringstream payload;
        payload << "{";
        payload << "\"node_id\":\"ecoprintai-e402sa\",";
        payload << "\"region\":\"US-MIDW-MISO\",";
        payload << "\"building_id\":\"HQ-Main\",";
        payload << "\"department\":\"Engineering\",";
        payload << "\"metrics\":[";

        bool first = true;
        long long newestId = lastProcessedId;

        while (sqlite3_step(stmt) == SQLITE_ROW) {
            if (!first) payload << ",";
            first = false;

            long long id = sqlite3_column_int64(stmt, 0);
            const unsigned char* timestamp = sqlite3_column_text(stmt, 1);

            payload << "{";
            payload << "\"id\":" << id << ",";
            payload << "\"timestamp\":\""
                    << (timestamp ? reinterpret_cast<const char*>(timestamp) : "")
                    << "\",";
            payload << "\"cpu_mw\":" << sqlite3_column_double(stmt, 2) << ",";
            payload << "\"gpu_mw\":" << sqlite3_column_double(stmt, 3) << ",";
            payload << "\"ane_mw\":" << sqlite3_column_double(stmt, 4) << ",";
            payload << "\"total_power_watts\":" << sqlite3_column_double(stmt, 5) << ",";
            payload << "\"client_workload_watts\":" << sqlite3_column_double(stmt, 6) << ",";
            payload << "\"ecoprint_overhead_watts\":" << sqlite3_column_double(stmt, 7) << ",";
            payload << "\"carbon_gCO2e\":" << sqlite3_column_double(stmt, 8) << ",";
            payload << "\"water_liters\":" << sqlite3_column_double(stmt, 9) << ",";
            payload << "\"latency_ms\":" << sqlite3_column_int64(stmt, 10) << ",";
            payload << "\"delta_time\":" << sqlite3_column_double(stmt, 11);
            payload << "}";

            newestId = id;
        }

        sqlite3_finalize(stmt);

        payload << "]}";

        if (newestId > lastProcessedId) {
            const char* tempFile = "/tmp/ecoprint_transport.json";

            {
                std::ofstream out(tempFile);
                out << payload.str();
            }

            std::string command =
                "curl -sS --max-time 10 "
                "-X POST "
                "-H 'Content-Type: application/json' "
                "--data-binary @/tmp/ecoprint_transport.json "
                "'" + std::string(AGGREGATOR_URL) + "'";

            std::cout << "[TRANSPORT] Sending telemetry through aggregator..."
                      << std::endl;

            int result = std::system(command.c_str());

            if (result == 0) {
                std::cout << "[TRANSPORT] ✓ Telemetry accepted by aggregator."
                          << std::endl;
                lastProcessedId = newestId;
            } else {
                std::cerr << "[TRANSPORT ERROR] Aggregator request failed."
                          << std::endl;
            }

            std::remove(tempFile);
        }

        std::this_thread::sleep_for(std::chrono::seconds(2));
    }

    sqlite3_close(db);
    return 0;
}
