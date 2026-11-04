// A small writable database for local development only (never on Vercel): leads that found no email or webhook,
// and review verdicts from the review console. The reference database itself is always opened read-only.
import Database from "better-sqlite3";
import { LOCAL_DB } from "../config";

let conn: Database.Database | null = null;

export function localDb(): Database.Database {
  if (!conn) {
    conn = new Database(LOCAL_DB);
    conn.exec(`CREATE TABLE IF NOT EXISTS lead (id INTEGER PRIMARY KEY, created_at TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS review (id INTEGER PRIMARY KEY, created_at TEXT, plan_id TEXT, feature TEXT, item_key TEXT,
        input TEXT, output TEXT, verdict TEXT, correction TEXT, note TEXT)`);
  }
  return conn;
}
