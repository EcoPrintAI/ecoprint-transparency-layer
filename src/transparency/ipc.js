import net from 'node:net';

export function defaultIpcEndpoint(platform = process.platform) {
    if (platform === 'win32') return '\\\\.\\pipe\\ecoprint-transparency';
    if (process.env.ECOPRINT_IPC_PATH) return process.env.ECOPRINT_IPC_PATH;
    return platform === 'darwin' ? '/var/run/ecoprint.sock' : '/run/ecoprint/ecoprint.sock';
}

export function sendIpcCommand(command, {
    endpoint = defaultIpcEndpoint(),
    timeoutMs = command.startsWith('END ') ? 5000 : 1500,
    platform = process.platform,
    connectionFactory = net.createConnection,
} = {}) {
    if (!/^(PING|STATUS|BEGIN [0-9a-fA-F-]{1,64}|END [0-9a-fA-F-]{1,64})$/.test(command)) {
        return Promise.reject(new Error('Unsupported IPC command'));
    }
    return new Promise((resolve, reject) => {
        const socket = connectionFactory(platform === 'win32' ? endpoint : { path: endpoint });
        let response = '';
        const timer = setTimeout(() => socket.destroy(new Error('IPC request timed out')), timeoutMs);
        socket.once('connect', () => socket.write(`${command}\n`));
        socket.on('data', chunk => {
            response += chunk.toString('utf8');
            const newline = response.indexOf('\n');
            if (newline !== -1) {
                clearTimeout(timer);
                socket.end();
                const line = response.slice(0, newline).trim();
                if (line.startsWith('OK ')) resolve(line);
                else reject(new Error(line || 'Invalid IPC response'));
            }
        });
        socket.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        socket.once('close', () => clearTimeout(timer));
    });
}

export function isIpcAvailableError(error) {
    return ['ENOENT', 'ECONNREFUSED', 'EACCES', 'ETIMEDOUT'].includes(error?.code) ||
        error?.message === 'IPC request timed out';
}
