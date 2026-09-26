import { dbGet, dbRun } from './db.js';

const FIELDS = [
    ['duration_ms', 'Duration (ms)'],
    ['average_power_watts', 'Average Power (W)'],
    ['peak_power_watts', 'Peak Power (W)'],
    ['energy_wh', 'Energy (Wh)'],
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
         grid_intensity_quality, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        runId, metrics.duration_ms, metrics.average_power_watts,
        metrics.peak_power_watts, metrics.energy_wh, metrics.carbon_gco2e,
        metrics.water_liters, metrics.attribution_coverage,
        metrics.measurement_quality, metrics.grid_intensity_quality ?? 'unknown', new Date().toISOString(),
    ]);
}

export function compareRunMetrics(current, baseline) {
    return Object.fromEntries(FIELDS.map(([key, label]) => {
        const before = baseline[key];
        const now = current[key];
        const delta = before == null || now == null ? null : now - before;
        return [key, {
            label,
            baseline: before ?? null,
            current: now ?? null,
            absolute_delta: delta,
            percent_change: before == null || before === 0 || delta == null
                ? null : delta / Math.abs(before) * 100,
        }];
    }));
}
