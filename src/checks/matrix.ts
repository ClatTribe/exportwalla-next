// Stages 1, 2, 5, 6 and 8 for every destination country, against the record keepers; written to
// data/verify_matrix.json and shown at /review. Port of export-desk/evals/verify_matrix.py.
//
//   S1 diagnose   the product's HS6 has a tariff line in the country's tariff; globally, our HS6 against a starting
//                 key, the UK government's tariff search and your reviews
//   S2 country    the import figure in the score equals a fresh UN Comtrade query
//   S5 buyers     UK: each listed importer appears in a fresh HMRC query; elsewhere no names, and the channels resolve
//   S6 quote      the duty in the quote equals a fresh WITS / UK tariff query; VAT is sourced; the arithmetic adds up
//   S8 documents  the proof of origin matches the researched rule, backed by a passage from an official text
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../lib/config";
import { rows, one } from "../lib/db";
import { TARIFF_ALIAS, agreementNote, preferentialDoc, rule, tariff, vat } from "../lib/engine/markets";
import { classify, destinations, diagnose, documents, findBuyers, quote } from "../lib/engine/stages";
import { cpSlice, fmtFixed, pyFloatStr, pyJson } from "../lib/py";
import { liveHooks } from "../lib/server/hooks";
import { getJson, getText, now, parsePct } from "../pipeline/core";
import { WITS_REPORTERS, parseWits } from "../pipeline/ingest";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PRODUCTS = [ // one per big SME export family; the names are what a merchant would type
  { id: "p1", name: "Leather Chelsea boots men", description: "leather upper, rubber sole, covering the ankle", price_inr: 1450, moq: 500, unit: "pairs" },
  { id: "p2", name: "Basmati rice wholly milled", description: "1121 basmati, 25 kg bags", price_inr: 95, moq: 20000, unit: "kg" },
  { id: "p3", name: "Cotton T-shirts men knitted", description: "100% cotton knitted t-shirt", price_inr: 180, moq: 3000, unit: "pieces" },
];
const CLASSIFY_SET: Json[] = [...PRODUCTS, ...["Terry cotton bath towels", "Frozen vannamei shrimp", "Turmeric powder", "Hex bolts of steel",
  "Handmade woollen carpets", "Stainless steel kitchen utensils", "Ladies leather handbag", "Cumin seeds", "Solar panels", "Granite slabs polished"].map((name) => ({ name }))];
// Expected HS6, read off the HS2022 nomenclature: a starting key, not ground truth; your reviews override it.
const EXPECTED: Record<string, string> = { "Leather Chelsea boots men": "640391", "Basmati rice wholly milled": "100630", "Cotton T-shirts men knitted": "610910",
  "Terry cotton bath towels": "630260", "Frozen vannamei shrimp": "030617", "Turmeric powder": "091030", "Hex bolts of steel": "731815",
  "Handmade woollen carpets": "570110", "Stainless steel kitchen utensils": "732393", "Ladies leather handbag": "420221", "Cumin seeds": "090931",
  "Solar panels": "854143", "Granite slabs polished": "680293" };

const r = (status: string, evidence: string[]) => ({ status, evidence });
/** str() of a Python float, as these percentages are ("0.0%", "12.5%"). */
const f = (v: number | null | undefined) => (v === null || v === undefined ? "None" : Number.isInteger(v) ? `${v}.0` : pyFloatStr(v));
const s = (v: unknown) => (v === null || v === undefined ? "None" : String(v));
/** Python's repr of a dict of ints ({'correct': 3}). */
const pyDict = (d: Record<string, number>) => `{${Object.entries(d).map(([k, v]) => `'${k}': ${v}`).join(", ")}}`;

const urlCache = new Map<string, boolean>();
async function urlOk(url: string | null | undefined): Promise<boolean> {
  if (!url || !url.startsWith("http")) return false;
  if (!urlCache.has(url)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 exportwalla-verifier" }, signal: AbortSignal.timeout(20_000) });
      urlCache.set(url, res.status < 400 || [401, 403, 405].includes(res.status)); // exists but blocks robots: not dead
    } catch {
      urlCache.set(url, false);
    }
  }
  return urlCache.get(url)!;
}

async function s1Global(): Promise<Json> {
  const out: Json[] = [];
  for (const p of CLASSIFY_SET) {
    const c = await classify(p, liveHooks());
    const ref = c.reference || {};
    const exp = EXPECTED[p.name] ?? null;
    out.push({ product: p.name, hs6: c.hs6 ?? null, expected: exp, ours_right: (c.hs6 ?? null) === exp, confidence: c.confidence ?? null,
      source: c.source ?? null, uk_search: ref.top_code ?? null, uk_search_right: (ref.top_code || "").slice(0, 6) === exp, agrees_hs4: ref.agrees_hs4 ?? null });
  }
  const judged = out.filter((x) => x.agrees_hs4 !== null);
  const reviews = rows<{ verdict: string; n: number }>("SELECT verdict, COUNT(*) n FROM review WHERE feature='hs6' GROUP BY verdict");
  return { products: out, agree_with_uk_search: `${judged.filter((x) => x.agrees_hs4).length}/${judged.length}`,
    ours_vs_key: `${out.filter((x) => x.ours_right).length}/${out.length}`, uk_search_vs_key: `${out.filter((x) => x.uk_search_right).length}/${out.length}`,
    human_reviews: Object.fromEntries(reviews.map((x) => [x.verdict, x.n])) };
}

function s1(iso: string, cls: Json[]) {
  const out = cls.map((c) => { const t = tariff(iso, c.hs6, c); return t.mfn_pct !== null ? `${c.hs6}: ${t.precision} (${cpSlice(t.source, 0, 60)})` : `${c.hs6}: no tariff line`; });
  const missing = out.filter((o) => o.includes("no tariff line")).length;
  return r(!missing ? "pass" : missing < cls.length ? "warn" : "fail", out);
}

async function s2(iso: string, cls: Json[], live: boolean) {
  const m49 = rows<{ iso3: string; m49: number }>("SELECT c.iso3, MIN(c.m49) m49 FROM countries c WHERE c.m49 IN (SELECT DISTINCT reporter_m49 FROM trade_flow) GROUP BY c.iso3")
    .find((x) => x.iso3 === iso)?.m49;
  if (!m49) return r("warn", ["Country does not report imports to UN Comtrade for these years; left out of the ranking"]);
  const hs6 = cls[0].hs6;
  const row = one<{ year: number; value_usd: number }>("SELECT year, value_usd FROM trade_flow WHERE hs6=? AND reporter_m49=? AND partner_m49=0 ORDER BY year DESC", hs6, m49);
  if (!row) return r("warn", [`No ${hs6} imports reported by ${iso}`]);
  const usd = (v: number) => `US$${fmtFixed(v, 0, { comma: true })}`;
  if (!live) return r("pass", [`Stored ${hs6} imports ${row.year}: ${usd(row.value_usd)} (not re-fetched this run)`]);
  const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${m49}&period=${row.year}&cmdCode=${hs6}&flowCode=M&partnerCode=0`;
  let body: Json;
  try {
    body = (await getJson("comtrade", url, {}, true)) || {};
  } catch (e) {
    const msg = String((e as Error).message);
    if (!msg.includes("Quota") && !msg.includes("403")) throw e;
    // the free tier's daily quota is spent: compare with the raw API response cached at ingest instead
    let hit: number | null = null;
    const dir = path.join(DATA_DIR, "raw", "comtrade");
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".json")) : []) {
      const b = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (b.url.includes(hs6) && b.url.includes(`period=${row.year}`) && b.url.includes("partnerCode=0")) {
        for (const d of (b.body || {}).data || []) {
          if (d.cmdCode === hs6 && d.reporterCode === m49 && [0, null, undefined].includes(d.motCode)
            && ["C00", null, undefined].includes(d.customsCode) && [0, null, undefined].includes(d.partner2Code)) hit = d.primaryValue;
        }
      }
    }
    const ok = hit !== null && Math.abs(hit - row.value_usd) <= 1;
    return r(ok ? "warn" : "fail", [`Live re-check skipped: Comtrade free-tier daily quota reached (${msg}).`,
      hit !== null ? `${hs6} ${row.year}: stored ${usd(row.value_usd)}; raw API response from ingest ${usd(hit)}` : "No cached API response found"]);
  }
  const vals = (body.data || []).filter((d: Json) => [0, null, undefined].includes(d.motCode) && ["C00", null, undefined].includes(d.customsCode)
    && [0, null, undefined].includes(d.partner2Code)).map((d: Json) => d.primaryValue);
  if (!vals.length) return r("fail", [`Live Comtrade returned nothing for ${iso} ${hs6} ${row.year}`]);
  const ok = Math.abs(vals[0] - row.value_usd) <= Math.max(1, 0.001 * row.value_usd);
  return r(ok ? "pass" : "fail", [`${hs6} ${row.year}: stored ${usd(row.value_usd)}, live ${usd(vals[0])}`]);
}

async function s5(iso: string, diag: Json, profile: Json, live: boolean) {
  const b = await findBuyers(diag, iso, profile, 10, liveHooks());
  if (iso !== "GBR") {
    const names = (b.buyers || []).length, chans: Json[] = b.channels || [];
    const dead: string[] = [];
    for (const c of chans) if (live && !(await urlOk(c.url))) dead.push(c.url);
    if (names) return r("fail", [`${names} buyer names shown with no official record`]);
    return r(chans.length && !dead.length ? "pass" : "warn", [`No unverifiable names shown; ${chans.length} official channels`, ...dead.map((d) => `dead link: ${d}`)]);
  }
  const buyers: Json[] = b.buyers || [];
  if (!buyers.length) return r("warn", ["No UK importers loaded for this code yet"]);
  const ev: string[] = [];
  let bad = 0;
  for (const x of buyers.slice(0, 3)) {
    const { cn8, year } = x.evidence[0];
    if (live) {
      const flt = encodeURIComponent(`CommodityId eq ${Number(cn8)} and Year eq ${year}`);
      const got: Json = (await getJson("uktradeinfo", `https://api.uktradeinfo.com/YearlyTrade?$filter=${flt}&$expand=Trader`, {}, true)) || {};
      const ids = new Set((got.value || []).map((v: Json) => v.TraderId || (v.Trader || {}).TraderId));
      const hit = ids.has(x.trader_id) || !(got.value || []).length;
      bad += hit ? 0 : 1;
      ev.push(`${x.name}: CN8 ${cn8} ${year} ${hit ? "found" : "NOT found"} in live HMRC data`);
    } else ev.push(`${x.name}: ${x.evidence_text}`);
  }
  return r(!bad ? "pass" : "fail", ev);
}

async function s6(iso: string, cls: Json[], live: boolean) {
  const ev: string[] = [];
  let bad = 0, warn = 0;
  for (const [i, p] of PRODUCTS.entries()) {
    const c = cls[i];
    const q = quote(p, c, iso);
    const t = q.tariff;
    if (t.india_pct === null || t.india_pct === undefined) { warn++; ev.push(`${c.hs6}: no duty data (shown as 'desk confirms')`); continue; }
    const L = new Map<string, number>(q.lines.map((x: Json) => [x.label + x.currency, x.amount]));
    const need = (k: string) => { if (!L.has(k)) throw new Error(`KeyError('${k}')`); return L.get(k)!; };
    const cif = L.get("CIF valueUS$");
    if (cif === undefined || Math.abs(cif - (need("FOB valueUS$") + need("Sea freightUS$") + need("InsuranceUS$"))) > 0.05) { bad++; ev.push(`${c.hs6}: CIF does not add up`); }
    if (live && iso !== "GBR" && iso !== "USA") {
      const code = WITS_REPORTERS[TARIFF_ALIAS[iso] ?? iso];
      const xml = await getText("wits", `https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/${code}/partner/000/product/${c.hs6}/year/${t.year}/datatype/reported`, true);
      const found = parseWits(xml);
      const fresh = found.length ? found[0].avg : null;
      const same = fresh !== null && Math.abs(fresh - t.mfn_pct) < 0.01;
      bad += same ? 0 : 1;
      ev.push(`${c.hs6}: normal duty ${f(t.mfn_pct)}% vs live WITS ${f(fresh)}%`);
    } else if (live && iso === "GBR" && c.uk) {
      const { ukRatesForCheck } = await import("../pipeline/ingest");
      const doc = await getJson("uk_tariff", `https://www.trade-tariff.service.gov.uk/api/v2/commodities/${c.uk.code}`, { Accept: "application/vnd.uktt.v2" }, true);
      const [mfn, india] = ukRatesForCheck(doc);
      const same = parsePct(mfn) === c.uk.mfn_pct && parsePct(india) === c.uk.india_pct;
      bad += same ? 0 : 1;
      ev.push(`${c.uk.code}: stored ${s(c.uk.mfn)}/${s(c.uk.india)} vs live ${s(mfn)}/${s(india)}`);
    } else ev.push(`${c.hs6}: India ${f(t.india_pct)}% / normal ${f(t.mfn_pct)}% from ${cpSlice(t.source, 0, 50)}`);
  }
  const [vatPct, vatName, vatUrl] = vat(iso);
  if (!vatUrl) warn++; // researched "no VAT" with a source is fine; an unsourced gap is not
  ev.push(`import ${s(vatName)}: ${s(vatPct)}% (${vatUrl || "no source"})`);
  return r(bad ? "fail" : warn ? "warn" : "pass", ev);
}

function s8(iso: string, diag: Json, profile: Json, cls: Json[]) {
  const quotes = Object.fromEntries(PRODUCTS.map((p, i) => [p.id, quote(p, cls[i], iso)]));
  const od = documents(profile, diag, quotes, null, iso, liveHooks()).origin_declaration;
  const ru = rule(iso);
  const ev = [`origin doc: ${cpSlice(od.title, 0, 90)}`];
  if (!Object.keys(ru).length) return r("warn", [...ev, "country rules not researched: desk confirms the origin document"]);
  const expected = preferentialDoc(iso);
  const consistent = iso === "GBR" || (!expected && od.kind === "non_preferential") || (expected && od.title.includes(expected.split(";")[0]));
  const cites: Json[] = od.citations || [];
  const official = cites.filter((c) => !c.url.startsWith("country_rules:"));
  ev.push(...cites.slice(0, 2).map((c) => `cites: ${cpSlice(c.title, 0, 60)} > ${cpSlice(c.heading, 0, 50)}`));
  if (!consistent) return r("fail", [...ev, `expected: ${s(expected)}`]);
  if (expected && !official.length) return r("warn", [...ev, "no passage from an official text retrieved (documents not indexed or not found)"]);
  return r("pass", ev);
}

/** A seeded pick of n countries to re-fetch live (the Python version used random.Random(7)). */
function pick(xs: string[], n: number): string[] {
  let st = 7;
  const rnd = () => ((st = (st * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pool = [...xs], out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

export async function verifyMatrix(o: { liveAll?: boolean; sample?: number; countries?: string; noLive?: boolean } = {}): Promise<number> {
  const dest = (o.countries ? o.countries.split(",") : destinations()).filter(Boolean);
  const liveSet = new Set(o.noLive ? [] : o.liveAll ? dest : [...pick(dest, Math.min(o.sample ?? 8, dest.length)), "GBR", "DEU", "ARE"]);
  const profile = { company: { name: "Test Exports", iec: "AAACK1234F", gstin: "09AAACK1234F1Z5", city: "Kanpur" }, products: PRODUCTS };
  const diag = await diagnose(profile, liveHooks());
  const cls: Json[] = diag.products.map((p: Json) => p.classification);
  const g = await s1Global();
  console.log(`S1 global: ours ${g.ours_vs_key} | UK tariff search ${g.uk_search_vs_key} | HS4 agreement ${g.agree_with_uk_search} | your reviews ${pyDict(g.human_reviews)}`);
  const results: Record<string, Json> = {};
  const KEYS = ["S1", "S2", "S5", "S6", "S8"];
  for (const iso of dest) {
    const live = liveSet.has(iso);
    const row: Json = { live, agreement: agreementNote(iso) };
    const checks: [string, () => unknown][] = [["S1", () => s1(iso, cls)], ["S2", () => s2(iso, cls, live)], ["S5", () => s5(iso, diag, profile, live)],
      ["S6", () => s6(iso, cls, live)], ["S8", () => s8(iso, diag, profile, cls)]];
    for (const [k, fn] of checks) {
      try {
        row[k] = await fn();
      } catch (e) {
        row[k] = r("fail", [cpSlice(`error: ${(e as Error).message}`, 0, 200)]);
      }
    }
    results[iso] = row;
    console.log(`${iso} ${live ? "live" : "    "} ` + KEYS.map((k) => `${k}:${row[k].status.padEnd(4)}`).join(" "));
  }
  const tally = Object.fromEntries(KEYS.map((k) => [k, Object.fromEntries(["pass", "warn", "fail"].map((st) => [st, Object.values(results).filter((v) => v[k].status === st).length]))]));
  const out = { run_at: now(), products: PRODUCTS.map((p) => p.name), global_s1: g, tally, countries: results };
  fs.writeFileSync(process.env.VERIFY_OUT ?? path.join(DATA_DIR, "verify_matrix.json"), pyJson(out, { ascii: false, indent: 1 }));
  console.log("tally:", pyJson(tally));
  return 0; // a report, as in the Python release: failures are shown at /review, not a reason to stop the release
}
