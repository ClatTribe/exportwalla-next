// Trade data on demand, against the Python app: for a product outside the shipped data (HS 843710, seed-cleaning
// machines) the plan fetches Comtrade figures into the overlay before ranking countries. The network is replaced by
// synthetic Comtrade answers; TypeScript fetches and caches them, then Python replays the very cache files TypeScript
// wrote, offline, and must rank the countries identically.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { python } from "./bridge";

const HS6 = "843710";

/** A Comtrade preview answer for the URL: every requested code x reporter, with values derived from the inputs. */
function fakeComtrade(url: string): Response {
  const q = new URL(url).searchParams;
  const codes = (q.get("cmdCode") ?? "").split(","), reps = (q.get("reporterCode") ?? "").split(",").filter(Boolean).map(Number);
  const year = Number(q.get("period")), partner = Number(q.get("partnerCode"));
  const data = codes.flatMap((cmd) => reps.filter((r) => (r + year) % 3 !== 0).map((r) => ({
    period: year, cmdCode: cmd, reporterCode: r, partnerCode: partner, partner2Code: 0, motCode: 0, customsCode: "C00", flowCode: "M",
    primaryValue: ((r * 7919 + year * 31 + (partner ? 11 : 0)) % 9973) * (partner ? 1300.5 : 104729), qty: r * 3, qtyUnitAbbr: "kg",
  })));
  return new Response(JSON.stringify({ elements: data.length, data }), { status: 200, headers: { "content-type": "application/json" } });
}

const saved = { ...process.env };
afterAll(() => { process.env = saved; vi.unstubAllGlobals(); });

test("a product outside the shipped data gets trade figures on demand, as in Python", async () => {
  process.env.EXPORTWALLA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ew-fetch-")); // its own overlay: other files share theirs
  process.env.EXPORTWALLA_READONLY = "1"; // cache under EXPORTWALLA_TMP/raw, as on a deploy
  process.env.COMTRADE_FETCH = "on";
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return fakeComtrade(url); });
  const { PACE } = await import("../src/pipeline/core");
  PACE.comtrade = 0; // no 6-second pacing against a fake
  const { ensureTradeData } = await import("../src/lib/server/tradeData");
  const { chooseCountry } = await import("../src/lib/engine/stages");
  const { pseudoClass } = await import("../src/lib/engine/markets");
  const diag = { products: [{ product_id: "p1", name: "seed cleaner", classification: { ...pseudoClass(HS6), status: "ok", hs6: HS6 } }] };

  expect(chooseCountry(diag).status).toBe("no_trade_data");
  await ensureTradeData(diag);
  const ts = JSON.parse(JSON.stringify(chooseCountry(diag)));
  console.log(`fetched ${calls.length} Comtrade answers; ${ts.status}, ${ts.markets?.length} markets, top ${ts.recommended}`);
  expect(calls.length).toBeGreaterThan(0);
  expect(ts.status).toBe("ok");

  // Python replays the cache files the TypeScript fetch wrote, offline, into its own empty overlay
  const pyTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ew-py-"));
  fs.cpSync(path.join(process.env.EXPORTWALLA_TMP!, "raw"), path.join(pyTmp, "raw"), { recursive: true });
  Object.assign(process.env, { EXPORTWALLA_BRIDGE_TMP: pyTmp, EXPORTWALLA_OFFLINE: "1" });
  const [py] = await python([{ fn: "choose_country_fetch", args: [diag] }]);
  delete process.env.EXPORTWALLA_BRIDGE_TMP;
  if (!py.ok) throw new Error(py.error);
  const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  expect(JSON.stringify(norm(ts))).toBe(JSON.stringify(norm(py.value)));
}, 300_000);
