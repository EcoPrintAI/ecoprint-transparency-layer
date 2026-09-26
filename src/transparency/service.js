import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const actions = new Set(['install', 'uninstall', 'start', 'stop', 'status']);

export function manageService(action, { platform = process.platform, runner = spawnSync } = {}) {
    if (!actions.has(action)) throw new Error(`Unsupported service action: ${action}`);
    const serviceDir = path.join(repoRoot, 'sigsense', 'service');
    let command;
    let args;
    if (platform === 'win32') {
        command = 'powershell.exe';
        args = ['-NoProfile', '-File', path.join(serviceDir, 'ecoprint-service.ps1'), action];
    } else {
        command = 'bash';
        args = [path.join(serviceDir, 'ecoprint-service.sh'), action, repoRoot];
    }
    const result = runner(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Service ${action} failed${result.status === null ? '' : ` (exit ${result.status})`}`);
    return { action, platform };
}
