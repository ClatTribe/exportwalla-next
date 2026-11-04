// Workspace and review screens in a real browser (headless Chromium through playwright-core): the same visit runs on
// the Python app (uvicorn) and the built Next app, and what a person sees at each step must match. Each step records
// the visible text of the part of the page that changed (and form values), plus any page error or failed request.
// Both run read-only, without AI and without the live UK tariff search, with in-scope products (no Comtrade fetch).
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BUILD_ENV, startNext } from "./next";

const PY_APP = path.resolve("../export-desk"), FIX = path.resolve("tests/fixtures/intake");
const PY_PORT = 3922, TS_PORT = 3923, TOKEN = "op-test-token";
const ENV = { ...BUILD_ENV, OPERATOR_TOKEN: TOKEN, EXPORTWALLA_TMP: fs.mkdtempSync(path.join(os.tmpdir(), "ew-e2e-")) };

/** Playwright's own Chromium if installed, else a cached headless shell (CHROMIUM_PATH overrides). */
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (!fs.existsSync(cache)) return undefined;
  const shell = fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const exe = shell && path.join(cache, shell, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  return exe && fs.existsSync(exe) ? exe : undefined;
}

let py: ChildProcess | null = null, ts: ChildProcess | null = null, browser: Browser | null = null;

beforeAll(async () => {
  py = spawn(path.join(PY_APP, ".venv/bin/uvicorn"), ["app.main:app", "--port", String(PY_PORT)],
    { cwd: PY_APP, env: { ...process.env, ...ENV }, stdio: "ignore" });
  ts = await startNext(TS_PORT, ENV);
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PY_PORT}/api/status`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch({ executablePath: chromiumPath() });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  py?.kill();
  ts?.kill();
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** One visit through every screen; returns the log of what was visible after each step. */
async function visit(base: string): Promise<string[]> {
  const log: string[] = [], problems: string[] = [];
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("operator_token", t); } catch { /* none */ } }, TOKEN);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const text = async (sel: string) => norm(await page.locator(sel).first().innerText());
  const values = async (sel: string) => (await page.locator(`${sel} input, ${sel} textarea, ${sel} select`).evaluateAll(
    (els) => els.map((el) => `${(el as HTMLInputElement).name || (el as HTMLElement).dataset.k || ""}=${(el as HTMLInputElement).value}`))).join(" | ");
  const waitApi = (p: Page, part: string) => p.waitForResponse((r) => new URL(r.url()).pathname === part, { timeout: 120_000 });
  const step = async (name: string, sel: string) => log.push(`${name}: ${await text(sel)}`);
  const tabs = async (prefix: string) => {
    for (const k of await page.locator(".tab").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tab!))) {
      await page.click(`.tab[data-tab="${k}"]`);
      await step(`${prefix} ${k}`, `#panel-${k}`);
    }
  };

  // 1. typed note -> profile -> plan
  await page.goto(base + "/app", { waitUntil: "networkidle" });
  await step("workspace", "main, body");
  await page.click("#intake details summary"); // the note box is folded under "or type it"
  await page.fill("#typed", "We make men's leather Chelsea boots in Kanpur, cow leather upper, TPR sole, ₹1,450 a pair, 6,000 pairs a month, MOQ 600.\n"
    + "Cumin seeds ₹285 per kg, 12,000 kg a month.\nGSTIN 09AAACA1234A1Z5, IEC AAACA1234A.");
  await Promise.all([waitApi(page, "/api/read"), page.click("#readBtn")]);
  await page.waitForSelector("#profileSec:not([hidden])");
  await step("read", "#readMsg");
  log.push(`profile: ${await values("#profileForm")}`);
  await Promise.all([waitApi(page, "/api/plan"), page.click("#buildBtn")]);
  await page.waitForSelector("#planSec:not([hidden]) .tab");
  await step("families", "#families");
  await tabs("plan");

  // 2. other buyer (UK importers), other product family, other country, re-quote, ask the rules, call back
  await page.click('.tab[data-tab="buyers"]');
  log.push(`buyers listed: ${await page.locator("[data-buyer]").count()}`);
  if (await page.locator("[data-buyer]").count() > 1) {
    await Promise.all([waitApi(page, "/api/plan/buyer"), page.locator("[data-buyer]").nth(1).click()]);
    await page.waitForTimeout(200);
    await step("buyer2", "#panel-buyers");
    await step("buyer2 docs", "#panel-docs");
  }
  if (await page.locator("[data-family]:not(.primary)").count()) {
    await Promise.all([waitApi(page, "/api/plan"), page.locator("[data-family]:not(.primary)").first().click()]);
    await page.waitForSelector("#planSec .tab");
    await tabs("family2");
  }
  await page.click('.tab[data-tab="country"]');
  const choices = page.locator("#panel-country button[data-country]");
  log.push(`country choices: ${await choices.count()}`);
  if (await choices.count()) {
    await Promise.all([waitApi(page, "/api/plan/country"), choices.first().click()]);
    await page.waitForTimeout(200);
    await tabs("country2");
  }
  await page.click('.tab[data-tab="quote"]');
  const card = page.locator("[data-q]").first();
  await card.locator("[data-qty]").fill("750");
  await card.locator('[data-ov="margin_pct"]').fill("22");
  await Promise.all([waitApi(page, "/api/plan/quote"), card.locator("[data-requote]").click()]);
  await page.waitForTimeout(200);
  await step("requote", "#panel-quote");
  await step("requote docs", "#panel-docs");
  await page.click('.tab[data-tab="docs"]');
  await page.fill("#askQ", "How long is the proof of origin valid?");
  await Promise.all([waitApi(page, "/api/ask"), page.click("#askBtn")]);
  await page.waitForTimeout(200);
  await step("ask", "#askOut");
  await page.click('.tab[data-tab="desk"]');
  await page.fill('#leadForm [name="name"]', "Asha Verma");
  await page.fill('#leadForm [name="phone"]', "98250 12345");
  await Promise.all([waitApi(page, "/api/lead"), page.click('#leadForm button[type="submit"]')]);
  await page.waitForTimeout(200);
  await step("call back", "#leadMsg");

  // 3. uploads: too big (stopped in the browser), then real files
  await page.goto(base + "/app", { waitUntil: "networkidle" });
  let sent = false;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/read") sent = true; });
  await page.setInputFiles("#files", [{ name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(2_100_000) },
    { name: "b.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(2_100_000) }]);
  await page.click("#readBtn");
  await step("too big", "#readMsg");
  log.push(`too big sent: ${sent}`);
  // a big phone-style photo: made smaller in the browser (JPEG, long edge 2400 px), then sent and read
  await page.goto(base + "/app", { waitUntil: "networkidle" });
  const photo = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 4000; c.height = 3000;
    const g = c.getContext("2d")!, d = g.createImageData(c.width, c.height);
    let seed = 7;
    for (let i = 0; i < d.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width), n = seed % 24;
      d.data[i] = (x / 16 + n) & 255; d.data[i + 1] = (y / 12 + n) & 255; d.data[i + 2] = ((x + y) / 28 + n) & 255; d.data[i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
    const b: Blob = await new Promise((r) => c.toBlob((x) => r(x!), "image/png"));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  await page.setInputFiles("#files", [{ name: "shop-floor.png", mimeType: "image/png", buffer: photo }]);
  await Promise.all([waitApi(page, "/api/read"), page.click("#readBtn")]);
  await page.waitForSelector("#profileSec:not([hidden])");
  log.push(`big photo: ${(photo.length / 1e6).toFixed(1)} MB png, accepted`); // over 4 MB as chosen: read only because it was made smaller
  await step("big photo read", "#readMsg");
  await page.goto(base + "/app", { waitUntil: "networkidle" });
  await page.setInputFiles("#files", ["invoice_uae.pdf", "price_list.xlsx", "gst_certificate.png"].map((f) => path.join(FIX, f)));
  await Promise.all([waitApi(page, "/api/read"), page.click("#readBtn")]);
  await page.waitForSelector("#profileSec:not([hidden])");
  await step("files read", "#readMsg");
  log.push(`files profile: ${await values("#profileForm")}`);

  // 4. Hinglish workspace, review console, the site-wide "Ask the desk" dialog
  await page.goto(base + "/app?lang=hi", { waitUntil: "networkidle" });
  await step("hinglish", "body");
  await page.goto(base + "/review", { waitUntil: "networkidle" });
  await step("review", "body");
  await page.goto(base + "/export-to/united-kingdom", { waitUntil: "networkidle" });
  await page.locator(".askbox button[data-ask]").first().click();
  await page.waitForSelector("dialog.ask[open]");
  await step("dialog", "dialog.ask");
  await page.fill('dialog.ask [name="name"]', "Ravi");
  await page.fill('dialog.ask [name="phone"]', "9825012345");
  await Promise.all([waitApi(page, "/api/lead"), page.click("dialog.ask button.go")]);
  await page.waitForTimeout(300);
  await step("dialog sent", "dialog.ask");

  log.push(`problems: ${problems.join("; ") || "none"}`);
  await ctx.close();
  return log;
}

test("workspace, review console and contact dialog look the same on both apps", async () => {
  const pyLog = await visit(`http://127.0.0.1:${PY_PORT}`);
  const tsLog = await visit(`http://127.0.0.1:${TS_PORT}`);
  let same = 0;
  const diffs: string[] = [];
  pyLog.forEach((line, i) => {
    if (line === tsLog[i]) same++;
    else if (diffs.length < 6) {
      let j = 0;
      while (j < line.length && line[j] === tsLog[i]?.[j]) j++;
      diffs.push(`step ${i}: python …${line.slice(Math.max(0, j - 100), j + 200)}\n        next   …${(tsLog[i] ?? "<missing>").slice(Math.max(0, j - 100), j + 200)}`);
    }
  });
  console.log(`screens: ${same}/${pyLog.length} steps identical (${tsLog.length} on Next)`);
  console.log(pyLog.map((l) => "  " + l.slice(0, 110)).join("\n"));
  if (diffs.length) console.log(diffs.join("\n"));
  expect(tsLog.length).toBe(pyLog.length);
  expect(diffs).toEqual([]);
  expect(pyLog.at(-1)).toBe("problems: none");
}, 900_000);
