import initSqlJs from 'sql.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, 'scans.db');

// ── Initialise ──────────────────────────────────────────────────────────────
const SQL = await initSqlJs();
let db;

if (existsSync(DB_PATH)) {
  const buf = readFileSync(DB_PATH);
  db = new SQL.Database(buf);
} else {
  db = new SQL.Database();
}

db.run(`
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    target_url TEXT NOT NULL,
    pages_scanned INTEGER NOT NULL,
    pi_links_found INTEGER NOT NULL,
    pass INTEGER NOT NULL,
    warn INTEGER NOT NULL,
    fail INTEGER NOT NULL,
    scan_time_seconds REAL NOT NULL,
    results_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(domain);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at);`);

db.run(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    scan_id INTEGER NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_domain ON alerts(domain);`);

persist();

// ── Helpers ─────────────────────────────────────────────────────────────────
function persist() {
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ── Public API ──────────────────────────────────────────────────────────────
export function extractDomain(url) {
  try { return new URL(url).hostname; }
  catch { return url; }
}

export function saveScan(targetUrl, scanResult) {
  const domain = extractDomain(targetUrl);
  const { summary, scan_time_seconds, results } = scanResult;

  db.run(
    `INSERT INTO scans (domain, target_url, pages_scanned, pi_links_found, pass, warn, fail, scan_time_seconds, results_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [domain, targetUrl, summary.pages_scanned, summary.pi_links_found, summary.pass, summary.warn, summary.fail, scan_time_seconds, JSON.stringify(results)]
  );

  const row = queryOne('SELECT last_insert_rowid() as id');
  persist();
  return row.id;
}

export function getScanHistory(domain) {
  return queryAll(
    `SELECT id, domain, target_url, pages_scanned, pi_links_found, pass, warn, fail, scan_time_seconds, created_at
     FROM scans WHERE domain = ? ORDER BY created_at DESC`,
    [domain]
  );
}

export function getLatestScan(domain) {
  const row = queryOne(`SELECT * FROM scans WHERE domain = ? ORDER BY created_at DESC LIMIT 1`, [domain]);
  if (row) row.results_json = JSON.parse(row.results_json);
  return row;
}

export function saveAlert(domain, scanId, severity, message, details = null) {
  db.run(
    `INSERT INTO alerts (domain, scan_id, severity, message, details_json) VALUES (?, ?, ?, ?, ?)`,
    [domain, scanId, severity, message, details ? JSON.stringify(details) : null]
  );
  persist();
}

export function getAlerts(domain) {
  return queryAll(`SELECT * FROM alerts WHERE domain = ? ORDER BY created_at DESC`, [domain]).map((row) => {
    if (row.details_json) row.details_json = JSON.parse(row.details_json);
    return row;
  });
}

export default db;
