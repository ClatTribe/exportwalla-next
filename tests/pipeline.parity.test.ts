// The whole data pipeline against the Python one: both rebuild every data product from scratch, offline, from the
// same cache of API responses (data/raw): the build database row for row (search-index tables and value types
// included), the deploy database (reference.db) row for row, and the site index (seo_index.json) value for value
// in the same key order. Heavy (1.4 million rows twice, OCR of 93 PDFs), so it runs on its own: npm run test:pipeline.
// Skipped otherwise, and where the raw cache is not present. About two minutes.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { DATA_DIR, REFERENCE_DIR } from "../src/lib/config";
import { diffDb } from "./dbdiff";

const run = promisify(execFile);
const PY_APP = path.resolve("../export-desk");
const RAW = path.join(DATA_DIR, "raw");

function outputs(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ew-${label}-`));
  return { dir, env: { EXPORTWALLA_DB: `${dir}/full.db`, EXPORTWALLA_REFERENCE_OUT: `${dir}/reference.db`, EXPORTWALLA_INDEX_OUT: `${dir}/seo_index.json`,
    EXPORTWALLA_OFFLINE: "1", EXPORTWALLA_READONLY: "", PIPELINE_QUIET: "1" } };
}

// the fact cards print rule values with str(): Python writes 20.0, JavaScript 20, so whole-number floats must not appear
test("country rules carry no whole-number floats", () => {
  for (const f of fs.readdirSync(REFERENCE_DIR).filter((n) => n.endsWith(".json"))) {
    expect(fs.readFileSync(path.join(REFERENCE_DIR, f), "utf8").match(/:\s*-?\d+\.0\b(?!\d)/g) ?? [], f).toEqual([]);
  }
});

describe.skipIf(!fs.existsSync(RAW) || process.env.PIPELINE_TEST !== "1")("data pipeline parity with Python (offline replay of data/raw)", () => {
  test("build database, deploy database and site index", async () => {
    const py = outputs("py"), ts = outputs("ts");
    await Promise.all([
      run(path.join(PY_APP, ".venv/bin/python"), ["scripts/rebuild_all.py"], { cwd: PY_APP, env: { ...process.env, ...py.env }, maxBuffer: 1 << 28 }),
      run("npx", ["tsx", "src/pipeline/cli.ts", "rebuild-all"], { env: { ...process.env, ...ts.env }, maxBuffer: 1 << 28 }),
    ]);
    for (const f of ["full.db", "reference.db"]) {
      const d = diffDb(`${py.dir}/${f}`, `${ts.dir}/${f}`);
      const bad = d.tables.filter((t) => t.rows[0] !== t.rows[1] || t.same !== t.rows[0]);
      const rowsTotal = d.tables.reduce((s, t) => s + t.rows[0], 0);
      console.log(`${f}: ${d.tables.length - bad.length}/${d.tables.length} tables identical (${rowsTotal.toLocaleString("en")} rows), schema differences ${d.schema.length}`);
      for (const t of bad) console.log(`  ${t.table}: ${t.same}/${t.rows[0]} (ts ${t.rows[1]})\n    ${t.first.join("\n    ")}`);
      expect(d.schema).toEqual([]);
      expect(bad.map((t) => t.table)).toEqual([]);
    }
    const a = JSON.parse(fs.readFileSync(`${py.dir}/seo_index.json`, "utf8")), b = JSON.parse(fs.readFileSync(`${ts.dir}/seo_index.json`, "utf8"));
    const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order) : v && typeof v === "object"
      ? Object.entries(v as object).map(([k, x]) => [k, order(x)]) : v; // keeps key order in the comparison
    for (const k of Object.keys(a)) expect(JSON.stringify(order(b[k])), `seo_index.${k}`).toBe(JSON.stringify(order(a[k])));
    expect(Object.keys(b)).toEqual(Object.keys(a));
    console.log(`seo_index.json: ${Object.keys(a).length}/${Object.keys(a).length} sections identical, key order included `
      + `(${Object.keys(a.products).length} products, ${Object.keys(a.pairs).length} pairs, ${Object.keys(a.countries).length} countries)`);
  }, 900_000);

  test("retrieval ablation: four chunking variants x two retrievers, same scores", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-rageval-"));
    const env = { ...process.env, EXPORTWALLA_OFFLINE: "1", EXPORTWALLA_READONLY: "", PIPELINE_QUIET: "1" };
    await Promise.all([
      run(path.join(PY_APP, ".venv/bin/python"), ["-m", "evals.rag_eval"], { cwd: PY_APP, env: { ...env, RAG_EVAL_OUT: `${dir}/py.json` }, maxBuffer: 1 << 28 }),
      run("npx", ["tsx", "src/checks/cli.ts", "rag"], { env: { ...env, RAG_EVAL_OUT: `${dir}/ts.json` }, maxBuffer: 1 << 28 }),
    ]);
    const a = JSON.parse(fs.readFileSync(`${dir}/py.json`, "utf8")), b = JSON.parse(fs.readFileSync(`${dir}/ts.json`, "utf8"));
    console.log(`rag_eval: ${b.variants.length} variants; best ${JSON.stringify(b.best)}`);
    expect(b).toEqual(a);
  }, 1_800_000);
});
