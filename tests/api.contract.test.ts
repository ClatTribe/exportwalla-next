// API contract: every request goes to the FastAPI app (through the Python bridge's test client) and to the built
// Next.js server, and both answers must agree: status code, and the JSON body for every status but 422 (FastAPI and
// pydantic word validation errors their own way; only the status is compared there). Webhook deliveries (leads,
// reviews) are captured and compared too. Workspace calls are chained: each step's input is the Python answer to the
// step before, so one difference shows up once, where it starts.
//
// Both run read-only, without AI and without the live UK tariff search, on the shared test build (tests/next.ts).
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DATA_DIR } from "../src/lib/config";
import { python } from "./bridge";
import { BUILD_ENV, startNext } from "./next";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Req = { label: string; method: "GET" | "POST"; url: string; body?: unknown; raw?: string; headers?: Record<string, string>;
  files?: [string, string, Buffer][]; form?: Record<string, string> };
type Res = { status: number; body: unknown };

const PORT = 3917, HOOK_PORT = 3918, TOKEN = "op-test-token";
const FIX = path.resolve("tests/fixtures/intake");
const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "seo_index.json"), "utf8"));
const COUNTRIES = Object.keys(index.countries), PRODUCTS = Object.keys(index.products);

const ENV: Record<string, string> = {
  ...BUILD_ENV, EXPORTWALLA_TMP: fs.mkdtempSync(path.join(os.tmpdir(), "ew-contract-")), OPERATOR_TOKEN: TOKEN,
  SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "",
};
const hookUrls = (side: string) => ({ LEAD_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/${side}/lead`,
  REVIEW_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/${side}/review` });

// ---------------------------------------------------------------- the two servers and the webhook catcher

let next: ChildProcess | null = null;
let hookServer: http.Server | null = null;
const hooks: { path: string; body: Json }[] = [];

beforeAll(async () => {
  Object.assign(process.env, ENV);
  hookServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { hooks.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) }); res.end("ok"); });
  });
  await new Promise<void>((r) => hookServer!.listen(HOOK_PORT, "127.0.0.1", r));
  next = await startNext(PORT, { ...ENV, ...hookUrls("ts") });
}, 600_000);

afterAll(() => {
  next?.kill();
  hookServer?.close();
});

// ---------------------------------------------------------------- running a batch on both sides

async function onPython(reqs: Req[]): Promise<Res[]> {
  Object.assign(process.env, hookUrls("py"));
  const answers = await python(reqs.map((r) => ({
    fn: "http",
    args: r.files || r.form
      ? [r.method, r.url, null, r.headers ?? {}, (r.files ?? []).map(([f, n, b]) => [f, n, b.toString("base64")]), r.form ?? {}]
      : r.raw !== undefined ? [r.method, r.url, null, r.headers ?? {}, null, null, r.raw]
        : [r.method, r.url, r.body ?? null, r.headers ?? {}],
  })));
  return answers.map((a, i) => {
    if (!a.ok) throw new Error(`python ${reqs[i].label}: ${a.error}`);
    return a.value as Res;
  });
}

async function onNext(r: Req): Promise<Res> {
  const init: RequestInit = { method: r.method, headers: { ...r.headers } };
  if (r.files || r.form) {
    const fd = new FormData();
    for (const [f, n, b] of r.files ?? []) fd.append(f, new Blob([new Uint8Array(b)]), n);
    for (const [k, v] of Object.entries(r.form ?? {})) fd.append(k, v);
    init.body = fd;
  } else if (r.raw !== undefined || r.body !== undefined) {
    init.body = r.raw ?? JSON.stringify(r.body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(`http://127.0.0.1:${PORT}${r.url}`, init);
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

async function pool<T, U>(xs: T[], n: number, fn: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const j = i++; out[j] = await fn(xs[j]); } }));
  return out;
}

/** Sorted keys, the time stamps blanked, and MCP text content parsed (Python's json.dumps spaces it differently). */
const MASK = new Set(["created_at", "received_at"]);
function norm(v: unknown, key = ""): unknown {
  if (MASK.has(key) && typeof v === "string") return "<time>";
  if (key === "text" && typeof v === "string" && /^[[{]/.test(v)) {
    try { return norm(JSON.parse(v)); } catch { /* plain text */ }
  }
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Json)[k], k)]));
  return v;
}

const tally: Record<string, [number, number]> = {};
const diffs: string[] = [];

/** Runs the batch on both sides, records agreement per label, and returns Python's answers (inputs for the next step). */
async function both(reqs: Req[]): Promise<Res[]> {
  const py = await onPython(reqs);
  const ts = await pool(reqs, 8, onNext);
  reqs.forEach((r, i) => {
    const same = py[i].status === ts[i].status &&
      (py[i].status === 422 || JSON.stringify(norm(py[i].body)) === JSON.stringify(norm(ts[i].body)));
    const t = (tally[r.label] ??= [0, 0]);
    t[1]++;
    if (same) t[0]++;
    else if (diffs.length < 15) {
      diffs.push(`${r.label} ${r.method} ${r.url}: python ${py[i].status} ${JSON.stringify(norm(py[i].body)).slice(0, 600)}\n` +
        `   next ${ts[i].status} ${JSON.stringify(norm(ts[i].body)).slice(0, 600)}`);
    }
  });
  return py;
}

function report(labels: string[]) {
  for (const l of labels) if (tally[l]) console.log(`${l}: ${tally[l][0]}/${tally[l][1]} identical`);
  if (diffs.length) console.log(diffs.join("\n"));
  for (const l of labels) if (tally[l]) expect(tally[l][0], l).toBe(tally[l][1]);
}

const get = (label: string, url: string, headers?: Record<string, string>): Req => ({ label, method: "GET", url, headers });
const post = (label: string, url: string, body: unknown, headers?: Record<string, string>): Req => ({ label, method: "POST", url, body, headers });
const enc = encodeURIComponent;

// ---------------------------------------------------------------- the contract

describe("API contract with the FastAPI app", () => {
  test("public API, status, home, docs", async () => {
    const hs = ["640391", "610910", "090931", "100630", "030617", "741980", "732393", "300490", "851713", "420221", "630260", "940360"];
    const reqs: Req[] = [get("status", "/api/status"), get("home", "/api/home"), get("home", "/home-data.json"),
      get("openapi", "/openapi.json")];
    for (const iso of COUNTRIES) {
      reqs.push(get("country", `/api/public/country/${iso}`), get("country", `/api/public/country/${iso.toLowerCase()}`));
      for (const h of hs) reqs.push(get("duty", `/api/public/duty?hs6=${h}&country=${iso}`));
    }
    for (const h of PRODUCTS) reqs.push(get("product", `/api/public/product/${h}`));
    for (const q of ["leather chelsea boots", "cotton t-shirts", "basmati rice", "frozen shrimp", "cumin seeds", "cotton bath towels",
      "brass diya", "handmade wool carpet", "steel kitchen utensils", "wooden furniture sheesham", "leather wallet for men",
      "ladies leather handbag", "turmeric powder", "hex bolts of steel", "granite slabs polished", "solar panels", "",
      "चमड़े के जूते", "x".repeat(300)]) reqs.push(get("classify", `/api/public/classify?q=${enc(q)}`));
    for (const [q, iso] of [["import vat", "DEU"], ["certificate of origin", "GBR"], ["rules of origin footwear", "GBR"],
      ["proof of origin", "ARE"], ["tariff elimination", "AUS"], ["cumulation", "JPN"], ["documents for shoes", ""], ["vat", "XXX"]]) {
      reqs.push(get("ask", `/api/ask?q=${enc(q)}` + (iso ? `&country=${iso}` : "")));
    }
    reqs.push(get("errors", "/api/public/duty?hs6=64039&country=GBR"), get("errors", "/api/public/duty?hs6=6403a1&country=GBR"),
      get("errors", "/api/public/duty?hs6=640391"), get("errors", "/api/public/duty?hs6=640391&country=ZZZ"),
      get("errors", "/api/public/country/XYZ"), get("errors", "/api/public/product/000000"), get("errors", "/api/public/product/__proto__"),
      get("errors", "/api/public/classify"), get("errors", `/api/public/classify?q=${"x".repeat(301)}`),
      get("errors", "/api/ask"), get("errors", `/api/ask?q=${"x".repeat(301)}&country=GBR`));
    await both(reqs);
    report(["status", "home", "openapi", "country", "duty", "product", "classify", "ask", "errors"]);
  }, 600_000);

  test("MCP server", async () => {
    const rpc = (id: unknown, method: string, params?: Json) => post("mcp", "/mcp", { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const call = (name: string, args: Json) => rpc(2, "tools/call", { name, arguments: args });
    await both([
      rpc(1, "initialize", { protocolVersion: "2025-06-18" }), rpc(1, "initialize", {}), rpc("a", "ping"), rpc(3, "tools/list"),
      call("lookup_duty", { hs6: "640391", country: "USA" }), call("lookup_duty", { hs6: "6403", country: "GBR" }),
      call("lookup_duty", { hs6: "090931", country: "are" }), call("best_markets", { hs6: "090931" }),
      call("best_markets", { hs6: "999999" }), call("country_rules", { country: "ARE" }), call("country_rules", { country: "XX" }),
      call("classify_product", { description: "cotton bed sheets" }), call("classify_product", { description: "y".repeat(301) }),
      call("nope", {}), rpc(4, "resources/list"),
      post("mcp", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }), post("mcp", "/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" }]),
      get("mcp", "/.well-known/mcp.json"),
    ]);
    report(["mcp"]);
  }, 300_000);

  test("workspace: read, check, plan, change country, quote, buyer", async () => {
    const texts: [string, string][] = JSON.parse(fs.readFileSync(path.join(FIX, "texts.json"), "utf8"));
    const notes = texts.filter(([s]) => s === "typed note").map(([, t]) => t);
    const file = (n: string): [string, string, Buffer] => ["files", n, fs.readFileSync(path.join(FIX, n))];
    const read = (form: Json, files: [string, string, Buffer][] = []): Req => ({ label: "read", method: "POST", url: "/api/read", files, form });
    const big = (n: string, size: number): [string, string, Buffer] => ["files", n, Buffer.alloc(size, "a")];

    const reads: Req[] = notes.map((t) => read({ text: t }));
    reads.push(read({}, [file("invoice_uae.pdf")]), read({}, [file("invoice_photo.png")]), read({}, [file("gst_certificate.png")]),
      read({}, [file("price_list.xlsx")]), read({}, [file("plain.csv"), file("invoice.txt")]),
      read({ text: notes[0], profile: JSON.stringify({ company: { city: "Agra", gstin: "09AAACA1234A1Z5" }, products: [{ name: "Old item" }] }) }, [file("price_list_varied.xlsx")]),
      read({ text: notes[1], profile: "not json" }));
    const readErrors: Req[] = [read({}), read({ text: "   " }), read({ text: "x".repeat(5001) }), read({}, [["files", "virus.exe", Buffer.from("MZ")]]),
      read({}, Array.from({ length: 11 }, (_, i) => ["files", `n${i}.txt`, Buffer.from("cumin ₹200 per kg")] as [string, string, Buffer])),
      read({}, [big("huge.txt", 4_000_001)]), read({}, [big("a.txt", 2_100_000), big("b.txt", 2_100_000)]),
      { label: "read", method: "POST", url: "/api/read", body: { text: "json, not a form" } }];
    const readRes = await both([...reads, ...readErrors]);
    const profiles = readRes.slice(0, reads.length).filter((r) => r.status === 200).map((r) => (r.body as Json).profile as Json);

    const check = profiles.map((p) => post("check", "/api/check", p));
    check.push(post("check", "/api/check", {}), post("check", "/api/check", { company: { gstin: "27AAPFU0939F1ZV" }, products: [{ name: "x", id: "keep" }, { name: "y" }], checks: { stale: true } }),
      post("check", "/api/check", [1, 2]), { label: "check", method: "POST", url: "/api/check", raw: "{not json" });
    await both(check);

    const withProducts = profiles.filter((p) => p.products?.length);
    const plans: Req[] = withProducts.map((p) => post("plan", "/api/plan", { profile: p }));
    plans.push(post("plan", "/api/plan", { profile: withProducts[0], country: "ARE" }), post("plan", "/api/plan", { profile: withProducts[1], family: "99" }),
      post("plan", "/api/plan", { profile: { products: [] } }), post("plan", "/api/plan", {}), post("plan", "/api/plan", { profile: withProducts[0], country: 5 }));
    const planRes = await both(plans);
    const good = planRes.map((r, i) => ({ r, req: plans[i] })).filter(({ r }) => r.status === 200);
    const profileOf = (req: Req) => (req.body as Json).profile as Json;

    // a second family where the profile has one, and other destinations for every plan
    const follow: Req[] = [];
    for (const { r, req } of good) {
      const plan = r.body as Json;
      if (plan.families.length > 1) follow.push(post("plan", "/api/plan", { profile: profileOf(req), family: plan.families[1].code }));
      for (const c of ["USA", "DEU", "AUS"]) follow.push(post("country", "/api/plan/country", { profile: profileOf(req), plan, country: c }));
    }
    follow.push(post("country", "/api/plan/country", { profile: profileOf(good[0].req) }));
    await both(follow);

    const quotes: Req[] = [], buyers: Req[] = [];
    for (const { r, req } of good) {
      const plan = r.body as Json, profile = profileOf(req);
      for (const pid of Object.keys(plan.quotes)) {
        const q = (extra: Json) => post("quote", "/api/plan/quote", { profile, plan, product_id: pid, ...extra });
        quotes.push(q({}), q({ qty: 250 }), q({ qty: "1200", overrides: { sea_freight_usd: "900", margin_pct: 22, inr_per_usd: "", insurance_pct: null } }),
          q({ overrides: { sea_freight_usd: "lots" } }), q({ qty: 2.5 }));
      }
      quotes.push(post("quote", "/api/plan/quote", { profile, plan, product_id: "nope" }));
      for (const b of (plan.buyers.buyers ?? []).slice(1, 3)) buyers.push(post("buyer", "/api/plan/buyer", { profile, plan, trader_id: b.trader_id }));
      buyers.push(post("buyer", "/api/plan/buyer", { profile, plan, trader_id: 0 }));
    }
    await both([...quotes, ...buyers]);
    report(["read", "check", "plan", "country", "quote", "buyer"]);
  }, 900_000);

  test("leads, reviews and operator tools, with their webhook deliveries", async () => {
    const lead = (b: Json) => post("lead", "/api/lead", b);
    const op = { "x-operator-token": TOKEN };
    hooks.length = 0;
    await both([
      lead({ name: "Asha Verma", phone: "+91 98250 12345", product: "cumin seeds", country: "ARE", message: "Need CoO help", step: "documents", page: "/app" }),
      lead({ name: "  Ravi ", email: "ravi@example.in", whatsapp_ok: "no", source: "contact" }),
      lead({ name: "Devanagari digits", phone: "९८२५०१२३४५" }), lead({ name: "Long", phone: "9825012345", message: "m".repeat(1500), city: "Kanpur" }),
      lead({ name: "A", phone: "9825012345" }), lead({ name: "No contact" }), lead({ name: "Bad email", email: "ravi@example" }),
      lead({ name: "Bad email 2", phone: "9825012345", email: "not an email" }), lead({ name: "Bot", phone: "1", website: "spam.example" }),
      lead({ phone: "9825012345" }), lead({ name: 5, phone: "9825012345" }), lead({ name: "Flag", phone: "9825012345", whatsapp_ok: "maybe" }),
      get("operator", "/api/verify", op), get("operator", "/api/verify"), get("operator", "/api/verify", { "x-operator-token": "wrong" }),
      get("operator", "/api/reviews", op), get("operator", "/api/reviews"),
      post("operator", "/api/review", { feature: "classify", item_key: "640391", verdict: "correct", input: { name: "boots" }, output: "640391", plan_id: 7 }, op),
      post("operator", "/api/review", { feature: "quote", item_key: "p1", verdict: "maybe" }, op),
      post("operator", "/api/review", { feature: "quote", item_key: "p1", verdict: "wrong" }),
      post("operator", "/api/review", { item_key: "p1", verdict: "wrong" }, op),
    ]);
    const side = (s: string) => hooks.filter((h) => h.path.startsWith(`/${s}/`)).map((h) => JSON.stringify(norm(h)).replace(`/${s}/`, "/"));
    const py = side("py"), ts = side("ts");
    console.log(`webhook deliveries: ${py.length} from Python, ${ts.length} from Next`);
    expect(py.length).toBeGreaterThan(0);
    expect(ts.sort()).toEqual(py.sort());
    report(["lead", "operator"]);
  }, 300_000);
});
