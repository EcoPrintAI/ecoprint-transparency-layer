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
        const carbon = Number(row.carbon_gCO2e ?? 0) * fraction;
        const water = Number(row.water_liters ?? 0) * fraction;
        const totalPower = Number(row.total_power_watts ?? 0);
        const clientPower = row.client_workload_power_watts;
        const overheadPower = row.ecoprint_overhead_power_watts;
        const splitAvailable = clientPower != null && overheadPower != null && totalPower > 0
            && Math.abs(Number(clientPower) + Number(overheadPower) - totalPower) <= Math.max(1e-9, Math.abs(totalPower) * 1e-6);
        return {
            ...row,
            interval_seconds: includedSeconds,
            interval_start: new Date(clippedStart).toISOString(),
            interval_end: new Date(clippedEnd).toISOString(),
            attribution_timestamp: new Date(clippedStart + (clippedEnd - clippedStart) / 2).toISOString(),
            carbon_gCO2e: carbon,
            water_liters: water,
            client_workload_carbon_gCO2e: splitAvailable ? carbon * Number(clientPower) / totalPower : null,
            ecoprint_overhead_carbon_gCO2e: splitAvailable ? carbon * Number(overheadPower) / totalPower : null,
            client_workload_water_liters: splitAvailable ? water * Number(clientPower) / totalPower : null,
            ecoprint_overhead_water_liters: splitAvailable ? water * Number(overheadPower) / totalPower : null,
        };
    }).filter(row => row.interval_seconds > 0);
}

export function summarizeTelemetry(rows) {
    let durationSeconds = 0;
    let energyWh = 0;
    let carbon = 0;
    let water = 0;
    let peakPower = null;
    const components = Object.fromEntries(['cpu', 'gpu', 'ane'].map(component => [component, {
        durationSeconds: 0, energyWh: 0, peakPower: null, samples: 0,
    }]));
    const allocations = Object.fromEntries(['client_workload', 'ecoprint_overhead'].map(name => [name, {
        durationSeconds: 0, energyWh: 0, peakPower: null, samples: 0, carbon: 0, water: 0,
        environmentalSamples: 0,
    }]));

    for (const row of rows) {
        const seconds = Number(row.interval_seconds ?? row.delta_time ?? 0);
        if (!(seconds > 0)) continue;
        const power = Number(row.total_power_watts ?? 0);
        durationSeconds += seconds;
        energyWh += power * seconds / 3600;
        carbon += Number(row.carbon_gCO2e ?? 0);
        water += Number(row.water_liters ?? 0);
        peakPower = peakPower === null ? power : Math.max(peakPower, power);
        const splitNames = Object.keys(allocations);
        const splitValues = splitNames.map(name => row[`${name}_power_watts`]);
        const validSplits = splitValues.every(value => value != null && Number.isFinite(Number(value)));
        const splitSum = validSplits ? splitValues.reduce((sum, value) => sum + Number(value), 0) : null;
        const splitsReconcile = validSplits && Math.abs(splitSum - power) <= Math.max(1e-9, Math.abs(power) * 1e-6);
        for (const [name, summary] of Object.entries(allocations)) {
            const value = row[`${name}_power_watts`];
            if (value == null || !Number.isFinite(Number(value))) continue;
            const splitPower = Number(value);
            summary.durationSeconds += seconds;
            summary.energyWh += splitPower * seconds / 3600;
            summary.peakPower = summary.peakPower === null ? splitPower : Math.max(summary.peakPower, splitPower);
            summary.samples++;
            if (splitsReconcile && power > 0) {
                const fraction = splitPower / power;
                summary.carbon += Number(row.carbon_gCO2e ?? 0) * fraction;
                summary.water += Number(row.water_liters ?? 0) * fraction;
                summary.environmentalSamples++;
            }
        }
        for (const [component, summary] of Object.entries(components)) {
            const value = row[`${component}_power_watts`];
            if (value == null || !Number.isFinite(Number(value))) continue;
            const componentPower = Number(value);
            summary.durationSeconds += seconds;
            summary.energyWh += componentPower * seconds / 3600;
            summary.peakPower = summary.peakPower === null
                ? componentPower : Math.max(summary.peakPower, componentPower);
            summary.samples++;
        }
    }

    const averagePower = durationSeconds > 0 ? energyWh * 3600 / durationSeconds : 0;
    const result = {
        duration_seconds: durationSeconds,
        power_watts: averagePower,
        peak_power_watts: peakPower,
        energy_wh: energyWh,
        energy_kwh: energyWh / 1000,
        carbon_gco2e: carbon,
        water_liters: water,
    };
    for (const [component, summary] of Object.entries(components)) {
        const prefix = `${component}_`;
        const available = summary.durationSeconds > 0;
        result[`${prefix}power_watts`] = available ? summary.energyWh * 3600 / summary.durationSeconds : null;
        result[`${prefix}peak_power_watts`] = available ? summary.peakPower : null;
        result[`${prefix}energy_wh`] = available ? summary.energyWh : null;
        result[`${prefix}energy_kwh`] = available ? summary.energyWh / 1000 : null;
        result[`${prefix}duration_seconds`] = available ? summary.durationSeconds : null;
        result[`${prefix}telemetry_count`] = summary.samples;
    }
    for (const [name, summary] of Object.entries(allocations)) {
        const prefix = `${name}_`;
        const available = summary.durationSeconds > 0;
        const envAvailable = available && summary.environmentalSamples === summary.samples;
        result[`${prefix}power_watts`] = available ? summary.energyWh * 3600 / summary.durationSeconds : null;
        result[`${prefix}peak_power_watts`] = available ? summary.peakPower : null;
        result[`${prefix}energy_wh`] = available ? summary.energyWh : null;
        result[`${prefix}energy_kwh`] = available ? summary.energyWh / 1000 : null;
        result[`${prefix}duration_seconds`] = available ? summary.durationSeconds : null;
        result[`${prefix}carbon_gco2e`] = envAvailable ? summary.carbon : null;
        result[`${prefix}water_liters`] = envAvailable ? summary.water : null;
        result[`${prefix}telemetry_count`] = summary.samples;
        result[`${prefix}environmental_allocation`] = envAvailable ? 'proportional-to-power' : 'unavailable';
    }
    return result;
}
