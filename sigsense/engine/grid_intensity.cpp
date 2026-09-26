#include "grid_intensity.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

namespace {

std::string trim(const std::string& value) {
    const std::string whitespace = " \t\r\n";

    const auto first = value.find_first_not_of(whitespace);
    if (first == std::string::npos) return "";

    const auto last = value.find_last_not_of(whitespace);
    return value.substr(first, last - first + 1);
}

std::string utcNow() {
    const auto now = std::chrono::system_clock::now();
    const std::time_t time = std::chrono::system_clock::to_time_t(now);

    std::tm utc{};
#ifdef _WIN32
    gmtime_s(&utc, &time);
#else
    gmtime_r(&time, &utc);
#endif

    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return buffer;
}

} // namespace

GridIntensityService::GridIntensityService(
    const std::string& configPath,
    const std::string& provider)
    : configPath(configPath),
      provider(provider) {

    loadConfiguration();

    currentIntensity = fallbackIntensity;

    std::cout << "[GRID] Provider: " << this->provider << std::endl;
    std::cout << "[GRID] Zone: " << zone << std::endl;
    std::cout << "[GRID] Fallback intensity: "
              << fallbackIntensity << " gCO2e/kWh" << std::endl;
}

GridIntensityService::~GridIntensityService() {
    stop();
}

bool GridIntensityService::loadConfiguration() {
    std::ifstream config(configPath);

    if (!config.is_open()) {
        std::cerr << "[GRID] Configuration file unavailable. "
                     "Using fallback grid intensity."
                  << std::endl;
        setFallback();
        return false;
    }

    std::string line;

    while (std::getline(config, line)) {
        line = trim(line);

        if (line.empty() || line[0] == '#') {
            continue;
        }

        const auto separator = line.find('=');

        if (separator == std::string::npos) {
            continue;
        }

        const std::string key = trim(line.substr(0, separator));
        const std::string value = trim(line.substr(separator + 1));

        if (key == "API_KEY") {
            apiKey = value;
        } else if (key == "ZONE") {
            zone = value;
        } else if (key == "DEFAULT_INTENSITY") {
            try {
                fallbackIntensity = std::stod(value);
            } catch (...) {
                std::cerr << "[GRID] Invalid DEFAULT_INTENSITY. "
                             "Keeping fallback."
                          << std::endl;
            }
        }
    }

    if (zone.empty()) {
        zone = "US-MIDW-MISO";
    }

    currentIntensity = fallbackIntensity;
    live = false;

    return true;
}

void GridIntensityService::setFallback() {
    std::lock_guard<std::mutex> lock(stateMutex);

    currentIntensity = fallbackIntensity;
    live = false;
    updatedAt = utcNow();
}

bool GridIntensityService::fetchElectricityMapsIntensity() {
    if (apiKey.empty()) {
        std::cerr << "[GRID] Electricity Maps API key unavailable."
                  << std::endl;
        return false;
    }

    if (zone.empty()) {
        std::cerr << "[GRID] Electricity Maps zone unavailable."
                  << std::endl;
        return false;
    }

    std::string command =
        "curl -sS --max-time 5 "
        "-H \"auth-token: " + apiKey + "\" "
        "\"https://api.electricitymaps.com/v3/carbon-intensity/latest?zone="
        + zone + "\"";

    FILE* pipe = popen(command.c_str(), "r");

    if (!pipe) {
        std::cerr << "[GRID] Failed to launch Electricity Maps request."
                  << std::endl;
        return false;
    }

    char buffer[512];
    std::string response;

    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        response += buffer;
    }

    const int exitCode = pclose(pipe);

    if (exitCode != 0 || response.empty()) {
        std::cerr << "[GRID] Electricity Maps request failed."
                  << std::endl;
        return false;
    }

    const std::string key = "\"carbonIntensity\":";
    const std::size_t position = response.find(key);

    if (position == std::string::npos) {
        std::cerr << "[GRID] carbonIntensity missing from API response."
                  << std::endl;
        return false;
    }

    const std::size_t valueStart = position + key.length();

    try {
        const double intensity =
            std::stod(response.substr(valueStart));

        if (intensity <= 0.0) {
            std::cerr << "[GRID] Invalid carbon intensity received."
                      << std::endl;
            return false;
        }

        {
            std::lock_guard<std::mutex> lock(stateMutex);

            currentIntensity = intensity;
            live = true;
            updatedAt = utcNow();
        }

        std::cout << "[GRID] Electricity Maps update: "
                  << currentIntensity
                  << " gCO2e/kWh | Zone: "
                  << zone
                  << std::endl;

        return true;

    } catch (const std::exception&) {
        std::cerr << "[GRID] Failed to parse carbon intensity."
                  << std::endl;
        return false;
    }
}

void GridIntensityService::workerLoop() {
    std::cout << "[GRID] Async grid-intensity worker started." << std::endl;

    while (running) {

        if (provider == "ELECTRICITY_MAPS") {
            if (!fetchElectricityMapsIntensity()) {
                std::lock_guard<std::mutex> lock(stateMutex);

                currentIntensity = fallbackIntensity;
                live = false;
                updatedAt = utcNow();

                std::cout << "[GRID] Live provider unavailable; "
                             "using fallback "
                          << currentIntensity
                          << " gCO2e/kWh."
                          << std::endl;
            }
        }

        /*
         * Do not block shutdown for a full hour.
         * Wake periodically and check the running flag.
         */
        for (int i = 0; i < 3600 && running; ++i) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }

    std::cout << "[GRID] Async grid-intensity worker stopped."
              << std::endl;
}

void GridIntensityService::start() {
    if (running) return;

    running = true;
    workerThread = std::thread(&GridIntensityService::workerLoop, this);
}

void GridIntensityService::stop() {
    running = false;

    if (workerThread.joinable()) {
        workerThread.join();
    }
}

GridIntensitySnapshot GridIntensityService::getSnapshot() const {
    std::lock_guard<std::mutex> lock(stateMutex);

    GridIntensitySnapshot snapshot;

    snapshot.carbonIntensity = currentIntensity;
    snapshot.zone = zone;
    snapshot.provider = provider;
    snapshot.updatedAt = updatedAt;
    snapshot.live = live;

    return snapshot;
}
