// The data pipeline from the command line (replaces export-desk's python -m ingest.* and scripts/build_reference.py):
//
//   npm run data -- rebuild-all              every step in order, into EXPORTWALLA_DB (default data/export_desk.db)
//   npm run data -- run-all [--refresh] [--only uk_tariff,uk_traders]
//   npm run data -- india-exports | wits | scope-pull | rules-docs [--fixed] [--no-context]
//   npm run data -- build-reference          data/reference.db and .gz from the build database
//   npm run data -- site-index               data/seo_index.json from the build database
//
// EXPORTWALLA_OFFLINE=1 replays the data/raw cache only. EXPORTWALLA_REFERENCE_OUT and EXPORTWALLA_INDEX_OUT write
// elsewhere. The engine reads the database named by EXPORTWALLA_DB, so it is set before anything else loads.
import path from "node:path";

const dataDir = process.env.EXPORTWALLA_DATA ?? path.resolve(process.cwd(), "data");
const explicitDb = Boolean(process.env.EXPORTWALLA_DB);
process.env.EXPORTWALLA_PIPELINE = "1"; // the engine reads the build database directly, no overlay
process.env.EXPORTWALLA_DB ??= path.join(dataDir, "export_desk.db");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const { Conn, FULL_DB, init, say } = await import("./core");
  const ing = await import("./ingest");
  const { rulesDocs } = await import("./rulesDocs");
  const { buildReference } = await import("./buildReference");
  const { buildSiteIndex, writeSiteIndex } = await import("./siteIndex");
  const step = async (name: string, fn: () => unknown) => {
    const t = Date.now();
    say(`[${name}] starting`);
    const n = await fn();
    say(`[${name}] ${typeof n === "number" ? n : "done"} in ${Math.round((Date.now() - t) / 1000)}s`);
  };
  const withConn = async (fn: (c: InstanceType<typeof Conn>) => unknown) => {
    const conn = new Conn(FULL_DB());
    try { init(conn); return await fn(conn); } finally { conn.close(); }
  };
  const refresh = flag("--refresh");
  const RUN_ALL: [string, (c: InstanceType<typeof Conn>) => Promise<number>][] = [
    ["reference", (c) => ing.reference(c, refresh)], ["uk_tariff", (c) => ing.ukTariff(c, refresh)],
    ["us_hts", (c) => ing.usHts(c, refresh)], ["uk_traders", (c) => ing.ukTraders(c, refresh)], ["comtrade", (c) => ing.comtrade(c, refresh)],
  ];
  const only = new Set((opt("--only") ?? "").split(",").filter(Boolean));
  switch (cmd) {
    case "rebuild-all":
      if (!explicitDb) throw new Error("set EXPORTWALLA_DB to a new database file: rebuild-all builds from scratch");
      await withConn(async (c) => {
        for (const [name, fn] of RUN_ALL) await step(name, () => fn(c));
        await step("india_exports", () => ing.indiaExports(c));
        await step("wits_tariff", () => ing.witsTariff(c));
        await step("scope_pull", () => ing.scopePull(c));
        await step("rules_docs", () => rulesDocs(c));
      });
      await step("build_reference", () => buildReference());
      await step("site_index", () => withConn((c) => writeSiteIndex(buildSiteIndex(c))));
      break;
    case "run-all":
      await withConn(async (c) => { for (const [name, fn] of RUN_ALL) if (!only.size || only.has(name)) await step(name, () => fn(c)); });
      break;
    case "india-exports": await withConn((c) => step("india_exports", () => ing.indiaExports(c, refresh))); break;
    case "wits": await withConn((c) => step("wits_tariff", () => ing.witsTariff(c, refresh))); break;
    case "scope-pull": await withConn((c) => step("scope_pull", () => ing.scopePull(c))); break;
    case "rules-docs": await withConn((c) => step("rules_docs", () => rulesDocs(c, flag("--fixed") ? "fixed" : "structured", !flag("--no-context")))); break;
    case "build-reference": await step("build_reference", () => buildReference()); break;
    case "site-index": await step("site_index", () => withConn((c) => writeSiteIndex(buildSiteIndex(c)))); break;
    default:
      console.log("usage: npm run data -- rebuild-all | run-all | india-exports | wits | scope-pull | rules-docs | build-reference | site-index");
      process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
