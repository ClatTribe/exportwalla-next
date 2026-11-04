// data/reference.db: the slim, read-only database a deploy ships (and reference.db.gz). Keeps only what the app
// reads: no merchant data, no export-only HMRC rows, no bookkeeping columns; the search indexes are rebuilt. Port of
// export-desk/scripts/build_reference.py.
import fs from "node:fs";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { DATA_DIR } from "../lib/config";
import { FULL_DB, say } from "./core";
import { hsReference } from "./ingest";
import { SCHEMA } from "./schema";

export const REFERENCE_OUT = () => process.env.EXPORTWALLA_REFERENCE_OUT ?? `${DATA_DIR}/reference.db`;

const COPY: Record<string, string> = { // table -> SELECT over the source (schema taken from the source table)
  ingest_runs: "SELECT * FROM src.ingest_runs WHERE status='ok'",
  hs6: "SELECT * FROM src.hs6",
  countries: "SELECT * FROM src.countries",
  uk_commodity: "SELECT * FROM src.uk_commodity",
  us_hts: "SELECT * FROM src.us_hts",
  trade_flow: "SELECT * FROM src.trade_flow",
  india_export: "SELECT * FROM src.india_export",
  tariff_hs6: "SELECT * FROM src.tariff_hs6",
  rag_doc: "SELECT * FROM src.rag_doc",
  rag_chunk: "SELECT * FROM src.rag_chunk",
};

export function buildReference(src = FULL_DB(), dst = REFERENCE_OUT()) {
  fs.rmSync(dst, { force: true });
  const con = new Database(dst);
  con.prepare("ATTACH DATABASE ? AS src").run(src);
  con.exec("BEGIN");
  for (const [t, sel] of Object.entries(COPY)) {
    const ddl = con.prepare("SELECT sql FROM src.sqlite_master WHERE type='table' AND name=?").get(t) as { sql: string };
    con.exec(ddl.sql);
    con.exec(`INSERT INTO main.${t} ${sel}`);
  }
  // HMRC: only import records, only the columns find_buyers reads, and only traders that remain. The key starts
  // with cn8: buyer lookups are "cn8 LIKE 'hs6%'" prefix scans, so no second index is needed.
  con.exec(`CREATE TABLE uk_trader_commodity (trader_id INTEGER, cn8 TEXT, year INTEGER, import_months TEXT,
                   PRIMARY KEY (cn8, trader_id, year)) WITHOUT ROWID`);
  con.exec(`INSERT INTO uk_trader_commodity SELECT trader_id, cn8, year, import_months FROM src.uk_trader_commodity
                   WHERE import_months IS NOT NULL AND import_months <> ''`);
  con.exec("CREATE TABLE uk_trader (trader_id INTEGER PRIMARY KEY, name TEXT, address TEXT, postcode TEXT)");
  con.exec(`INSERT INTO uk_trader SELECT trader_id, name, address, postcode FROM src.uk_trader
                   WHERE trader_id IN (SELECT DISTINCT trader_id FROM uk_trader_commodity)`);
  // HS chapter / heading names (the raw Comtrade file is not shipped)
  con.exec("CREATE TABLE hs_ref (code TEXT PRIMARY KEY, text TEXT)");
  const put = con.prepare("INSERT INTO hs_ref VALUES (?, ?)");
  for (const [code, text] of hsReference()) put.run(code, text);
  // search indexes
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.includes("VIRTUAL TABLE") && (stmt.includes("rag_fts") || stmt.includes("tree_fts"))) con.exec(stmt);
  }
  con.exec("INSERT INTO rag_fts(rag_fts) VALUES ('rebuild')");
  con.exec("INSERT INTO tree_fts (code, context, text) SELECT code, context, text FROM src.tree_fts");
  // empty workspace tables so shared code that mentions them still parses
  for (const stmt of SCHEMA.split(";")) {
    if (["profile", "upload", "plan", "review"].some((t) => stmt.includes(`EXISTS ${t} `))) con.exec(stmt);
  }
  con.exec("COMMIT");
  con.exec("DETACH DATABASE src");
  con.exec("VACUUM");
  con.close();
  fs.writeFileSync(dst + ".gz", zlib.gzipSync(fs.readFileSync(dst), { level: 9 }));
  say(`reference.db: ${Math.round(fs.statSync(dst).size / 1e6)} MB, reference.db.gz: ${Math.round(fs.statSync(dst + ".gz").size / 1e6)} MB`);
}
