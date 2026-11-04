// Row-for-row comparison of two SQLite databases: every table (search-index tables included), its schema, and each
// row in storage order with each value's SQLite type. Time-stamp columns are blanked.
import Database from "better-sqlite3";

const MASK = new Set(["fetched_at", "started_at", "finished_at"]);

export interface TableDiff { table: string; rows: [number, number]; same: number; first: string[] }

export function diffDb(fileA: string, fileB: string, opts: { skip?: (t: string) => boolean } = {}): { tables: TableDiff[]; schema: string[] } {
  const a = new Database(fileA, { readonly: true }), b = new Database(fileB, { readonly: true });
  try {
    const schema = (d: Database.Database) => new Map((d.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL")
      .all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql.replace(/\s+/g, " ")]));
    const sa = schema(a), sb = schema(b);
    const schemaDiffs = [...new Set([...sa.keys(), ...sb.keys()])].filter((n) => sa.get(n) !== sb.get(n)).map((n) => `${n}: ${sa.get(n)} | ${sb.get(n)}`);
    const tables = (a.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name).filter((t) => !opts.skip?.(t));
    const out: TableDiff[] = [];
    for (const t of tables) {
      if (!sb.has(t)) { out.push({ table: t, rows: [-1, -1], same: 0, first: ["missing in the second database"] }); continue; }
      const cols = (a.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((r) => r.name);
      const sel = cols.map((c) => (MASK.has(c) ? `'-' AS "${c}"` : `typeof("${c}") || ':' || quote("${c}") AS "${c}"`)).join(", ");
      const withoutRowid = /WITHOUT ROWID/i.test(sa.get(t) ?? "");
      const isVirtual = /VIRTUAL TABLE/i.test(sa.get(t) ?? "");
      const order = withoutRowid || isVirtual ? "" : " ORDER BY rowid";
      const rowid = withoutRowid ? "" : "rowid AS __rowid, ";
      const q = `SELECT ${rowid}${sel} FROM "${t}"${order}`;
      const ra = a.prepare(q).raw().iterate() as IterableIterator<unknown[]>, rb = b.prepare(q).raw().iterate() as IterableIterator<unknown[]>;
      let na = 0, nb = 0, same = 0;
      const first: string[] = [];
      for (;;) {
        const x = ra.next(), y = rb.next();
        if (x.done && y.done) break;
        if (!x.done) na++;
        if (!y.done) nb++;
        const sx = x.done ? "<none>" : JSON.stringify(x.value, (_, v) => (typeof v === "bigint" ? String(v) : v));
        const sy = y.done ? "<none>" : JSON.stringify(y.value, (_, v) => (typeof v === "bigint" ? String(v) : v));
        if (sx === sy) same++;
        else if (first.length < 3) first.push(`row ${Math.max(na, nb)}: ${sx.slice(0, 400)}\n      vs ${sy.slice(0, 400)}`);
      }
      out.push({ table: t, rows: [na, nb], same, first });
    }
    return { tables: out, schema: schemaDiffs };
  } finally {
    a.close();
    b.close();
  }
}
