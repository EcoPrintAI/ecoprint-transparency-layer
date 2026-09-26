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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default path to the SigSense telemetry database.
 * Resolved relative to this file's location so it works from any cwd.
 */
export const DEFAULT_SIGSENSE_DB = path.resolve(
    __dirname, '..', '..', 'sigsense', 'engine', 'ecoprint_telemetry.db'
);

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
        const conditions = [
            `timestamp IS NOT NULL`,
            `timestamp != ''`,
            `timestamp >= ?`,
            `timestamp <= ?`,
        ];
        const params = [windowStart, windowEnd];

        if (resourceId) {
            conditions.push(`node_id = ?`);
            params.push(resourceId);
        }

        const sql = `
            SELECT timestamp,
                   node_id            AS resource_id,
                   total_power_watts,
                   carbon_gCO2e,
                   water_liters
            FROM   telemetry
            WHERE  ${conditions.join(' AND ')}
            ORDER  BY timestamp ASC
        `;

        db.all(sql, params, (err, rows) => {
            if (err) { reject(err); return; }
            resolve(rows.map(r => ({
                timestamp:         r.timestamp,
                resource_id:       r.resource_id  ?? null,
                total_power_watts: r.total_power_watts ?? 0,
                carbon_gCO2e:      r.carbon_gCO2e      ?? 0,
                water_liters:      r.water_liters       ?? 0,
            })));
        });
    });
}
