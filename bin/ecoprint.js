#!/usr/bin/env node
/**
 * ecoprint — EcoPrint Transparency CLI entry point.
 *
 * Usage:
 *   node bin/ecoprint.js run --name <workload-name> -- <command> [args...]
 *
 * Examples:
 *   node bin/ecoprint.js run --name my-build    -- npm run build
 *   node bin/ecoprint.js run --name sleep-test  -- sleep 3
 *   node bin/ecoprint.js run --name list-files  -- ls -la
 */

import { runUnderTransparency } from '../src/transparency/cli.js';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
    // argv = process.argv.slice(2)
    // Expected shape: run [--name <name>] [--type <type>] -- <cmd> [args...]
    const subcommand = argv[0];

    if (subcommand !== 'run') {
        printUsage();
        process.exit(1);
    }

    let name = 'unnamed-workload';
    let type = 'cli-run';
    let i    = 1;

    while (i < argv.length) {
        if (argv[i] === '--name' && argv[i + 1]) {
            name = argv[i + 1];
            i += 2;
        } else if (argv[i] === '--type' && argv[i + 1]) {
            type = argv[i + 1];
            i += 2;
        } else if (argv[i] === '--') {
            i++;
            break;
        } else {
            i++;
        }
    }

    const command = argv.slice(i);
    if (command.length === 0) {
        console.error('Error: no command supplied after --');
        printUsage();
        process.exit(1);
    }

    return { name, type, command };
}

function printUsage() {
    console.error('Usage: ecoprint run --name <workload-name> -- <command> [args...]');
    console.error('');
    console.error('Examples:');
    console.error('  node bin/ecoprint.js run --name my-build  -- npm run build');
    console.error('  node bin/ecoprint.js run --name sleep-5   -- sleep 5');
}

// ── Report formatter ──────────────────────────────────────────────────────────

const SEP  = '═'.repeat(60);
const LINE = '─'.repeat(60);

function fmt(n, decimals = 4) {
    if (n == null || isNaN(n)) return 'N/A';
    return Number(n).toFixed(decimals);
}

function pct(numerator, denominator) {
    if (!denominator || denominator === 0) return 'N/A';
    return ((numerator / denominator) * 100).toFixed(1) + '%';
}

function fmtDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function printReport(result) {
    const r   = result.reconciliation;
    const m   = r.measured;
    const att = r.attributed;
    const un  = r.unattributed;
    const hasT = result.telemetryCount > 0;

    // Coverage: percentage of measured power that is attributed.
    const coverage = m.power_watts > 0
        ? ((att.power_watts / m.power_watts) * 100).toFixed(1)
        : null;

    // Determine dominant evidence level.
    let evidenceLabel = 'none';
    if (hasT) {
        if (att.power_watts > 0 && un.power_watts === 0) {
            evidenceLabel = 'deterministic — 100% attributed';
        } else if (att.power_watts > 0) {
            evidenceLabel = 'deterministic — partial';
        } else {
            evidenceLabel = 'deterministic — unattributed';
        }
    }

    const statusSymbol = result.exitCode === 0 ? '✓' : '✗';
    const statusLabel  = result.exitCode === 0 ? 'SUCCESS' : `FAILED (exit ${result.exitCode})`;

    console.log('');
    console.log(SEP);
    console.log('  ECOPRINT TRANSPARENCY — EXECUTION REPORT');
    console.log(SEP);
    console.log('');

    // ── Identity ──────────────────────────────────────────────────────────────
    console.log('  WORKLOAD IDENTITY');
    console.log(LINE);
    console.log(`  Workload   : ${result.workload.name}  (${result.workload.type})`);
    console.log(`  Workload ID: ${result.workload.workload_id}`);
    console.log(`  Run ID     : ${result.run.run_id}`);
    console.log(`  Attempt ID : ${result.attempt.attempt_id}  (#${result.attempt.attempt_no})`);
    console.log(`  Context ID : ${result.contextId}`);
    console.log('');

    // ── Execution ─────────────────────────────────────────────────────────────
    console.log('  EXECUTION');
    console.log(LINE);
    console.log(`  Command    : ${result.command.join(' ')}`);
    console.log(`  Status     : ${statusSymbol} ${statusLabel}`);
    if (result.spawnError) {
        console.log(`  Error      : ${result.spawnError}`);
    }
    console.log(`  PID        : ${result.pid ?? 'N/A'}`);
    console.log(`  Resource   : ${result.resourceId}`);
    console.log(`  Started    : ${result.startedAt}`);
    console.log(`  Ended      : ${result.endedAt}`);
    console.log(`  Duration   : ${fmtDuration(result.durationMs)}`);
    console.log('');

    // ── Telemetry & Attribution ───────────────────────────────────────────────
    console.log('  ENERGY / CARBON / WATER');
    console.log(LINE);

    if (result.telemetryError) {
        console.log(`  ⚠  Telemetry unavailable: ${result.telemetryError}`);
        console.log(`     No measurements fabricated.`);
    } else if (!hasT) {
        console.log(`  ⚠  No SigSense observations in execution window.`);
        console.log(`     (Engine may not have been running during this window.)`);
    } else {
        console.log(`  Telemetry observations: ${result.telemetryCount}`);
        console.log('');
        console.log(`  ${'Metric'.padEnd(26)} ${'Measured'.padStart(12)} ${'Attributed'.padStart(12)} ${'Unattributed'.padStart(14)}`);
        console.log(`  ${'-'.repeat(26)} ${'-'.repeat(12)} ${'-'.repeat(12)} ${'-'.repeat(14)}`);

        const pw_m  = fmt(m.power_watts,   4);
        const pw_a  = fmt(att.power_watts,  4);
        const pw_u  = fmt(un.power_watts,   4);
        console.log(`  ${'Power (W avg)'.padEnd(26)} ${pw_m.padStart(12)} ${pw_a.padStart(12)} ${pw_u.padStart(14)}`);

        const co2_m = fmt(m.carbon_gco2e,  6);
        const co2_a = fmt(att.carbon_gco2e, 6);
        const co2_u = fmt(un.carbon_gco2e,  6);
        console.log(`  ${'Carbon (gCO₂e total)'.padEnd(26)} ${co2_m.padStart(12)} ${co2_a.padStart(12)} ${co2_u.padStart(14)}`);

        const h2o_m = fmt(m.water_liters,  8);
        const h2o_a = fmt(att.water_liters, 8);
        const h2o_u = fmt(un.water_liters,  8);
        console.log(`  ${'Water (L total)'.padEnd(26)} ${h2o_m.padStart(12)} ${h2o_a.padStart(12)} ${h2o_u.padStart(14)}`);

        console.log('');
        console.log(`  Reconciliation : measured = attributed + unattributed  ✓`);
        console.log(`  Attribution    : ${coverage !== null ? coverage + '%' : 'N/A'}`);
        console.log(`  Evidence       : ${evidenceLabel}`);
    }

    console.log('');
    console.log(SEP);
    console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));

    process.stdout.write(
        `\n[EcoPrint] Starting transparency measurement for "${args.name}"...\n`
    );

    let result;
    try {
        result = await runUnderTransparency({
            workloadName: args.name,
            workloadType: args.type,
            command:      args.command,
        });
    } catch (err) {
        console.error(`[EcoPrint] Fatal error: ${err.message}`);
        process.exit(2);
    }

    printReport(result);

    process.exit(result.exitCode ?? 0);
}

main();
