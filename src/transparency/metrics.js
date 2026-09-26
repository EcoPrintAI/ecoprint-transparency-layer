/** Time-aware telemetry normalization and summary calculations. */

export function prepareTelemetryRows(rows, windowStart, windowEnd) {
    const startMs = Date.parse(windowStart);
    const endMs = Date.parse(windowEnd);
    return rows.map((row) => {
        const sampleEnd = Date.parse(row.timestamp);
        const reportedSeconds = Number(row.interval_seconds ?? row.delta_time ?? 0);
        const seconds = Number.isFinite(reportedSeconds) && reportedSeconds > 0
            ? reportedSeconds : 0;
        if (!Number.isFinite(sampleEnd)) {
            return { ...row, interval_seconds: 0, carbon_gCO2e: 0, water_liters: 0 };
        }
        const intervalStart = sampleEnd - seconds * 1000;
        const clippedStart = Number.isFinite(startMs) ? Math.max(intervalStart, startMs) : intervalStart;
        const clippedEnd = Number.isFinite(endMs) ? Math.min(sampleEnd, endMs) : sampleEnd;
        const includedSeconds = Math.max(0, (clippedEnd - clippedStart) / 1000);
        const fraction = seconds > 0 ? includedSeconds / seconds : 0;
        return {
            ...row,
            interval_seconds: includedSeconds,
            interval_start: new Date(clippedStart).toISOString(),
            interval_end: new Date(clippedEnd).toISOString(),
            attribution_timestamp: new Date(clippedStart + (clippedEnd - clippedStart) / 2).toISOString(),
            carbon_gCO2e: (row.carbon_gCO2e ?? 0) * fraction,
            water_liters: (row.water_liters ?? 0) * fraction,
        };
    }).filter(row => row.interval_seconds > 0);
}

export function summarizeTelemetry(rows) {
    let durationSeconds = 0;
    let energyWh = 0;
    let carbon = 0;
    let water = 0;
    let peakPower = null;

    for (const row of rows) {
        const seconds = Number(row.interval_seconds ?? row.delta_time ?? 0);
        if (!(seconds > 0)) continue;
        const power = Number(row.total_power_watts ?? 0);
        durationSeconds += seconds;
        energyWh += power * seconds / 3600;
        carbon += Number(row.carbon_gCO2e ?? 0);
        water += Number(row.water_liters ?? 0);
        peakPower = peakPower === null ? power : Math.max(peakPower, power);
    }

    const averagePower = durationSeconds > 0 ? energyWh * 3600 / durationSeconds : 0;
    return {
        duration_seconds: durationSeconds,
        power_watts: averagePower,
        peak_power_watts: peakPower,
        energy_wh: energyWh,
        energy_kwh: energyWh / 1000,
        carbon_gco2e: carbon,
        water_liters: water,
    };
}
