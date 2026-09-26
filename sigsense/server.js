import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import net from 'net';

const app = express();
const PORT = 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

const dbPath = path.join(__dirname, 'engine', 'ecoprint_telemetry.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[API ERROR] Failed to connect to ecoprint_telemetry.db:', err.message);
    } else {
        console.log('[API SUCCESS] Connected to ecoprint_telemetry.db');
    }
});

// Endpoint 1: Dynamic Query Depth for Custom Time Scales (Aggregated vs. Per-Node)
app.get('/api/telemetry', (req, res) => {
    const selectedNode = req.query.node_id || 'ALL';
    const limit = parseInt(req.query.limit) || 60;

    let query = '';
    let params = [];

    if (selectedNode === 'ALL') {
        query = `
            SELECT 
                timestamp,
                SUM(cpu_mw) as cpu_mw,
                SUM(gpu_mw) as gpu_mw,
                SUM(ane_mw) as ane_mw,
                SUM(total_power_watts) as total_power_watts,
                SUM(client_workload_watts) as client_workload_watts,
                SUM(ecoprint_overhead_watts) as ecoprint_overhead_watts,
                SUM(carbon_gCO2e) as carbon_gCO2e,
                SUM(water_liters) as water_liters,
                AVG(latency_ms) as latency_ms,
                AVG(delta_time) as delta_time
            FROM telemetry 
            GROUP BY timestamp 
            ORDER BY id DESC 
            LIMIT ?
        `;
        params = [limit];
    } else {
        query = `
            SELECT * FROM telemetry 
            WHERE node_id = ? 
            ORDER BY id DESC 
            LIMIT ?
        `;
        params = [selectedNode, limit];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.reverse());
    });
});

// Endpoint 1A: One-Second Telemetry Aggregator

app.get('/api/telemetry/aggregate', (req, res) => {
    const selectedNode = req.query.node_id || 'ALL';

    const sessionId = req.query.session_id
        ? parseInt(req.query.session_id)
        : null;

    const limit = parseInt(req.query.limit) || 60;

    let query = `
        SELECT
            MAX(id) AS latest_id,
            session_id,
            node_id,
            region,
            building_id,
            department,
            timestamp AS time_bucket,

            SUM(cpu_mw) AS cpu_mw,
            SUM(gpu_mw) AS gpu_mw,
            SUM(ane_mw) AS ane_mw,

            SUM(total_power_watts) AS total_power_watts,
            SUM(client_workload_watts) AS client_workload_watts,
            SUM(ecoprint_overhead_watts) AS ecoprint_overhead_watts,

            SUM(carbon_gCO2e) AS carbon_gCO2e,
            SUM(water_liters) AS water_liters,

            AVG(latency_ms) AS latency_ms,
            AVG(delta_time) AS delta_time,

            COUNT(*) AS sample_count

        FROM telemetry
        WHERE 1 = 1
    `;

    const params = [];

    if (selectedNode !== 'ALL') {
        query += ` AND node_id = ? `;
        params.push(selectedNode);
    }

    if (sessionId !== null && !Number.isNaN(sessionId)) {
        query += ` AND session_id = ? `;
        params.push(sessionId);
    }

    query += `
        GROUP BY
            session_id,
            node_id,
            region,
            building_id,
            department,
            timestamp

        ORDER BY latest_id DESC
        LIMIT ?
    `;

    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[AGGREGATOR ERROR]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }

        res.json(rows.reverse());
    });
});

// Endpoint 1B: Cross-Node Telemetry Aggregator

app.get('/api/telemetry/aggregate/total', (req, res) => {
    const sessionId = req.query.session_id
        ? parseInt(req.query.session_id)
        : null;

    const limit = parseInt(req.query.limit) || 60;

    let query = `
        SELECT
            MAX(id) AS latest_id,
            session_id,
            timestamp AS time_bucket,
            MAX(region) AS region,

            COUNT(DISTINCT node_id) AS node_count,
            COUNT(*) AS sample_count,

            SUM(cpu_mw) AS cpu_mw,
            SUM(gpu_mw) AS gpu_mw,
            SUM(ane_mw) AS ane_mw,

            SUM(total_power_watts) AS total_power_watts,
            SUM(client_workload_watts) AS client_workload_watts,
            SUM(ecoprint_overhead_watts) AS ecoprint_overhead_watts,

            SUM(carbon_gCO2e) AS carbon_gCO2e,
            SUM(water_liters) AS water_liters,

            AVG(latency_ms) AS latency_ms,
            AVG(delta_time) AS delta_time

        FROM telemetry
        WHERE 1 = 1
    `;

    const params = [];

    if (sessionId !== null && !Number.isNaN(sessionId)) {
        query += ` AND session_id = ? `;
        params.push(sessionId);
    }

    query += `
        GROUP BY
            session_id,
            timestamp

        ORDER BY latest_id DESC
        LIMIT ?
    `;

    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[TOTAL AGGREGATOR ERROR]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }

        res.json(rows.reverse());
    });
});

// Endpoint 2: System Status Check
app.get('/api/status', (req, res) => {
    res.json({ status: "ONLINE", engine: "ECOPRINT_V3_DAEMON" });
});

// Endpoint 3: Strict Whitelisted IPC Engine Control Route
app.post('/api/engine/control', (req, res) => {
    const { action } = req.body;
    const validActions = ['start', 'pause', 'resume', 'terminate'];

    if (!action || !validActions.includes(action.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid engine action requested' });
    }

    const targetAction = action.toLowerCase();

    // Handle TERMINATE
    if (targetAction === 'terminate') {
        const client = net.createConnection('/tmp/ecoprint.sock', () => {
            client.write('TERMINATE\n');
        });
        client.on('end', () => res.json({ status: 'Engine Terminated', success: true }));
        client.on('error', () => res.json({ status: 'Engine already dead', success: true }));
        return;
    }

    // Handle PAUSE or RESUME
    const client = net.createConnection('/tmp/ecoprint.sock', () => {
        const cmd = targetAction === 'pause' ? 'PAUSE' : 'RESUME';
        console.log(`[API IPC] Dispatching ${cmd} command to C++ socket...`);
        client.write(`${cmd}\n`);
    });

    client.on('data', () => { client.end(); });

    client.on('end', () => {
        return res.json({ status: `Engine command ${action} executed`, success: true });
    });

    // FALLBACK: If socket connection fails during RESUME/START, re-spawn the engine process!
    client.on('error', (err) => {
        if (targetAction === 'resume' || targetAction === 'start') {
            console.log('[API IPC] Engine process not found. Spawning new background process...');
            exec('rm -f /tmp/ecoprint.sock && cd engine && sudo ./v3engine > engine_live.log 2>&1 &', (spawnErr) => {
                if (spawnErr) {
                    return res.status(500).json({ error: 'Failed to re-spawn engine' });
                }
                return res.json({ status: 'Engine re-spawned successfully', success: true });
            });
        } else {
            return res.status(500).json({ error: 'Engine daemon not reachable' });
        }
    });
});

// Endpoint 4: Standardized CSV File Exporter Route (Limit Aware)
app.get('/api/telemetry/export', (req, res) => {
    const limitParam = req.query.limit;
    const sessionId = req.query.session_id ? parseInt(req.query.session_id) : null;

    let query = `
        SELECT timestamp, cpu_mw, gpu_mw, ane_mw, total_power_watts, 
               client_workload_watts, ecoprint_overhead_watts, carbon_gCO2e, 
               water_liters, latency_ms, delta_time 
        FROM telemetry 
    `;

    const params = [];
    if (sessionId) {
        query += ` WHERE session_id = ? `;
        params.push(sessionId);
    }

    query += ` ORDER BY id DESC `;

    if (limitParam && limitParam !== 'all' && parseInt(limitParam) > 0) {
        query += ` LIMIT ? `;
        params.push(parseInt(limitParam));
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const sortedRows = rows.reverse();

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="ecoprint_telemetry_export.csv"');

        let csvContent = "timestamp,service,env,cpu_mw,gpu_mw,ane_mw,total_power_watts,client_workload_watts,ecoprint_overhead_watts,carbon_gCO2e,water_liters,latency_ms,delta_time,tags\n";

        const formatDecimal = (num) => {
            if (num === null || num === undefined) return "0.00000000";
            return Number(num).toFixed(8);
        };

        sortedRows.forEach(row => {
            const tags = `"host:macbook-air,region:US-MIDW-MISO,engine:v3"`;
            csvContent += `${row.timestamp},ecoprint-engine,production,${row.cpu_mw},${row.gpu_mw},${row.ane_mw},${row.total_power_watts},${row.client_workload_watts},${row.ecoprint_overhead_watts},${formatDecimal(row.carbon_gCO2e)},${formatDecimal(row.water_liters)},${row.latency_ms},${row.delta_time},${tags}\n`;
        });

        res.status(200).send(csvContent);
    });
});

// Endpoint 5: Enhanced Active Process Watchdog
app.get('/api/engine/status', (req, res) => {
    exec('pgrep v3engine', (err, stdout) => {
        const isRunning = Boolean(stdout && stdout.trim().length > 0);
        if (!isRunning) {
            return res.json({ running: false, collecting: false });
        }

        // Verify socket collection state
        const client = net.createConnection('/tmp/ecoprint.sock', () => {
            client.write('STATUS\n');
        });

        let responseData = '';
        client.on('data', (data) => { responseData += data.toString(); });
        client.on('end', () => {
            const collecting = responseData.includes('COLLECTING');
            return res.json({ running: true, collecting });
        });
        client.on('error', () => {
            return res.json({ running: true, collecting: true });
        });
    });
});

// Endpoint 6: Dynamic Active Node Discovery

app.get('/api/telemetry/nodes', (req, res) => {
    db.all(
        `
        SELECT
            node_id,
            MAX(region) AS region,
            MAX(building_id) AS building_id,
            MAX(department) AS department,
            MAX(timestamp) AS last_seen,
            MAX(id) AS latest_id
        FROM telemetry
        WHERE node_id IS NOT NULL
        GROUP BY node_id
        ORDER BY latest_id DESC
        `,
        [],
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            res.json(rows);
        }
    );
});

// Endpoint 7: Multi-Node Telemetry Ingestion API
app.post('/api/telemetry/ingest', (req, res) => {
    const { node_id, region, building_id, department, metrics } = req.body;

    if (!node_id || !Array.isArray(metrics)) {
        return res.status(400).json({
            error: 'Invalid telemetry payload structure'
        });
    }

    const timestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

    const stmt = db.prepare(`
        INSERT INTO telemetry (
            node_id, region, building_id, department, timestamp,
            cpu_mw, gpu_mw, ane_mw, total_power_watts,
            client_workload_watts, ecoprint_overhead_watts,
            carbon_gCO2e, water_liters, latency_ms, delta_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let ingestedRows = 0;
    let invalidTimestampRows = 0;

    db.serialize(() => {
        metrics.forEach(m => {
            const timestampValid =
                typeof m.timestamp === 'string' &&
                timestampRegex.test(m.timestamp);

            if (!timestampValid) {
                invalidTimestampRows++;

                console.warn(
                    `[INGEST WARNING] Invalid timestamp from node ${node_id}:`,
                    m.timestamp
                );
            }

            stmt.run([
                node_id,
                region || 'US-MIDW-MISO',
                building_id || 'HQ-Main',
                department || 'Engineering',
                timestampValid ? m.timestamp : null,
                m.cpu_mw,
                m.gpu_mw,
                m.ane_mw,
                m.total_power_watts,
                m.client_workload_watts,
                m.ecoprint_overhead_watts,
                m.carbon_gCO2e,
                m.water_liters,
                m.latency_ms,
                m.delta_time
            ], (err) => {
                if (err) {
                    console.error(
                        `[INGEST ERROR] Failed to store telemetry from ${node_id}:`,
                        err.message
                    );
                } else {
                    ingestedRows++;
                }
            });
        });

        stmt.finalize(() => {
            res.json({
                status: 'SUCCESS',
                ingested_rows: ingestedRows,
                invalid_timestamp_rows: invalidTimestampRows
            });
        });
    });
});

// Start API server
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`     ECOPRINT AI — ENTERPRISE DATA API SERVER      `);
    console.log(`==================================================`);
    console.log(`Live Route Engaged: http://localhost:${PORT}/api/telemetry`);
});