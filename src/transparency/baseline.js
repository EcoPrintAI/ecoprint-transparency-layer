import { dbGet, dbRun } from './db.js';

const FIELDS = [
    ['duration_ms', 'Duration (ms)'],
    ['average_power_watts', 'Average Power (W)'],
    ['peak_power_watts', 'Peak Power (W)'],
    ['cpu_average_power_watts', 'CPU Average Power (W)'],
    ['gpu_average_power_watts', 'GPU Average Power (W)'],
    ['ane_average_power_watts', 'ANE Average Power (W)'],
    ['energy_wh', 'Energy (Wh)'],
    ['cpu_energy_wh', 'CPU Energy (Wh)'],
    ['gpu_energy_wh', 'GPU Energy (Wh)'],
    ['ane_energy_wh', 'ANE Energy (Wh)'],
    ['client_workload_energy_wh', 'Client Energy (Wh)'],
    ['ecoprint_overhead_energy_wh', 'EcoPrint Energy (Wh)'],
    ['measurement_efficiency_pct', 'Client Energy Share (%)'],
    ['carbon_gco2e', 'Carbon (gCO2e)'],
    ['water_liters', 'Water (L)'],
    ['attribution_coverage', 'Attribution coverage (%)'],
];

export async function findBaseline(db, workloadId, currentRunId) {
    return dbGet(db, `
        SELECT rm.*, r.run_id AS baseline_run_id, r.ended_at AS baseline_ended_at
        FROM run_metrics rm JOIN runs r ON r.run_id = rm.run_id
        WHERE r.workload_id = ? AND r.run_id != ? AND r.status = 'completed'
        ORDER BY r.ended_at DESC LIMIT 1`, [workloadId, currentRunId]);
}

export async function saveRunMetrics(db, runId, metrics) {
    await dbRun(db, `INSERT OR REPLACE INTO run_metrics
        (run_id, duration_ms, average_power_watts, peak_power_watts, energy_wh,
         carbon_gco2e, water_liters, attribution_coverage, measurement_quality,
         grid_intensity_quality, cpu_average_power_watts, cpu_peak_power_watts, cpu_energy_wh,
         gpu_average_power_watts, gpu_peak_power_watts, gpu_energy_wh,
         ane_average_power_watts, ane_peak_power_watts, ane_energy_wh,
         client_workload_average_power_watts, client_workload_peak_power_watts,
         client_workload_energy_wh, client_workload_carbon_gco2e, client_workload_water_liters,
         ecoprint_overhead_average_power_watts, ecoprint_overhead_peak_power_watts,
         ecoprint_overhead_energy_wh, ecoprint_overhead_carbon_gco2e, ecoprint_overhead_water_liters,
         measurement_efficiency_pct, measurement_method, allocation_method, provenance_quality,
         process_context_count, process_lineage_coverage, created_at)
        VALUES (${Array(36).fill('?').join(', ')})`, [
        runId, metrics.duration_ms, metrics.average_power_watts,
        metrics.peak_power_watts, metrics.energy_wh, metrics.carbon_gco2e,
        metrics.water_liters, metrics.attribution_coverage,
        metrics.measurement_quality, metrics.grid_intensity_quality ?? 'unknown',
        metrics.cpu_average_power_watts ?? null, metrics.cpu_peak_power_watts ?? null, metrics.cpu_energy_wh ?? null,
        metrics.gpu_average_power_watts ?? null, metrics.gpu_peak_power_watts ?? null, metrics.gpu_energy_wh ?? null,
        metrics.ane_average_power_watts ?? null, metrics.ane_peak_power_watts ?? null, metrics.ane_energy_wh ?? null,
        metrics.client_workload_average_power_watts ?? null, metrics.client_workload_peak_power_watts ?? null,
        metrics.client_workload_energy_wh ?? null, metrics.client_workload_carbon_gco2e ?? null, metrics.client_workload_water_liters ?? null,
        metrics.ecoprint_overhead_average_power_watts ?? null, metrics.ecoprint_overhead_peak_power_watts ?? null,
        metrics.ecoprint_overhead_energy_wh ?? null, metrics.ecoprint_overhead_carbon_gco2e ?? null, metrics.ecoprint_overhead_water_liters ?? null,
        metrics.measurement_efficiency_pct ?? null, metrics.measurement_method ?? 'unknown',
        metrics.allocation_method ?? 'unavailable', metrics.provenance_quality ?? 'unknown',
        metrics.process_context_count ?? 0, metrics.process_lineage_coverage ?? null,
        new Date().toISOString(),
    ]);
}

export function compareRunMetrics(current, baseline) {
    const mismatchedMethods = ['measurement_method', 'allocation_method'].filter(key =>
        current[key] != null && baseline[key] != null && current[key] !== baseline[key]);
    const result = Object.fromEntries(FIELDS.map(([key, label]) => {
        const before = baseline[key];
        const now = current[key];
        const delta = before == null || now == null || mismatchedMethods.length ? null : now - before;
        return [key, {
            label,
            baseline: before ?? null,
            current: now ?? null,
            absolute_delta: delta,
            percent_change: before == null || before === 0 || delta == null
                ? null : delta / Math.abs(before) * 100,
        }];
    }));
    Object.defineProperties(result, {
        comparison_status: { value: mismatchedMethods.length ? 'incomparable' : 'comparable', enumerable: true },
        comparison_reason: { value: mismatchedMethods.length ? `measurement/allocation method differs: ${mismatchedMethods.join(', ')}` : null, enumerable: true },
    });
    return result;
}
