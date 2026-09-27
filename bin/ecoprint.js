#!/usr/bin/env node
/**
 * ecoprint — EcoPrint Transparency CLI entry point.
 *
 * Usage:
 *   node bin/ecoprint.js run --name <workload-name> -- <command> [args...]
 */

import { runUnderTransparency } from '../src/transparency/cli.js';
import { formatReport } from '../src/transparency/report.js';
import { createAIProvider } from '../src/transparency/ai.js';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === 'service') {
        try {
            const { manageService } = await import('../src/transparency/service.js');
            manageService(argv[1]);
        } catch (err) {
            console.error(`[EcoPrint] ${err.message}`);
            process.exit(2);
        }
        return;
    }
    const args = parseArgs(argv);
    process.stdout.write(`\n[EcoPrint] Starting transparency measurement for "${args.name}"...\n`);
    let result;
    try {
        result = await runUnderTransparency({
            workloadName: args.name,
            workloadType: args.type,
            command: args.command,
            identityEnv: process.env,
            aiProvider: process.env.ECOPRINT_AI === '1' ? createAIProvider() : null,
        });
    } catch (err) {
        console.error(`[EcoPrint] Fatal error: ${err.message}`);
        process.exit(2);
    }
    console.log(formatReport(result));
    process.exit(result.exitCode ?? 0);
}

main();
