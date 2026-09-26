#ifndef TELEMETRY_H
#define TELEMETRY_H

#include "tracker.h"

double getNetworkLatency();
void runContinuousTelemetry(EcoPrintTracker& liveSession);

// Expose the Linux function explicitly if compiling on a Linux system
#ifdef __linux__
void runLinuxTelemetryLoop(EcoPrintTracker& liveSession);
#endif

// Expose the Mac function explicitly if compiling on Apple Silicon
#ifdef __APPLE__
void runMacTelemetryLoop(EcoPrintTracker& liveSession);
#endif

#endif // TELEMETRY_H