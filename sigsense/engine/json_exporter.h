#ifndef JSON_EXPORTER_H
#define JSON_EXPORTER_H

#include <sqlite3.h>
#include <string>

class JsonExporter {
private:
    sqlite3* readDb;
    int targetSessionId;
    long long lastProcessedId;

public:
    JsonExporter(const std::string& dbPath, int sessionId);
    ~JsonExporter();

    std::string fetchNewMetricsAsJson();
};

#endif // JSON_EXPORTER_H