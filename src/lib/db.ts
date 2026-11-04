// The app's database connection. The reference database (the file a deploy ships) is attached read-only under a
// small writable overlay in EXPORTWALLA_TMP, which holds trade data fetched on demand for products outside the
// shipped scope. Unqualified names resolve to the reference tables; two temporary views keep the semantics the
// Python app had: trade_flow is the shipped rows plus the fetched ones, ingest_runs is the shipped run history.
// The data pipeline (EXPORTWALLA_PIPELINE=1) reads its build database directly, without an overlay.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { REFERENCE_DB, TMP_DIR } from "./config";

export type Row = Record<string, unknown>;

const OVERLAY_TABLES = `
CREATE TABLE IF NOT EXISTS trade_flow (
    year INTEGER, hs6 TEXT, reporter_m49 INTEGER, partner_m49 INTEGER, flow TEXT,
    value_usd REAL, qty REAL, qty_unit TEXT, run_id INTEGER,
    PRIMARY KEY (year, hs6, reporter_m49, partner_m49, flow)
);
CREATE TABLE IF NOT EXISTS ingest_runs (
    id INTEGER PRIMARY KEY, source TEXT, started_at TEXT, finished_at TEXT, rows INTEGER, status TEXT, note TEXT
);`;

let conn: Database.Database | null = null;

export const usesOverlay = () => process.env.EXPORTWALLA_PIPELINE !== "1";

export function db(): Database.Database {
  if (conn) return conn;
  if (!fs.existsSync(REFERENCE_DB)) throw new Error(`Reference database missing at ${REFERENCE_DB}`);
  if (!usesOverlay()) return (conn = new Database(REFERENCE_DB, { readonly: true, fileMustExist: true }));
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const c = new Database(path.join(TMP_DIR, "overlay.db"));
  c.exec(OVERLAY_TABLES);
  c.prepare("ATTACH DATABASE ? AS ref").run(REFERENCE_DB);
  c.exec(`CREATE TEMP VIEW trade_flow AS SELECT * FROM ref.trade_flow UNION ALL SELECT * FROM main.trade_flow;
          CREATE TEMP VIEW ingest_runs AS SELECT * FROM ref.ingest_runs;`);
  return (conn = c);
}

/** Point the engine at another database (the retrieval ablation's scratch builds); null returns to the default. */
export function switchDatabase(file: string | null) {
  conn?.close();
  conn = file ? new Database(file, { readonly: true, fileMustExist: true }) : null;
}

export function one<T = Row>(sql: string, ...params: unknown[]): T | null {
  return (db().prepare(sql).get(...params) as T | undefined) ?? null;
}

export function rows<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}
