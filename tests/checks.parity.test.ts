// Release checks against their Python originals: the site crawl (both crawl the same built Next server), the data
// check's structure part (no live samples), the every-country matrix on stored data (--no-live, written files and
// printed report compared), and the review replay. Live re-fetches are not compared: the sources change.
import { type ChildProcess, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BUILD_ENV, startNext } from "./next";

const run = promisify(execFile);
const PY_APP = path.resolve("../export-desk"), PORT = 3925;
const ENV = { ...process.env, ...BUILD_ENV, EXPORTWALLA_TMP: fs.mkdtempSync(path.join(os.tmpdir(), "ew-checks-")) };
const py = (args: string[], env: Record<string, string> = {}) =>
  run(path.join(PY_APP, ".venv/bin/python"), ["-m", ...args], { cwd: PY_APP, env: { ...ENV, ...env }, maxBuffer: 1 << 26 }).catch((e) => e);
const ts = (args: string[], env: Record<string, string> = {}) =>
  run("npx", ["tsx", "src/checks/cli.ts", ...args], { env: { ...ENV, ...env }, maxBuffer: 1 << 26 }).catch((e) => e);

let next: ChildProcess | null = null;
beforeAll(async () => { next = await startNext(PORT); }, 300_000);
afterAll(() => next?.kill());

describe("release checks, parity with Python", () => {
  test("site crawl: every sitemap URL, its links, robots, llms.txt and the API", async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const [a, b] = await Promise.all([py(["evals.seo_check", "--base", base]), ts(["seo", "--base", base])]);
    console.log(`python: ${a.stdout.trim().split("\n").slice(0, 2).join(" / ")}\nts:     ${b.stdout.trim().split("\n").slice(0, 2).join(" / ")}`);
    expect(b.stdout).toBe(a.stdout);
    expect(b.code ?? 0).toBe(a.code ?? 0);
  }, 900_000);

  test("data check, structure part (no live samples)", async () => {
    const [a, b] = await Promise.all([py(["evals.check_data", "--n", "0"]), ts(["data", "--n", "0"])]);
    console.log(b.stdout.trim());
    expect(b.stdout).toBe(a.stdout);
  }, 300_000);

  test("every country x stage, on stored data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-matrix-"));
    const [a, b] = await Promise.all([py(["evals.verify_matrix", "--no-live"], { VERIFY_OUT: `${dir}/py.json` }),
      ts(["matrix", "--no-live"], { VERIFY_OUT: `${dir}/ts.json` })]);
    expect(b.stdout).toBe(a.stdout);
    const load = (f: string) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); delete j.run_at; return j; };
    const pj = load(`${dir}/py.json`), tj = load(`${dir}/ts.json`);
    console.log(`${Object.keys(tj.countries).length} countries; tally ${JSON.stringify(tj.tally)}`);
    expect(JSON.stringify(tj)).toBe(JSON.stringify(pj));
  }, 600_000);

  test("review replay", async () => {
    const [a, b] = await Promise.all([py(["evals.run_evals"]), ts(["evals"])]);
    expect(b.stdout).toBe(a.stdout);
  }, 300_000);
});
