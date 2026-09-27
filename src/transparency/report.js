const SEP = '═'.repeat(60);
const LINE = '─'.repeat(60);

function adaptiveNumber(value, { minDecimals = 2, maxDecimals = 12 } = {}) {
    if (value == null || !Number.isFinite(Number(value))) return 'N/A';
    const number = Number(value);
    if (number === 0) return (0).toFixed(minDecimals);
    const decimals = Math.max(minDecimals, Math.min(maxDecimals, Math.ceil(-Math.log10(Math.abs(number))) + 2));
    return number.toFixed(decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

function signed(value, options) {
    if (value == null || !Number.isFinite(Number(value))) return 'N/A';
    const number = Number(value);
    return `${number > 0 ? '+' : number < 0 ? '-' : ''}${adaptiveNumber(Math.abs(number), options)}`;
}

function signedPercent(value) {
    if (value == null || !Number.isFinite(Number(value))) return 'N/A';
    const number = Number(value);
    const precision = Math.abs(number) >= 10 ? 0 : Math.abs(number) < 1 ? 2 : 1;
    return `${number > 0 ? '+' : number < 0 ? '-' : ''}${Math.abs(number).toFixed(precision)}%`;
}

function fmtDuration(ms) {
    if (ms < 1000) return `${adaptiveNumber(ms, { minDecimals: 0, maxDecimals: 2 })} ms`;
    return `${adaptiveNumber(ms / 1000, { minDecimals: 2, maxDecimals: 2 })} s`;
}

function baselineChange(key, metric) {
    const delta = metric.absolute_delta;
    if (delta == null) return 'N/A';
    if (key === 'attribution_coverage' && delta === 0) return '0.0 pp (unchanged)';
    const unit = {
        duration_ms: 'ms', average_power_watts: 'W', peak_power_watts: 'W',
        energy_wh: 'Wh', carbon_gco2e: 'gCO2e', water_liters: 'L', attribution_coverage: 'pp',
    }[key] ?? '';
    if (delta === 0) return `${key === 'duration_ms' ? '0' : '0.0'}${unit ? ` ${unit}` : ''} (0.0%)`;
    const amount = key === 'duration_ms' ? signed(delta, { minDecimals: 0, maxDecimals: 2 })
        : signed(delta);
    const percent = metric.percent_change == null ? 'N/A' : signedPercent(metric.percent_change);
    return `${amount}${unit ? ` ${unit}` : ''} (${percent})`;
}

function insightText(entry) {
    if (typeof entry !== 'string') return null;
    if (entry.includes('longer execution coincided')) {
        return 'Longer execution coincided with higher energy use (plausible contributor; not proof of causality).';
    }
    if (entry.includes('Higher average power coincided')) {
        return 'Higher average power coincided with higher energy use (plausible contributor; not proof of causality).';
    }
    return entry.trim();
}

function observedLines(result) {
    const metrics = result.baselineComparison?.metrics;
    if (!metrics) return [];
    const lines = [];
    for (const [key, label] of [
        ['duration_ms', 'Duration'], ['average_power_watts', 'Average Power'],
        ['peak_power_watts', 'Peak Power'], ['energy_wh', 'Energy'],
        ['carbon_gco2e', 'Carbon'], ['water_liters', 'Water'],
        ['attribution_coverage', 'Attribution'],
    ]) {
        const metric = metrics[key];
        if (!metric || metric.absolute_delta == null) continue;
        if (metric.absolute_delta === 0) {
            lines.push(`${label} was unchanged versus baseline.`);
            continue;
        }
        const delta = baselineChange(key, metric);
        lines.push(`${label}: ${delta}${metric.percent_change == null ? ' (relative change unavailable because baseline is zero)' : ''}.`);
    }
    return lines;
}

function evidenceLines(result) {
    const rows = result.insights?.EVIDENCE ?? [];
    const lines = [];
    const current = rows.find(entry => entry?.kind === 'current_run');
    if (current) {
        const quality = current.measurement_quality ?? 'unknown';
        const count = current.telemetry_count ?? result.telemetryCount;
        lines.push(`${count} ${quality} telemetry observation${count === 1 ? '' : 's'}`);
        const coverage = result.runMetrics?.attribution_coverage;
        if (coverage != null) lines.push(`${adaptiveNumber(coverage, { minDecimals: 1, maxDecimals: 1 })}% deterministic attribution`);
        const grid = current.grid_intensity_quality ?? 'unknown';
        lines.push(`${grid === 'live' ? 'live' : grid} grid intensity`);
    }
    return lines;
}

function reportTable(result) {
    const { measured: m, attributed: a, unattributed: u } = result.reconciliation;
    const lines = [];
    const rows = [
        ['Average Power (W)', m.power_watts, a.power_watts, u.power_watts, 3],
        ['Total Energy (Wh)', m.energy_wh, a.energy_wh, u.energy_wh, 8],
        ['Total Carbon (gCO2e)', m.carbon_gco2e, a.carbon_gco2e, u.carbon_gco2e, 10],
        ['Total Water (L)', m.water_liters, a.water_liters, u.water_liters, 12],
    ];
    const cell = (value, precision) => adaptiveNumber(value, { minDecimals: precision, maxDecimals: 12 });
    const labelWidth = 26;
    const valueWidth = 17;
    lines.push(`  ${'Metric'.padEnd(labelWidth)} ${'Measured'.padStart(valueWidth)} ${'Attributed'.padStart(valueWidth)} ${'Unattributed'.padStart(valueWidth)}`);
    lines.push(`  ${'-'.repeat(labelWidth)} ${'-'.repeat(valueWidth)} ${'-'.repeat(valueWidth)} ${'-'.repeat(valueWidth)}`);
    for (const [label, measured, attributed, unattributed, precision] of rows) {
        lines.push(`  ${label.padEnd(labelWidth)} ${cell(measured, precision).padStart(valueWidth)} ${cell(attributed, precision).padStart(valueWidth)} ${cell(unattributed, precision).padStart(valueWidth)}`);
    }
    lines.push(`  Total Energy: ${adaptiveNumber(m.energy_wh, { minDecimals: 8, maxDecimals: 12 })} Wh (${adaptiveNumber(m.energy_kwh, { minDecimals: 10, maxDecimals: 14 })} kWh)`);
    lines.push(`  Peak Power: ${adaptiveNumber(m.peak_power_watts, { minDecimals: 3, maxDecimals: 12 })} W`);
    return lines;
}

/** Produce a concise terminal report without writing to stdout. */
export function formatReport(result) {
    const { measured: m, attributed: a, unattributed: u } = result.reconciliation;
    const hasTelemetry = result.telemetryCount > 0;
    const status = result.exitCode === 0 ? '✓ SUCCESS' : `✗ FAILED (exit ${result.exitCode})`;
    const lines = ['', SEP, '  ECOPRINT TRANSPARENCY — EXECUTION REPORT', SEP, '',
        '  WORKLOAD IDENTITY', LINE,
        `  Workload   : ${result.workload.name} (${result.workload.type})`,
        `  Workload ID: ${result.workload.workload_id}`,
        `  Run ID     : ${result.run.run_id}`,
        `  Attempt ID : ${result.attempt.attempt_id} (#${result.attempt.attempt_no})`,
        `  Context ID : ${result.contextId}`,
        '', '  EXECUTION', LINE,
        `  Command    : ${result.command.join(' ')}`,
        `  Status     : ${status}`,
        `  PID        : ${result.pid ?? 'N/A'}`,
        `  Resource   : ${result.resourceId}`,
        `  Started    : ${result.startedAt}`,
        `  Ended      : ${result.endedAt}`,
        `  Duration   : ${fmtDuration(result.durationMs)}`];

    if (result.spawnError) lines.push(`  Error      : ${result.spawnError}`);
    if (result.ipcError) lines.push(`  Service IPC: unavailable (${result.ipcError})`);
    lines.push('', '  ENERGY / CARBON / WATER', LINE);

    if (result.telemetryError || !hasTelemetry) {
        lines.push(`  Measurement: ${result.telemetryError ? 'unavailable' : 'unavailable'}`);
        lines.push(`  Grid: unavailable`);
        if (result.telemetryError) lines.push(`  Telemetry error: ${result.telemetryError}`);
        else lines.push('  No SigSense observations in execution window.');
        lines.push('  No measurements fabricated.');
    } else {
        const measurement = result.runMetrics?.measurement_quality ?? 'unknown';
        const grid = result.runMetrics?.grid_intensity_quality ?? 'unknown';
        lines.push(`  Measurement: ${measurement}`);
        lines.push(`  Grid: ${grid}`);
        lines.push(`  Telemetry observations: ${result.telemetryCount}`);
        lines.push(...reportTable(result));
        const coverage = m.power_watts > 0 ? (a.power_watts / m.power_watts) * 100 : null;
        lines.push('', '  Reconciliation: measured = attributed + unattributed',
            `  Attribution version: ${result.reconciliation.attribution_version ?? 'N/A'}`,
            `  Attribution: ${coverage == null ? 'N/A' : `${adaptiveNumber(coverage, { minDecimals: 1, maxDecimals: 1 })}%`}`,
            `  Evidence: ${a.power_watts > 0 && u.power_watts === 0 ? 'deterministic — 100% attributed' : a.power_watts > 0 ? 'deterministic — partial' : 'deterministic — unattributed'}`);
    }

    if (result.baselineComparison) {
        lines.push('', '  BASELINE COMPARISON', LINE,
            `  ${'Metric'.padEnd(24)} Change`);
        const metrics = result.baselineComparison.metrics;
        for (const [key, label] of [
            ['duration_ms', 'Duration'], ['average_power_watts', 'Average Power'],
            ['peak_power_watts', 'Peak Power'], ['energy_wh', 'Energy'],
            ['carbon_gco2e', 'Carbon'], ['water_liters', 'Water'],
            ['attribution_coverage', 'Attribution'],
        ]) {
            lines.push(`  ${label.padEnd(24)} ${baselineChange(key, metrics[key])}`);
        }
    } else {
        lines.push('', '  BASELINE', '  None available — this run establishes the baseline.');
    }

    if (!result.baselineComparison) {
        lines.push('', '  INSIGHT', '  Run this workload again to enable differential analysis.');
    } else if (result.insights) {
        lines.push('', '  INSIGHTS', LINE);
        for (const label of ['OBSERVED', 'LIKELY CONTRIBUTOR', 'EVIDENCE', 'RECOMMENDATION']) {
            lines.push(`  ${label}`);
            const entries = label === 'EVIDENCE' ? evidenceLines(result)
                : label === 'OBSERVED' ? observedLines(result)
                    : (result.insights[label] ?? []).map(insightText).filter(Boolean);
            if (entries.length === 0) lines.push('    - No additional evidence available.');
            for (const entry of entries) lines.push(`    - ${entry}`);
        }
    }
    if (result.aiExplanation) lines.push('', '  AI EXPLANATION', LINE, `  ${result.aiExplanation}`);
    lines.push('', SEP, '');
    return lines.join('\n');
}
