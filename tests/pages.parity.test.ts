// Page parity: the Python static build (export-desk/scripts/build_static.py) and the TypeScript renderers must produce
// the same bytes for every page, .md twin and crawl file, under the same settings. The first test renders directly;
// the second serves every path through the built Next server (routing, status, content type). Settings run twice:
// the defaults, and every optional business detail filled in (WhatsApp, legal name, email, verification tags...).
// The served test uses the shared test build (tests/next.ts), whose settings are the defaults below.
import { type ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BUILD_ENV, startNext } from "./next";

const PY_APP = path.resolve("../export-desk");
const PORT = 3919;

const BASE = BUILD_ENV;
const FILLED: Record<string, string> = {
  ...BASE, SITE_URL: "https://exportwalla.example/", DESK_PHONE: "+91 98250 12345", DESK_WHATSAPP: "919825012345",
  CONTACT_EMAIL: "desk@exportwalla.example", LEGAL_NAME: "Exportwalla Private Limited", BUSINESS_ADDRESS: "12 Mall Road, Kanpur 208001 & Co",
  GRIEVANCE_OFFICER: "A. Verma, grievance@exportwalla.example", GOOGLE_SITE_VERIFICATION: "g-token", BING_SITE_VERIFICATION: "b-token",
  PRICE_FROM_INR: "15,000", INDEXNOW_KEY: "abc123key", GEMINI_API_KEY: "set",
};

/** Builds the Python site into a temp folder; returns every file as [url path, absolute file]. */
function pythonBuild(env: Record<string, string>): { dir: string; files: [string, string][] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-public-"));
  execFileSync(path.join(PY_APP, ".venv/bin/python"), ["scripts/build_static.py"], { cwd: PY_APP, stdio: "ignore",
    env: { ...process.env, ...env, EXPORTWALLA_PUBLIC: dir, EXPORTWALLA_TMP: fs.mkdtempSync(path.join(os.tmpdir(), "ew-tmp-")) } });
  const files: [string, string][] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else files.push(["/" + path.relative(dir, full), full]);
    }
  };
  walk(dir);
  return { dir, files };
}

/** The URL a static file is served at (Vercel cleanUrls: /about.html is /about, index.html is /). */
const urlOf = (rel: string) => (rel === "/index.html" ? "/" : rel.endsWith(".html") ? rel.slice(0, -5) : rel);

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: python ${JSON.stringify(a.slice(Math.max(0, i - 80), i + 120))}\n   ts     ${JSON.stringify(b.slice(Math.max(0, i - 80), i + 120))}`;
}

let next: ChildProcess | null = null;
afterAll(() => next?.kill());

describe.each([["defaults", BASE], ["all settings filled", FILLED]])("pages, %s", (_label, env) => {
  test("rendered pages, .md twins and crawl files are byte-identical", async () => {
    const { files } = pythonBuild(env);
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const { render } = await import("../src/lib/pages/router");
      const { pyJson } = await import("../src/lib/py");
      const { home } = await import("../src/lib/server/public");
      const { mcpCard } = await import("../src/lib/site");
      const { MCP_TOOLS } = await import("../src/lib/server/mcp");
      const special: Record<string, () => string> = {
        "/home-data.json": () => pyJson(home(), { ascii: false }),
        "/.well-known/mcp.json": () => pyJson(mcpCard(MCP_TOOLS), { ascii: false, indent: 1 }),
        "/404": () => render("/no-such-page").body,
        "/favicon.svg": () => fs.readFileSync("public/favicon.svg", "utf8"),
      };
      let same = 0, assets = 0;
      const diffs: string[] = [];
      for (const [rel, file] of files) {
        if (rel.startsWith("/static/")) {
          const ours = path.join("public", rel);
          if (!fs.existsSync(ours) || !fs.readFileSync(ours).equals(fs.readFileSync(file))) diffs.push(`${rel}: static file differs or is missing`);
          else assets++;
          continue;
        }
        const url = urlOf(rel);
        const want = fs.readFileSync(file, "utf8");
        const got = special[url] ? special[url]() : render(url).body;
        if (got === want) same++;
        else if (diffs.length < 12) diffs.push(`${url}: ${firstDiff(want, got)}`);
        else diffs.push(url);
      }
      const pages = files.filter(([r]) => !r.startsWith("/static/")).length;
      console.log(`${_label}: ${same}/${pages} pages and files identical, ${assets} static assets identical`);
      if (diffs.length) console.log(diffs.slice(0, 12).join("\n") + (diffs.length > 12 ? `\n...and ${diffs.length - 12} more` : ""));
      expect(diffs).toEqual([]);
    } finally {
      for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }, 900_000);
});

test("served by Next: every path, status, content type and bytes", async () => {
  const { files } = pythonBuild(BASE);
  next = await startNext(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  const types: Record<string, string> = { ".html": "text/html", ".md": "text/markdown", ".xml": "application/xml", ".txt": "text/", ".json": "application/json",
    ".svg": "image/svg+xml", ".css": "text/css", ".js": "javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  let ok = 0;
  const bad: string[] = [];
  let i = 0;
  const work = files.filter(([rel]) => rel !== "/404.html");
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (i < work.length) {
      const [rel, file] = work[i++];
      const res = await fetch(base + urlOf(rel), { redirect: "manual" });
      const body = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(rel) || ".html";
      const typeOk = (res.headers.get("content-type") ?? "").includes(types[ext] ?? "");
      if (res.status === 200 && typeOk && body.equals(fs.readFileSync(file))) ok++;
      else bad.push(`${urlOf(rel)}: ${res.status} ${res.headers.get("content-type")}${res.status === 200 && typeOk ? " (bytes differ)" : ""}`);
    }
  }));
  const missing = await fetch(base + "/export-to/atlantis");
  const notFoundHtml = await missing.text();
  const old = await fetch(base + "/about.html", { redirect: "manual" });
  const md = await fetch(base + "/about.md");
  console.log(`served: ${ok}/${work.length} identical; 404 -> ${missing.status}; /about.html -> ${old.status} ${old.headers.get("location")}`);
  if (bad.length) console.log(bad.slice(0, 15).join("\n"));
  expect(bad).toEqual([]);
  expect(missing.status).toBe(404);
  expect(notFoundHtml).toBe(fs.readFileSync(files.find(([r]) => r === "/404.html")![1], "utf8"));
  expect([old.status, old.headers.get("location")]).toEqual([308, "/about"]);
  expect(md.headers.get("content-type")).toContain("text/markdown");
}, 900_000);
