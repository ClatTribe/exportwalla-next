// The data pipeline's foundation: where things live, a write connection that behaves like Python's sqlite3 module
// (statements open a transaction, commit() ends it), the cached HTTP fetch every ingester uses, and ingest-run
// bookkeeping. Port of export-desk/ingest/common.py and db.py. Output must match the Python pipeline row for row
// (tests/pipeline.parity.test.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, readonly, TMP_DIR } from "../lib/config";
import { db } from "../lib/db";
import { pyFloat, pyJson, pyStrip } from "../lib/py";
import { SCHEMA } from "./schema";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The full build database (every table, bookkeeping included); reference.db is cut from it for deploys. */
export const FULL_DB = () => process.env.EXPORTWALLA_DB ?? path.join(DATA_DIR, "export_desk.db");
/** Cached API responses, one file per request, so a pull can be replayed offline. */
export const RAW_DIR = () => (readonly() ? path.join(TMP_DIR, "raw") : path.join(DATA_DIR, "raw"));

export const PACE: Record<string, number> = { comtrade: 6.0, uk_tariff: 0.08, uktradeinfo: 0.5, usitc: 0.5, wits: 1.0, uk_tariff_search: 0.3, docs: 1.0 };
export const TRADE_YEARS = [2024, 2023];
export const UK_TRADER_YEARS = [2026, 2025];
export const INDIA_COMTRADE_CODE = 699;
export const WORLD_COMTRADE_CODE = 0;

/** ingest.common.now(): UTC to the second. */
export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** Python binds ints as INTEGER; better-sqlite3 binds every number as REAL ("5" would read back as "5.0" in a TEXT
 * column), so whole numbers go in as BigInt. Booleans become 0/1 and undefined NULL, as in Python. */
const bind = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v)
  : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v);

export class Conn {
  readonly db: Database.Database;
  /** Where ingest writes go: the build database itself, or "main." (the overlay) on the app's own connection. */
  readonly writePrefix: string;
  private stmts = new Map<string, Database.Statement>();

  constructor(file: string | Database.Database, writePrefix = "") {
    if (typeof file === "string") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.db = new Database(file, { timeout: 300_000 });
      this.db.pragma("journal_mode = WAL");
    } else this.db = file;
    this.writePrefix = writePrefix;
  }

  /** The table an ingester writes to (db.table() in the Python pipeline). */
  table(name: string) {
    return this.writePrefix + name;
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /** A write statement: opens a transaction first, like Python's sqlite3 does for INSERT/UPDATE/DELETE. */
  run(sql: string, ...params: unknown[]): Database.RunResult {
    if (!this.db.inTransaction) this.db.exec("BEGIN");
    return this.stmt(sql).run(...params.map(bind));
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    const s = this.stmt(sql);
    return (s.reader ? s.all(...params.map(bind)) : (this.run(sql, ...params), [])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | null {
    return (this.stmt(sql).get(...params.map(bind)) as T | undefined) ?? null;
  }

  /** executescript(): commits what is pending, then runs the script. */
  exec(script: string) {
    this.commit();
    this.db.exec(script);
  }

  commit() {
    if (this.db.inTransaction) this.db.exec("COMMIT");
  }

  close() {
    this.commit();
    this.db.close();
  }
}

/** db.init(): create every table. */
export function init(conn: Conn) {
  conn.exec(SCHEMA);
}

// ---------------------------------------------------------------- cached fetch

const lastCall: Record<string, number> = {};
const USER_AGENT = "exportwalla/0.1 (research use)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 exportwalla/0.1";

export function cachePath(source: string, url: string): string {
  const key = crypto.createHash("sha1").update(url, "utf8").digest("hex").slice(0, 20);
  const d = path.join(RAW_DIR(), source);
  fs.mkdirSync(d, { recursive: true });
  return path.join(/*turbopackIgnore: true*/ d, `${key}.json`);
}

/** EXPORTWALLA_OFFLINE=1: replay from the cache only (parity runs); a miss is an error, never a fetch. */
function offline(url: string) {
  if (process.env.EXPORTWALLA_OFFLINE === "1") throw new Error(`offline and not cached: ${url}`);
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** The cache file: {"url", "fetched_at", "body"}. A JSON body is written as received, so numbers keep their form. */
function writeCache(file: string, url: string, bodyJson: string) {
  fs.writeFileSync(/*turbopackIgnore: true*/ file, `{"url": ${pyJson(url)}, "fetched_at": ${pyJson(now())}, "body": ${bodyJson}}`);
}

async function request(source: string, url: string, headers: Record<string, string>, retries: number, timeout: number,
  onOk: (res: Response) => Promise<unknown>, onGone: () => unknown, goneCodes: number[]): Promise<unknown> {
  const pace = PACE[source] ?? 0.5;
  const wait = pace - (performance.now() / 1000 - (lastCall[source] ?? -Infinity));
  if (wait > 0) await sleep(wait);
  let backoff = Math.max(pace, 2.0);
  for (let attempt = 0; attempt < retries; attempt++) {
    lastCall[source] = performance.now() / 1000;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout * 1000) });
    } catch (e) {
      if (attempt < retries - 1) { await sleep(backoff); backoff *= 2; continue; }
      throw e;
    }
    if (res.ok) return onOk(res);
    if (goneCodes.includes(res.status)) return onGone();
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries - 1) { await sleep(backoff); backoff *= 2; continue; }
    throw new Error(`HTTP Error ${res.status}: ${res.statusText} (${url})`);
  }
  return null;
}

/** GET a JSON URL, using the cache unless refresh. Returns the parsed body, or null on 404. */
export async function getJson(source: string, url: string, headers: Record<string, string> = {}, refresh = false, retries = 6): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const file = cachePath(source, url);
  // the cache is runtime data (data/raw locally, /tmp on a deploy): keep it out of file tracing
  if (fs.existsSync(/*turbopackIgnore: true*/ file) && !refresh) return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")).body;
  offline(url);
  return request(source, url, { "User-Agent": USER_AGENT, ...headers }, retries, 60, async (res) => {
    const text = await res.text();
    const body = JSON.parse(text);
    writeCache(file, url, text.trim());
    return body;
  }, () => { writeCache(file, url, "null"); return null; }, [404]);
}

/** GET any URL (XML, HTML, PDF) with the same cache and pacing: a string, bytes (binary) or null on 404/410. */
export async function getText(source: string, url: string, refresh = false, retries = 5, binary = false): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const file = cachePath(source, url), bfile = file.replace(/\.json$/, ".bin");
  if (!refresh) {
    if (binary && fs.existsSync(/*turbopackIgnore: true*/ bfile)) return fs.readFileSync(/*turbopackIgnore: true*/ bfile);
    if (fs.existsSync(/*turbopackIgnore: true*/ file)) {
      const cached = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
      if (!binary || cached.body === null || cached.body === undefined) return cached.body ?? null;
    }
  }
  offline(url);
  return request(source, url, { "User-Agent": BROWSER_UA, Accept: "*/*" }, retries, 90, async (res) => {
    const raw = Buffer.from(await res.arrayBuffer());
    if (binary) {
      fs.writeFileSync(/*turbopackIgnore: true*/ bfile, raw);
      writeCache(file, url, '"<binary>"');
      return raw;
    }
    const body = new TextDecoder("utf-8").decode(raw); // drops a BOM, replaces bad bytes (utf-8-sig, errors="replace")
    writeCache(file, url, pyJson(body));
    return body;
  }, () => { writeCache(file, url, "null"); return null; }, [404, 410]);
}

export function fetchedAt(source: string, url: string): string | null {
  const file = cachePath(source, url);
  return fs.existsSync(/*turbopackIgnore: true*/ file) ? JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")).fetched_at ?? null : null;
}

// ---------------------------------------------------------------- run bookkeeping

/** The app's own connection, writing fetched rows to its overlay (on-demand trade data). */
export const appConn = () => new Conn(db(), "main.");

export function startRun(conn: Conn, source: string, note = ""): number {
  const r = conn.run(`INSERT INTO ${conn.table("ingest_runs")} (source, started_at, status, note) VALUES (?, ?, 'running', ?)`, source, now(), note);
  conn.commit();
  return Number(r.lastInsertRowid);
}

export function finishRun(conn: Conn, runId: number, rows: number, status = "ok", note: string | null = null) {
  conn.run(`UPDATE ${conn.table("ingest_runs")} SET finished_at=?, rows=?, status=?, note=COALESCE(?, note) WHERE id=?`, now(), rows, status, note, runId);
  conn.commit();
}

/** '8.00 %' -> 8.0, '8%' -> 8.0, 'Free' -> 0.0, anything compound -> null. */
export function parsePct(rate: unknown): number | null {
  if (rate === null || rate === undefined) return null;
  const s = pyStrip(String(rate));
  if (!s) return null;
  if (s.toLowerCase().startsWith("free")) return 0.0;
  const s2 = s.replaceAll(" ", "");
  if (s2.endsWith("%")) {
    try {
      return pyFloat(s2.slice(0, -1));
    } catch {
      return null;
    }
  }
  return null;
}

/** A progress line, as the Python ingesters print. */
export const say = (msg: string) => { if (process.env.PIPELINE_QUIET !== "1") console.log(msg); };
