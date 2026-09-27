/**
 * telemetry.js — SigSense telemetry read adapter.
 *
 * Reads existing SigSense telemetry data through a separate read-only path.
 * Never opens a write connection to the SigSense database.
 * Never modifies, inserts into, or deletes from any SigSense table.
 *
 * The only job of this module is to normalize the fields already required
 * by the attribution layer:
 *   timestamp          — UTC ISO-8601 string
 *   resource_id        — node_id from SigSense
 *   total_power_watts  — watts
 *   carbon_gCO2e       — grams CO2-equivalent
 *   water_liters       — liters
 *
 * All other SigSense columns are ignored.
 */

import sqlite3 from 'sqlite3';
import path    from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default path to the SigSense telemetry database.
 * Resolved relative to this file's location so it works from any cwd.
 */
const repoTelemetryDb = path.resolve(__dirname, '..', '..', 'sigsense', 'engine', 'ecoprint_telemetry.db');
const installedTelemetryDb = process.platform === 'darwin'
    ? '/Library/Application Support/EcoPrint/Data/ecoprint_telemetry.db'
    : process.platform === 'win32'
        ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'EcoPrint', 'Data', 'ecoprint_telemetry.db')
        : '/var/lib/ecoprint/ecoprint_telemetry.db';
export const DEFAULT_SIGSENSE_DB = process.env.ECOPRINT_TELEMETRY_DB ??
    (existsSync(installedTelemetryDb) ? installedTelemetryDb : repoTelemetryDb);

/**
 * Open the SigSense database in read-only mode.
 *
 * @param {string} [dbPath] Override path; defaults to DEFAULT_SIGSENSE_DB.
 * @returns {Promise<sqlite3.Database>}
 * @throws if the file does not exist or cannot be opened.
 */
export function openSigSenseDb(dbPath = DEFAULT_SIGSENSE_DB) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) reject(err);
            else resolve(db);
        });
    });
}

/**
 * Close a SigSense database connection.
 *
 * @param {sqlite3.Database} db
 * @returns {Promise<void>}
 */
export function closeSigSenseDb(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/** Normalize the existing SigSense component fields without changing its schema. */
export function allocationBasisForSource(source, platform = process.platform) {
    if (source === 'hardware' && platform === 'darwin') return 'macos-parser-time-allocation';
    if (source === 'hardware') return 'unspecified-hardware-allocation';
    if (source === 'hardware-rapl' || source === 'hardware-battery') return 'fixed-92-8-allocation';
    if (source === 'estimated-pdh-proxy') return 'fixed-92-8-pdh-estimate';
    if (source === 'estimated-simulator') return 'simulator-estimate';
    if (source === 'fallback') return 'fallback-allocation';
    return 'unavailable';
}

/** Normalize existing SigSense readings without changing its raw schema. */
export function normalizeTelemetryRow(row, platform = process.platform) {
    const hardwareComponentsAvailable = row.measurement_source === 'hardware';
    const toWatts = field => {
        const value = row[field];
        return hardwareComponentsAvailable && value != null && Number.isFinite(Number(value))
            ? Number(value) / 1000 : null;
    };
    return {
        timestamp: row.timestamp,
        resource_id: row.resource_id ?? null,
        total_power_watts: row.total_power_watts ?? 0,
        cpu_power_watts: toWatts('cpu_mw'),
        gpu_power_watts: toWatts('gpu_mw'),
        ane_power_watts: toWatts('ane_mw'),
        client_workload_power_watts: finiteWatts(row.client_workload_watts),
        ecoprint_overhead_power_watts: finiteWatts(row.ecoprint_overhead_watts),
        carbon_gCO2e: row.carbon_gCO2e ?? 0,
        water_liters: row.water_liters ?? 0,
        interval_seconds: row.delta_time ?? 0,
        measurement_source: row.measurement_source ?? 'unknown',
        allocation_basis: allocationBasisForSource(row.measurement_source ?? 'unknown', platform),
        split_provenance: row.client_workload_watts == null || row.ecoprint_overhead_watts == null
            ? 'unavailable' : 'allocated',
        grid_intensity_source: row.grid_intensity_source ?? 'unknown',
    };
}

function finiteWatts(value) {
    return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Read telemetry rows within a time window and return normalized objects.
 *
 * Only rows whose timestamp falls within [windowStart, windowEnd] (inclusive)
 * are returned.  Rows with a null or empty timestamp are skipped.
 *
 * @param {sqlite3.Database} db  Read-only SigSense database connection.
 * @param {object} opts
 * @param {string}  opts.windowStart  UTC ISO-8601 (inclusive).
 * @param {string}  opts.windowEnd    UTC ISO-8601 (inclusive).
 * @param {string}  [opts.resourceId] Filter by node_id when supplied.
 * @returns {Promise<Array<{
 *   timestamp:         string,
 *   resource_id:       string,
 *   total_power_watts: number,
 *   carbon_gCO2e:      number,
 *   water_liters:      number,
 * }>>}
 */
export function readTelemetryWindow(db, { windowStart, windowEnd, resourceId }) {
    return new Promise((resolve, reject) => {
        const conditions = ['t.timestamp IS NOT NULL', "t.timestamp != ''"];
        const params = [];
        if (resourceId) {
            conditions.push('t.node_id = ?');
            params.push(resourceId);
        }
        const resourceSubquery = resourceId ? ' AND node_id = ?' : '';
        conditions.push(`((t.timestamp >= ? AND t.timestamp <= ?)
            OR t.id = (SELECT id FROM telemetry WHERE timestamp < ?${resourceSubquery} ORDER BY timestamp DESC, id DESC LIMIT 1)
            OR t.id = (SELECT id FROM telemetry WHERE timestamp > ?${resourceSubquery} ORDER BY timestamp ASC, id ASC LIMIT 1))`);
        params.push(windowStart, windowEnd, windowStart);
        if (resourceId) params.push(resourceId);
        params.push(windowEnd);
        if (resourceId) params.push(resourceId);

        db.all('PRAGMA table_info(measurement_quality)', (schemaErr, columns) => {
            if (schemaErr) { reject(schemaErr); return; }
            const qualityTable = columns.length > 0;
            const hasGridQuality = columns.some(column => column.name === 'grid_intensity_source');
            const qualityJoin = qualityTable
                ? 'LEFT JOIN measurement_quality q ON q.telemetry_id = t.id'
                : '';
            const qualityColumn = qualityTable ? 'q.measurement_source' : "'unknown'";
            const gridQualityColumn = hasGridQuality ? 'q.grid_intensity_source' : "'unknown'";
            const sql = `
                SELECT t.timestamp,
                       t.node_id AS resource_id,
                       t.cpu_mw,
                       t.gpu_mw,
                       t.ane_mw,
                       t.total_power_watts,
                       t.client_workload_watts,
                       t.ecoprint_overhead_watts,
                       t.carbon_gCO2e,
                       t.water_liters,
                       t.delta_time,
                       ${qualityColumn} AS measurement_source,
                       ${gridQualityColumn} AS grid_intensity_source
                FROM telemetry t
                ${qualityJoin}
                WHERE ${conditions.join(' AND ')}
                ORDER BY t.timestamp ASC
            `;
            db.all(sql, params, (err, rows) => {
                if (err) { reject(err); return; }
                resolve(rows.map(row => normalizeTelemetryRow(row)));
            });
        });
    });
}
