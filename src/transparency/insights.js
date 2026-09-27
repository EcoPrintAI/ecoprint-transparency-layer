const DELTA_FIELDS = [
    'duration_ms', 'average_power_watts', 'peak_power_watts', 'energy_wh',
    'cpu_average_power_watts', 'gpu_average_power_watts', 'ane_average_power_watts',
    'cpu_energy_wh', 'gpu_energy_wh', 'ane_energy_wh',
    'client_workload_energy_wh', 'ecoprint_overhead_energy_wh', 'measurement_efficiency_pct',
    'carbon_gco2e', 'water_liters', 'attribution_coverage',
];

function readableNumber(value) {
    if (value == null || !Number.isFinite(Number(value))) return 'unavailable';
    return Number(value).toFixed(10).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

export function deriveInsights({ baselineComparison = null, currentMetrics, telemetryCount = 0, resourceId = null,
    processContexts = [], workload = null, run = null, attempt = null }) {
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
            grid_intensity_quality: currentMetrics.grid_intensity_quality ?? 'unknown',
            attribution_coverage: currentMetrics.attribution_coverage,
            component_telemetry_counts: currentMetrics.component_telemetry_counts ?? {},
            component_current: Object.fromEntries(['cpu', 'gpu', 'ane'].map(component => [component, {
                average_power_watts: currentMetrics[`${component}_average_power_watts`] ?? null,
                energy_wh: currentMetrics[`${component}_energy_wh`] ?? null,
            }])) });
        evidence.push({
            kind: 'provenance',
            workload_id: workload?.workload_id ?? null,
            run_id: run?.run_id ?? null,
            attempt_id: attempt?.attempt_id ?? null,
            process_context_count: currentMetrics.process_context_count ?? processContexts.length,
            process_lineage_coverage: currentMetrics.process_lineage_coverage ?? null,
            classifications: processContexts.reduce((counts, context) => {
                counts[context.classification] = (counts[context.classification] ?? 0) + 1;
                return counts;
            }, {}),
        });
    }

    if (!baselineComparison) {
        observed.push('No previous completed run is available as a baseline.');
        recommendations.push('Run the same named workload again to establish a comparable baseline.');
    } else {
        const deltas = baselineComparison.metrics;
        for (const key of DELTA_FIELDS) {
            const metric = deltas[key];
            if (!metric || metric.absolute_delta == null) continue;
            const metricLabel = metric.label?.replace(/\s+\([^)]*\)$/, '') ?? key;
            const direction = metric.absolute_delta > 0 ? 'increased' : metric.absolute_delta < 0 ? 'decreased' : 'was unchanged';
            observed.push(`${metricLabel} ${direction} by ${readableNumber(Math.abs(metric.absolute_delta))}${metric.percent_change == null ? '' : ` (${readableNumber(metric.percent_change)}%)`} versus the baseline.`);
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
        if (deltas.comparison_status === 'incomparable') {
            observed.push(`Baseline metrics are incomparable because ${deltas.comparison_reason}.`);
            recommendations.push('Repeat the run with a matching measurement source and allocation method before interpreting the energy split.');
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
        if (energy > 0) {
            const componentChanges = ['cpu', 'gpu', 'ane'].map(component => ({
                component,
                delta: deltas[`${component}_energy_wh`]?.absolute_delta,
            })).filter(item => item.delta != null && item.delta > 0)
                .sort((a, b) => b.delta - a.delta);
            if (componentChanges.length > 0) {
                const largest = componentChanges[0];
                likely.push(`The observed increase was concentrated in ${largest.component.toUpperCase()} energy, the largest positive component change (coincident evidence; not proof of causality).`);
                recommendations.push(`Investigate ${largest.component.toUpperCase()} activity and compare its run profile with the baseline.`);
            }
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
