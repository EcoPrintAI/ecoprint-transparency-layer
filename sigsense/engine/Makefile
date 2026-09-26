# EcoPrint SigSense Engine — Makefile
# Target: macOS (Apple Silicon / arm64), Linux, Windows cross-compile
#
# Usage:
#   make            — build v3engine (default)
#   make transport  — build telemetry_transport daemon
#   make all        — build both
#   make run        — build and run v3engine (must be invoked from sigsense/engine/)
#   make clean      — remove compiled objects and binaries
#
# IMPORTANT: v3engine and telemetry_transport resolve ecoprint.conf and
# ecoprint_telemetry.db relative to the working directory.
# Always run them from sigsense/engine/, not from the repo root.
#
# Requirements (macOS): Xcode Command Line Tools (clang++, sqlite3 via SDK)
# Requirements (Linux):  g++ / clang++, libsqlite3-dev

CXX      ?= clang++
CXXFLAGS  = -std=c++17 -O2 -Wall -Wextra

# macOS: resolve SDK paths automatically via xcrun
UNAME := $(shell uname -s)

ifeq ($(UNAME), Darwin)
    SDKPATH  := $(shell xcrun --show-sdk-path)
    CXXFLAGS += -isysroot $(SDKPATH) -I$(SDKPATH)/usr/include
    LDFLAGS   = -isysroot $(SDKPATH) -L$(SDKPATH)/usr/lib -lsqlite3
else
    LDFLAGS   = -lsqlite3
endif

# ── Engine binary (v3engine) ──────────────────────────────────────────────────
ENGINE_SRCS = \
    main.cpp \
    tracker.cpp \
    grid_intensity.cpp \
    ipc_listener.cpp \
    json_exporter.cpp \
    telemetry_apple.cpp \
    telemetry_linux.cpp \
    telemetry_win.cpp

ENGINE_OBJS = $(ENGINE_SRCS:.cpp=.o)
ENGINE_BIN  = v3engine

# ── Transport daemon (telemetry_transport) ────────────────────────────────────
TRANSPORT_SRCS = telemetry_transport.cpp
TRANSPORT_OBJS = $(TRANSPORT_SRCS:.cpp=.o)
TRANSPORT_BIN  = telemetry_transport

# ── Default target ────────────────────────────────────────────────────────────
.PHONY: all engine transport clean

all: engine transport

engine: $(ENGINE_BIN)

transport: $(TRANSPORT_BIN)

$(ENGINE_BIN): $(ENGINE_OBJS)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDFLAGS)
	@echo "[BUILD] $(ENGINE_BIN) compiled successfully."

$(TRANSPORT_BIN): $(TRANSPORT_OBJS)
	$(CXX) $(CXXFLAGS) -o $@ $^ $(LDFLAGS)
	@echo "[BUILD] $(TRANSPORT_BIN) compiled successfully."

# ── Pattern rule — compile each .cpp to .o ───────────────────────────────────
%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c -o $@ $<

# ── Run (enforces correct working directory) ──────────────────────────────────
run: engine
	./$(ENGINE_BIN)

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	rm -f $(ENGINE_OBJS) $(TRANSPORT_OBJS) $(ENGINE_BIN) $(TRANSPORT_BIN)
	@echo "[CLEAN] Build artefacts removed."
