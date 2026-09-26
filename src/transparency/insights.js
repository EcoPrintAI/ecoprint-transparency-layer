const DELTA_FIELDS = [
    'duration_ms', 'average_power_watts', 'peak_power_watts', 'energy_wh',
    'carbon_gco2e', 'water_liters', 'attribution_coverage',
];

export function deriveInsights({ baselineComparison = null, currentMetrics, telemetryCount = 0, resourceId = null }) {
    const observed = [];
    const likely = [];
    const evidence = [];
    const recommendations = [];

    if (telemetryCount === 0) {
        observed.push('No telemetry observations were available for this run.');
        recommendations.push('Check that the local SigSense service is installed, active, and permitted to read this platform’s telemetry source.');
    } else {
        observed.push(`${telemetryCount} telemetry observations were recorded for resource ${resourceId ?? 'unknown'}.`);
        observed.push(`Measurement quality is ${currentMetrics.measurement_quality}.`);
        observed.push(`Grid intensity source is ${currentMetrics.grid_intensity_quality ?? 'unknown'}.`);
        evidence.push({ kind: 'current_run', telemetry_count: telemetryCount, resource_id: resourceId,
            measurement_quality: currentMetrics.measurement_quality,
            grid_intensity_quality: currentMetrics.grid_intensity_quality ?? 'unknown' });
    }

    if (!baselineComparison) {
        observed.push('No previous completed run is available as a baseline.');
        recommendations.push('Run the same named workload again to establish a comparable baseline.');
    } else {
        const deltas = baselineComparison.metrics;
        for (const key of DELTA_FIELDS) {
            const metric = deltas[key];
            if (!metric || metric.absolute_delta == null) continue;
            const direction = metric.absolute_delta > 0 ? 'increased' : metric.absolute_delta < 0 ? 'decreased' : 'was unchanged';
            observed.push(`${metric.label} ${direction} by ${Math.abs(metric.absolute_delta).toFixed(4)}${metric.percent_change == null ? '' : ` (${metric.percent_change.toFixed(1)}%)`} versus the baseline.`);
            evidence.push({ kind: 'baseline_delta', metric: key, baseline: metric.baseline,
                current: metric.current, absolute_delta: metric.absolute_delta,
                percent_change: metric.percent_change });
        }

        if (currentMetrics.measurement_quality !== baselineComparison.measurement_quality) {
            observed.push(`Measurement quality differs from the baseline (${baselineComparison.measurement_quality} → ${currentMetrics.measurement_quality}).`);
            recommendations.push('Repeat the comparison with the same measurement source and quality before interpreting small changes.');
        }
        if (currentMetrics.grid_intensity_quality !== baselineComparison.grid_intensity_quality) {
            observed.push(`Grid intensity source differs from the baseline (${baselineComparison.grid_intensity_quality ?? 'unknown'} → ${currentMetrics.grid_intensity_quality ?? 'unknown'}).`);
            recommendations.push('Check whether live grid-intensity data or its fallback was used for both runs before comparing carbon totals.');
        }

        const duration = deltas.duration_ms?.absolute_delta ?? 0;
        const averagePower = deltas.average_power_watts?.absolute_delta ?? 0;
        const energy = deltas.energy_wh?.absolute_delta ?? 0;
        if (energy > 0 && duration > 0) {
            likely.push('The longer execution coincided with higher energy use and is a plausible contributor; this comparison does not establish causality.');
            recommendations.push('Inspect changed build steps or child-process work that may explain the longer execution.');
        }
        if (energy > 0 && averagePower > 0) {
            likely.push('Higher average power coincided with higher energy use and is a plausible contributor; this comparison does not isolate cause.');
            recommendations.push('Inspect workload activity during the run and compare it with the baseline’s power profile.');
        }
        if ((deltas.carbon_gco2e?.absolute_delta ?? 0) > 0 && energy <= 0) {
            recommendations.push('Carbon rose without higher measured energy; inspect the grid-intensity source and its update/fallback status.');
        }
    }

    if (telemetryCount > 0 && currentMetrics.attribution_coverage < 100) {
        recommendations.push('Inspect unattributed telemetry and verify run context timestamps and resource identity.');
    }
    if (['fallback', 'estimated', 'unknown', 'mixed', 'unavailable'].includes(currentMetrics.measurement_quality)) {
        recommendations.push('Treat power and environmental totals as lower-confidence until the measurement source is confirmed.');
    }

    return {
        OBSERVED: observed,
        'LIKELY CONTRIBUTOR': likely.length ? likely : ['No contributor can be identified from the available comparison facts.'],
        EVIDENCE: evidence,
        RECOMMENDATION: [...new Set(recommendations)],
    };
}
