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
    if (delta == null) return 'unavailable';
    const unit = {
        duration_ms: 'ms', average_power_watts: 'W', peak_power_watts: 'W',
        cpu_average_power_watts: 'W', gpu_average_power_watts: 'W', ane_average_power_watts: 'W',
        client_workload_average_power_watts: 'W', ecoprint_overhead_average_power_watts: 'W',
        energy_wh: 'Wh', carbon_gco2e: 'gCO2e', water_liters: 'L', attribution_coverage: 'pp',
        cpu_energy_wh: 'Wh', gpu_energy_wh: 'Wh', ane_energy_wh: 'Wh',
        client_workload_energy_wh: 'Wh', ecoprint_overhead_energy_wh: 'Wh', measurement_efficiency_pct: 'pp',
    }[key] ?? '';
    if (delta === 0) return `${key === 'duration_ms' ? '0' : '0.0'}${unit ? ` ${unit}` : ''} (unchanged)`;
    const amount = key === 'duration_ms' ? signed(delta, { minDecimals: 0, maxDecimals: 2 })
        : signed(delta);
    const percent = metric.percent_change == null ? 'percentage unavailable' : signedPercent(metric.percent_change);
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
        ['peak_power_watts', 'Peak Power'],
        ['cpu_average_power_watts', 'CPU average power'],
        ['gpu_average_power_watts', 'GPU average power'],
        ['ane_average_power_watts', 'ANE average power'],
        ['cpu_energy_wh', 'CPU energy'], ['gpu_energy_wh', 'GPU energy'],
        ['ane_energy_wh', 'ANE energy'], ['energy_wh', 'Energy'],
        ['client_workload_energy_wh', 'Client workload energy'],
        ['ecoprint_overhead_energy_wh', 'EcoPrint overhead energy'],
        ['measurement_efficiency_pct', 'Client energy share'],
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
        const componentCounts = result.runMetrics?.component_telemetry_counts;
        if (componentCounts) lines.push(`Component observations: CPU ${componentCounts.cpu ?? 0}, GPU ${componentCounts.gpu ?? 0}, ANE ${componentCounts.ane ?? 0}`);
        const grid = current.grid_intensity_quality ?? 'unknown';
        lines.push(`${grid === 'live' ? 'live' : grid} grid intensity`);
    }
    const componentFacts = {
        cpu_average_power_watts: ['CPU average power', 'W'],
        gpu_average_power_watts: ['GPU average power', 'W'],
        ane_average_power_watts: ['ANE average power', 'W'],
        cpu_energy_wh: ['CPU energy', 'Wh'],
        gpu_energy_wh: ['GPU energy', 'Wh'],
        ane_energy_wh: ['ANE energy', 'Wh'],
    };
    for (const item of rows.filter(entry => entry?.kind === 'baseline_delta')) {
        const fact = componentFacts[item.metric];
        if (!fact) continue;
        const show = value => value == null ? 'unavailable' : `${adaptiveNumber(value, { minDecimals: 3, maxDecimals: 12 })} ${fact[1]}`;
        lines.push(`${fact[0]} baseline ${show(item.baseline)} → current ${show(item.current)}`);
    }
    return lines;
}

function reportTables(result) {
    const { measured: m, attributed: a, unattributed: u } = result.reconciliation;
    const lines = [];
    const cell = value => value == null ? 'unavailable' : adaptiveNumber(value, { minDecimals: 3, maxDecimals: 12 });
    const nameWidth = 12;
    const powerWidth = 18;
    lines.push('  POWER', `  ${'Component'.padEnd(nameWidth)} ${'Average (W)'.padStart(powerWidth)} ${'Peak (W)'.padStart(powerWidth)}`);
    lines.push(`  ${'-'.repeat(nameWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)}`);
    for (const [label, prefix] of [['CPU', 'cpu'], ['GPU', 'gpu'], ['ANE', 'ane']]) {
        lines.push(`  ${label.padEnd(nameWidth)} ${cell(m[`${prefix}_power_watts`]).padStart(powerWidth)} ${cell(m[`${prefix}_peak_power_watts`]).padStart(powerWidth)}`);
    }
    lines.push(`  ${'Total'.padEnd(nameWidth)} ${cell(m.power_watts).padStart(powerWidth)} ${cell(m.peak_power_watts).padStart(powerWidth)}`);

    lines.push('', '  ENERGY', `  ${'Component'.padEnd(nameWidth)} ${'Measured (Wh)'.padStart(powerWidth)} ${'Attributed (Wh)'.padStart(powerWidth)} ${'Unattributed (Wh)'.padStart(powerWidth)}`);
    lines.push(`  ${'-'.repeat(nameWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)}`);
    for (const [label, prefix] of [['CPU', 'cpu'], ['GPU', 'gpu'], ['ANE', 'ane']]) {
        lines.push(`  ${label.padEnd(nameWidth)} ${cell(m[`${prefix}_energy_wh`]).padStart(powerWidth)} ${cell(a[`${prefix}_energy_wh`]).padStart(powerWidth)} ${cell(u[`${prefix}_energy_wh`]).padStart(powerWidth)}`);
    }
    lines.push(`  ${'Total'.padEnd(nameWidth)} ${cell(m.energy_wh).padStart(powerWidth)} ${cell(a.energy_wh).padStart(powerWidth)} ${cell(u.energy_wh).padStart(powerWidth)}`);

    lines.push('', '  SELF-MEASUREMENT ACCOUNTING', `  ${'Series'.padEnd(nameWidth)} ${'Average (W)'.padStart(powerWidth)} ${'Energy (Wh)'.padStart(powerWidth)} ${'Carbon (gCO2e)'.padStart(powerWidth)} ${'Water (L)'.padStart(powerWidth)}`);
    lines.push(`  ${'-'.repeat(nameWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)}`);
    for (const [label, prefix] of [['Client', 'client_workload'], ['EcoPrint', 'ecoprint_overhead']]) {
        lines.push(`  ${label.padEnd(nameWidth)} ${cell(m[`${prefix}_power_watts`]).padStart(powerWidth)} ${cell(m[`${prefix}_energy_wh`]).padStart(powerWidth)} ${cell(m[`${prefix}_carbon_gco2e`]).padStart(powerWidth)} ${cell(m[`${prefix}_water_liters`]).padStart(powerWidth)}`);
    }
    lines.push(`  Total energy reconciles to the observed total above. Client/EcoPrint environmental values are allocated from total by power share.`);

    lines.push('', '  ENVIRONMENTAL TOTALS', `  ${'Metric'.padEnd(nameWidth)} ${'Measured'.padStart(powerWidth)} ${'Attributed'.padStart(powerWidth)} ${'Unattributed'.padStart(powerWidth)}`);
    lines.push(`  ${'-'.repeat(nameWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)} ${'-'.repeat(powerWidth)}`);
    for (const [label, key, precision] of [['Carbon (gCO2e)', 'carbon_gco2e', 10], ['Water (L)', 'water_liters', 12]]) {
        const environmentalCell = value => value == null ? 'unavailable' : adaptiveNumber(value, { minDecimals: precision, maxDecimals: 12 });
        lines.push(`  ${label.padEnd(nameWidth)} ${environmentalCell(m[key]).padStart(powerWidth)} ${environmentalCell(a[key]).padStart(powerWidth)} ${environmentalCell(u[key]).padStart(powerWidth)}`);
    }
    lines.push(`  Total Energy: ${adaptiveNumber(m.energy_wh, { minDecimals: 8, maxDecimals: 12 })} Wh (${adaptiveNumber(m.energy_kwh, { minDecimals: 10, maxDecimals: 14 })} kWh)`);
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
        lines.push(...reportTables(result));
        lines.push(`  Total source: ${result.runMetrics?.measurement_method ?? 'unknown'} (${result.runMetrics?.provenance_quality ?? 'unknown'})`);
        lines.push(`  Allocation basis: ${result.runMetrics?.allocation_method ?? 'unavailable'}`);
        const efficiency = result.runMetrics?.measurement_efficiency_pct;
        lines.push(`  Measurement Efficiency: ${efficiency == null ? 'unavailable' : `${Number(efficiency).toFixed(2)}%`} (client energy / (client + EcoPrint allocated energy))`);
        lines.push(`  Process contexts: ${result.runMetrics?.process_context_count ?? 0}; lineage coverage: ${result.runMetrics?.process_lineage_coverage == null ? 'unavailable' : `${adaptiveNumber(result.runMetrics.process_lineage_coverage, { minDecimals: 1, maxDecimals: 1 })}%`}`);
        const coverage = m.power_watts > 0 ? (a.power_watts / m.power_watts) * 100 : null;
        lines.push('', '  Reconciliation: measured = attributed + unattributed',
            `  Attribution version: ${result.reconciliation.attribution_version ?? 'N/A'}`,
            `  Evidence: ${a.power_watts > 0 && u.power_watts === 0 ? 'deterministic — 100% attributed' : a.power_watts > 0 ? 'deterministic — partial' : 'deterministic — unattributed'}`);
    }

    if (result.baselineComparison) {
        lines.push('', '  BASELINE COMPARISON', LINE,
            `  ${'Metric'.padEnd(24)} Change`,
            `  Comparison: ${result.baselineComparison.metrics.comparison_status ?? 'comparable'}${result.baselineComparison.metrics.comparison_reason ? ` — ${result.baselineComparison.metrics.comparison_reason}` : ''}`);
        const metrics = result.baselineComparison.metrics;
        for (const [key, label] of [
            ['duration_ms', 'Duration'], ['average_power_watts', 'Average Power'],
            ['peak_power_watts', 'Peak Power'], ['energy_wh', 'Energy'],
            ['cpu_average_power_watts', 'CPU Average Power'],
            ['gpu_average_power_watts', 'GPU Average Power'],
            ['ane_average_power_watts', 'ANE Average Power'],
            ['cpu_energy_wh', 'CPU Energy'], ['gpu_energy_wh', 'GPU Energy'],
            ['ane_energy_wh', 'ANE Energy'],
            ['client_workload_energy_wh', 'Client Workload Energy'],
            ['ecoprint_overhead_energy_wh', 'EcoPrint Overhead Energy'],
            ['measurement_efficiency_pct', 'Client Energy Share'],
            ['carbon_gco2e', 'Carbon'], ['water_liters', 'Water'],
        ]) {
            if (!metrics[key]) continue;
            lines.push(`  ${label.padEnd(24)} ${baselineChange(key, metrics[key])}`);
        }
        const coverage = result.runMetrics?.attribution_coverage;
        lines.push(`  Attribution Coverage: ${coverage == null ? 'unavailable' : `${adaptiveNumber(coverage, { minDecimals: 1, maxDecimals: 1 })}%`}`,
            `  Change: ${baselineChange('attribution_coverage', metrics.attribution_coverage)}`);
    } else {
        const coverage = result.runMetrics?.attribution_coverage;
        lines.push('', '  BASELINE', `  Attribution Coverage: ${coverage == null ? 'unavailable' : `${adaptiveNumber(coverage, { minDecimals: 1, maxDecimals: 1 })}%`}`,
            `  Client Energy Share: ${result.runMetrics?.measurement_efficiency_pct == null ? 'unavailable' : `${Number(result.runMetrics.measurement_efficiency_pct).toFixed(2)}%`}`,
            '  Baseline: not available — this run establishes the comparison point.');
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
