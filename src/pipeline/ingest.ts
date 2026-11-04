// The ingesters: UN Comtrade reference files and trade flows, India's exports, the UK Trade Tariff, the US HTS,
// HMRC's UK importers, World Bank WITS tariffs, and the tariff-tree search index. Ports of export-desk/ingest/*.py
// and scope.py, reading and writing the build database through one connection.
import fs from "node:fs";
import path from "node:path";
import { SCOPE_HS4 } from "../lib/config";
import { W as WORD, pyStrip, uniq } from "../lib/py";
import {
  type Conn, INDIA_COMTRADE_CODE, RAW_DIR, type Row, TRADE_YEARS, UK_TRADER_YEARS, WORLD_COMTRADE_CODE, finishRun, getJson,
  getText, now, parsePct, say, startRun,
} from "./core";

/** Python's int(): digits with an optional sign, surrounding whitespace and "_" separators; anything else throws. */
function pyInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v); // int(4.7) == 4
  if (typeof v === "boolean") return Number(v);
  const s = String(v).trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new Error(`invalid literal for int(): '${v}'`);
  return Number(s.replaceAll("_", ""));
}

/** urllib.parse.quote(s): percent-encode all but letters, digits, "_.-~" and "/". */
const pyQuote = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%2F/g, "/");

// ---------------------------------------------------------------- scope.py

const TOP_PARTNERS = 40, TOP_PRODUCTS = 300;
const EXCLUDED_CHAPTERS = ["27", "88", "89", "93", "26", "97", "99"];
const EU27 = "AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE".split(" ");
const EFTA = ["CHE", "NOR", "ISL", "LIE"], ALWAYS = ["NZL", "MUS"];

export function destinations(conn: Conn): string[] {
  const top = conn.all<{ iso3: string }>(`SELECT c.iso3, c.name, e.value_usd FROM india_export e JOIN countries c ON c.m49=e.partner_m49
      WHERE e.level='TOTAL' AND e.year=2024 AND c.is_group=0 AND c.iso3 NOT LIKE '\\_%' ESCAPE '\\' AND e.partner_m49<>0
      ORDER BY e.value_usd DESC`).slice(0, TOP_PARTNERS).map((r) => r.iso3);
  return uniq([...top, ...EU27, ...EFTA, ...ALWAYS]);
}

export function products(conn: Conn): string[] {
  const hs6 = conn.all<{ hs: string }>(`SELECT hs, value_usd FROM india_export WHERE level='6' AND year=2024 AND partner_m49=0
      AND substr(hs,1,2) NOT IN (${EXCLUDED_CHAPTERS.map(() => "?").join(",")}) ORDER BY value_usd DESC LIMIT ?`, ...EXCLUDED_CHAPTERS, TOP_PRODUCTS).map((r) => r.hs);
  const leather = conn.all<{ code: string }>(`SELECT code FROM hs6 WHERE hs4 IN (${SCOPE_HS4.map(() => "?").join(",")})`, ...SCOPE_HS4).map((r) => r.code);
  return uniq([...hs6, ...leather]);
}

export const hs4s = (conn: Conn) => [...new Set(products(conn).map((h) => h.slice(0, 4)))].sort();

// ---------------------------------------------------------------- reference.py

const HS_URL = "https://comtradeapi.un.org/files/v1/app/reference/HS.json";
const REPORTERS_URL = "https://comtradeapi.un.org/files/v1/app/reference/Reporters.json";
const PARTNERS_URL = "https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json";

export async function reference(conn: Conn, refresh = false): Promise<number> {
  const runId = startRun(conn, "reference");
  let n = 0;
  for (const r of (await getJson("comtrade_ref", HS_URL, {}, refresh)).results as Row[]) {
    const code: string = r.id;
    if (code.length === 6 && /^\d+$/u.test(code)) {
      const desc = r.text.includes(" - ") ? r.text.split(" - ").slice(1).join(" - ") : r.text; // text.split(" - ", 1)[-1]
      conn.run("INSERT OR REPLACE INTO hs6 (code, hs4, description, unit) VALUES (?,?,?,?)", code, code.slice(0, 4), desc, r.standardUnitAbbr ?? null);
      n++;
    }
  }
  for (const url of [REPORTERS_URL, PARTNERS_URL]) {
    for (const r of (await getJson("comtrade_ref", url, {}, refresh)).results as Row[]) {
      let code: number;
      try {
        // dict.get(k, default) falls back only when the key is missing, not when it holds null
        code = pyInt("reporterCode" in r ? r.reporterCode : "PartnerCode" in r ? r.PartnerCode : r.id);
      } catch {
        continue;
      }
      const iso3 = r.reporterCodeIsoAlpha3 || r.PartnerCodeIsoAlpha3 || null;
      const iso2 = r.reporterCodeIsoAlpha2 || r.PartnerCodeIsoAlpha2 || null;
      const name = r.reporterDesc || r.PartnerDesc || r.text || null;
      conn.run("INSERT OR IGNORE INTO countries (m49, iso3, iso2, name, is_group) VALUES (?,?,?,?,?)", code, iso3, iso2, name, r.isGroup ? 1 : 0);
    }
  }
  finishRun(conn, runId, n, "ok", `${n} HS6 codes; scope ${SCOPE_HS4.length} headings`);
  return n;
}

// ---------------------------------------------------------------- uk_tariff.py

const UK_BASE = "https://www.trade-tariff.service.gov.uk/api/v2";
const UK_HEADERS = { Accept: "application/vnd.hmrc.2.0+json" };
const MFN_TYPE = "103", PREF_TYPES = new Set(["142", "145"]), INDIA = "IN";

function ukRates(doc: Row): [string | null, string | null] {
  const inc: Row[] = doc.included ?? [];
  const byKey = new Map(inc.map((i) => [`${i.type}\u0000${i.id}`, i]));
  let mfn: string | null = null, india: string | null = null;
  for (const m of inc.filter((i) => i.type === "measure")) {
    const rel = m.relationships;
    const mtype = (rel.measure_type?.data ?? {}).id ?? null;
    const geo = (rel.geographical_area?.data ?? {}).id ?? null;
    const de = (rel.duty_expression?.data ?? {}).id ?? null;
    const expr = byKey.get(`duty_expression\u0000${de}`)?.attributes ?? {};
    const rate = pyStrip(expr.base || "");
    if (!m.attributes.import) continue;
    if (mtype === MFN_TYPE && (geo === "1011" || geo === null) && mfn === null) mfn = rate;
    if (PREF_TYPES.has(mtype) && geo === INDIA) india = rate;
  }
  return [mfn, india];
}

/** The MFN and India rates in a commodity document (for the release check against the live tariff). */
export const ukRatesForCheck = (doc: Row) => ukRates(doc);

function ukLeaves(heading: Row): [string, string][] {
  const comms: Row[] = (heading.included ?? []).filter((i: Row) => i.type === "commodity").map((i: Row) => i.attributes);
  const bySid = new Map(comms.map((c) => [c.goods_nomenclature_sid, c]));
  const leaves: [string, string][] = [];
  for (const c of comms) {
    if (!c.leaf || c.producline_suffix !== "80") continue;
    const p: string[] = [];
    for (let x: Row | undefined = c; x; x = bySid.get(x.parent_sid)) p.push(x.description_plain || x.description);
    leaves.push([c.goods_nomenclature_item_id, p.reverse().join(" > ")]);
  }
  return leaves;
}

/** Fetch in a small pool, results in input order (Python's ThreadPoolExecutor.map). */
async function poolMap<T, U>(xs: T[], n: number, fn: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const j = i++; out[j] = await fn(xs[j]); } }));
  return out;
}

export async function ukTariff(conn: Conn, refresh = false, hs4List: string[] | null = null, hs6Filter: Set<string> | null = null, workers = 4): Promise<number> {
  const runId = startRun(conn, "uk_tariff");
  let n = 0;
  for (const hs4 of hs4List ?? SCOPE_HS4) {
    const heading = await getJson("uk_tariff", `${UK_BASE}/headings/${hs4}`, UK_HEADERS, refresh);
    if (heading === null) continue;
    const hdesc = heading.data.attributes.description_plain || heading.data.attributes.description;
    let leaves = ukLeaves(heading);
    if (!leaves.length) leaves = [[`${hs4}000000`, ""]];
    if (hs6Filter && hs6Filter.size) leaves = leaves.filter(([c]) => hs6Filter.has(c.slice(0, 6)));
    const docs = await poolMap(leaves, workers, ([code]) => getJson("uk_tariff", `${UK_BASE}/commodities/${code}`, UK_HEADERS, refresh));
    leaves.forEach(([code, p], k) => {
      const doc = docs[k];
      if (doc === null) return;
      const attrs = doc.data.attributes;
      const [mfn, india] = ukRates(doc);
      conn.run(`INSERT OR REPLACE INTO uk_commodity
        (code, hs6, cn8, description, path, mfn_rate, mfn_pct, india_rate, india_pct,
         supplementary_unit, fetched_at, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      code, code.slice(0, 6), code.slice(0, 8), attrs.description_plain || attrs.description, p ? `${hdesc} > ${p}` : hdesc,
      mfn, parsePct(mfn), india, parsePct(india), null, now(), runId);
      n++;
    });
    conn.commit();
    say(`  uk_tariff ${hs4}: ${leaves.length} codes`);
  }
  finishRun(conn, runId, n);
  return n;
}

// ---------------------------------------------------------------- us_hts.py

const HTS_URL = (a: string, b: string) => `https://hts.usitc.gov/reststop/exportList?from=${a}&to=${b}&format=JSON&styles=false`;

export async function usHts(conn: Conn, refresh = false, hs4List: string[] | null = null): Promise<number> {
  const runId = startRun(conn, "us_hts");
  let n = 0;
  for (const hs4 of hs4List ?? SCOPE_HS4) {
    const nxt = String(pyInt(hs4) + 1).padStart(4, "0");
    let lines: Row[] = (await getJson("usitc", HTS_URL(hs4, nxt), {}, refresh)) || [];
    lines = lines.filter((l) => (l.htsno || "").replaceAll(".", "").startsWith(hs4) || !l.htsno);
    const stack: [number, string, string, string][] = [];
    lines.forEach((l, i) => {
      const indent = pyInt(l.indent || 0);
      while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
      const desc = pyStrip(l.description || "").replace(/:+$/, "");
      const general = pyStrip(l.general || ""), special = pyStrip(l.special || "");
      const inhGeneral = general || ([...stack].reverse().find((s) => s[2])?.[2] ?? "");
      const inhSpecial = special || ([...stack].reverse().find((s) => s[3])?.[3] ?? "");
      stack.push([indent, desc, general, special]);
      const htsno = pyStrip(l.htsno || "");
      if (!htsno) return;
      const digits = htsno.replaceAll(".", "");
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      const isLeaf = Number(!next || pyInt(next.indent || 0) <= indent);
      conn.run(`INSERT OR REPLACE INTO us_hts (code, hs6, indent, description, path, general_rate,
        general_pct, special, is_leaf, fetched_at, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      htsno, digits.slice(0, 6), indent, desc, stack.map((s) => s[1]).join(" > "), inhGeneral, parsePct(inhGeneral), inhSpecial, isLeaf, now(), runId);
      n++;
    });
    conn.commit();
    say(`  us_hts ${hs4}: ${lines.length} lines`);
  }
  finishRun(conn, runId, n);
  return n;
}

// ---------------------------------------------------------------- uk_traders.py

const HMRC_BASE = "https://api.uktradeinfo.com/YearlyTrade";

export async function ukTraders(conn: Conn, refresh = false, cn8List: string[] | null = null): Promise<number> {
  const runId = startRun(conn, "uk_traders");
  const cn8s = cn8List ?? conn.all<{ cn8: string }>("SELECT DISTINCT cn8 FROM uk_commodity ORDER BY cn8").map((r) => r.cn8);
  let n = 0;
  for (const cn8 of cn8s) {
    const flt = `CommodityId eq ${pyInt(cn8)} and Year ge ${Math.min(...UK_TRADER_YEARS)}`;
    let url: string | null = `${HMRC_BASE}?$filter=${pyQuote(flt)}&$expand=Trader`;
    while (url) {
      const body: Row | null = await getJson("uktradeinfo", url, {}, refresh);
      if (!body) break;
      for (const r of (body.value ?? []) as Row[]) {
        if (!pyStrip(r.ImportMonths || "")) continue; // exporter only; we want buyers
        const t = r.Trader || {};
        const addr = [1, 2, 3, 4, 5].map((i) => t[`Address${i}`]).filter(Boolean).join(", ");
        conn.run("INSERT OR REPLACE INTO uk_trader (trader_id, name, address, postcode) VALUES (?,?,?,?)",
          r.TraderId, pyStrip(t.CompanyName || ""), addr, t.PostCode ?? null);
        conn.run(`INSERT OR REPLACE INTO uk_trader_commodity (trader_id, cn8, year, import_months,
          export_months, run_id) VALUES (?,?,?,?,?,?)`, r.TraderId, cn8, r.Year, r.ImportMonths ?? null, r.ExportMonths ?? null, runId);
        n++;
      }
      url = body["@odata.nextLink"] ?? null;
    }
    conn.commit();
  }
  say(`  uk_traders: ${cn8s.length} CN8 codes, ${n} importer records`);
  finishRun(conn, runId, n, "ok", `${cn8s.length} CN8 codes`);
  return n;
}

// ---------------------------------------------------------------- comtrade.py

const COMTRADE_URL = (year: number, codes: string[], partner: number, reporters?: number[]) =>
  `https://comtradeapi.un.org/public/v1/preview/C/A/HS?period=${year}&cmdCode=${codes.join(",")}&flowCode=M&partnerCode=${partner}`
  + (reporters ? `&reporterCode=${reporters.join(",")}` : "");
const PREVIEW_CAP = 500;

async function comtradeFetch(year: number, codes: string[], partner: number, refresh: boolean, reporters?: number[]): Promise<Row[]> {
  const body = await getJson("comtrade", COMTRADE_URL(year, codes, partner, reporters?.length ? reporters : undefined), {}, refresh);
  const data: Row[] = (body ?? {}).data || [];
  if (data.length >= PREVIEW_CAP && codes.length > 1) { // truncated: split the batch
    const mid = Math.floor(codes.length / 2);
    return [...await comtradeFetch(year, codes.slice(0, mid), partner, refresh, reporters), ...await comtradeFetch(year, codes.slice(mid), partner, refresh, reporters)];
  }
  return data;
}

const isNone0 = (v: unknown) => v === 0 || v === null || v === undefined;

function comtradeStore(conn: Conn, rows: Row[], partner: number, runId: number): number {
  let n = 0;
  for (const r of rows) {
    if (!isNone0(r.motCode) || !(r.customsCode === "C00" || r.customsCode === null || r.customsCode === undefined)) continue;
    if (!isNone0(r.partner2Code)) continue;
    conn.run(`INSERT OR REPLACE INTO ${conn.table("trade_flow")} (year, hs6, reporter_m49, partner_m49, flow,
      value_usd, qty, qty_unit, run_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    typeof r.period === "number" && Number.isInteger(r.period) ? r.period : pyInt(r.period), r.cmdCode, r.reporterCode, partner, "M",
    r.primaryValue ?? null, r.qty ?? null, r.qtyUnitAbbr ?? null, runId);
    n++;
  }
  return n;
}

export async function comtrade(conn: Conn, refresh = false, hs4List: string[] | null = null): Promise<number> {
  const runId = startRun(conn, "comtrade");
  const scope = hs4List ?? SCOPE_HS4;
  const codes = conn.all<{ code: string }>(`SELECT code FROM hs6 WHERE hs4 IN (${scope.map(() => "?").join(",")}) ORDER BY code`, ...scope).map((r) => r.code);
  let n = 0;
  for (const year of TRADE_YEARS) {
    for (const [partner, batch] of [[WORLD_COMTRADE_CODE, 3], [INDIA_COMTRADE_CODE, 5]]) {
      for (let i = 0; i < codes.length; i += batch) {
        n += comtradeStore(conn, await comtradeFetch(year, codes.slice(i, i + batch), partner, refresh), partner, runId);
        conn.commit();
      }
      say(`  comtrade ${year} partner=${partner}: done (${n} rows so far)`);
    }
  }
  finishRun(conn, runId, n, "ok", `${codes.length} HS6 codes x ${TRADE_YEARS.length} years`);
  return n;
}

/** Comtrade reporter m49 for each ISO3 (USA reports as 842, France 251, Switzerland 757...). */
export function reporterCodes(conn: Conn, iso3s: string[]): number[] {
  const ref = new Map(conn.all<{ iso3: string; m49: number }>(
    "SELECT iso3, MIN(m49) m49 FROM countries WHERE is_group=0 AND m49 IN (SELECT DISTINCT reporter_m49 FROM trade_flow) GROUP BY iso3").map((r) => [r.iso3, r.m49]));
  const out: number[] = [];
  for (const iso of iso3s) {
    const m = ref.get(iso) || conn.get<{ m: number | null }>("SELECT MIN(m49) m FROM countries WHERE iso3=? AND is_group=0", iso)?.m;
    if (m) out.push(m);
  }
  return out;
}

/** Imports of the scope products into the destination countries only: from the world and from India. */
export async function comtradeScope(conn: Conn, hs6Codes: string[], iso3s: string[], refresh = false): Promise<number> {
  const runId = startRun(conn, "comtrade_scope");
  const reps = reporterCodes(conn, iso3s);
  const have = new Set(conn.all<{ hs6: string; year: number }>("SELECT DISTINCT hs6, year FROM trade_flow WHERE partner_m49=0").map((r) => `${r.hs6}|${r.year}`));
  let n = 0;
  const perCall = Math.max(1, Math.floor(PREVIEW_CAP / reps.length) - 1);
  for (const year of TRADE_YEARS) {
    const todo = hs6Codes.filter((h) => !have.has(`${h}|${year}`));
    for (const partner of [WORLD_COMTRADE_CODE, INDIA_COMTRADE_CODE]) {
      for (let i = 0; i < todo.length; i += perCall) {
        n += comtradeStore(conn, await comtradeFetch(year, todo.slice(i, i + perCall), partner, refresh, reps), partner, runId);
        conn.commit();
      }
      say(`  comtrade_scope ${year} partner=${partner}: ${todo.length} HS6 (${n} rows so far)`);
    }
  }
  finishRun(conn, runId, n, "ok", `${hs6Codes.length} HS6 x ${reps.length} reporters`);
  return n;
}

// ---------------------------------------------------------------- india_exports.py

const IND_URL = (y: number, c: string) => `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${INDIA_COMTRADE_CODE}&period=${y}&cmdCode=${c}&flowCode=X`;
const clean = (rows: Row[] | null | undefined) => (rows || []).filter((r) => isNone0(r.motCode)
  && (r.customsCode === "C00" || r.customsCode === null || r.customsCode === undefined) && isNone0(r.partner2Code));

function putExports(conn: Conn, rows: Row[], level: string, runId: number): number {
  for (const r of rows) {
    conn.run(`INSERT OR REPLACE INTO india_export (year, partner_m49, hs, level, value_usd, run_id)
      VALUES (?,?,?,?,?,?)`, pyInt(r.period), r.partnerCode, r.cmdCode, level, r.primaryValue ?? null, runId);
  }
  return rows.length;
}

async function hs6Batch(conn: Conn, year: number, codes: string[], refresh: boolean, runId: number): Promise<number> {
  const body = await getJson("comtrade", IND_URL(year, codes.join(",")) + "&partnerCode=0", {}, refresh);
  const data = clean((body ?? {}).data);
  if (((body ?? {}).data || []).length >= PREVIEW_CAP && codes.length > 1) {
    const mid = Math.floor(codes.length / 2);
    return (await hs6Batch(conn, year, codes.slice(0, mid), refresh, runId)) + (await hs6Batch(conn, year, codes.slice(mid), refresh, runId));
  }
  return putExports(conn, data, "6", runId);
}

export async function indiaExports(conn: Conn, refresh = false, topChapters = 40): Promise<number> {
  const runId = startRun(conn, "india_exports");
  let n = 0;
  for (const year of [2024, 2023]) n += putExports(conn, clean((await getJson("comtrade", IND_URL(year, "TOTAL"), {}, refresh)).data), "TOTAL", runId);
  n += putExports(conn, clean((await getJson("comtrade", IND_URL(2024, "AG2") + "&partnerCode=0", {}, refresh)).data), "2", runId);
  conn.commit();
  const chapters = conn.all<{ hs: string }>("SELECT hs FROM india_export WHERE level='2' AND year=2024 AND partner_m49=0 ORDER BY value_usd DESC LIMIT ?", topChapters).map((r) => r.hs);
  for (const ch of chapters) {
    const codes = conn.all<{ code: string }>("SELECT code FROM hs6 WHERE code LIKE ? ORDER BY code", ch + "%").map((r) => r.code);
    for (let i = 0; i < codes.length; i += 120) {
      n += await hs6Batch(conn, 2024, codes.slice(i, i + 120), refresh, runId);
      conn.commit();
    }
    conn.commit();
    say(`  india_exports: chapter ${ch} done`);
  }
  finishRun(conn, runId, n, "ok", `partners 2024/2023, chapters, HS6 for top ${topChapters} chapters`);
  return n;
}

// ---------------------------------------------------------------- wits_tariff.py

const WITS_URL = (rep: string, par: string, year: number) =>
  `https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/${rep}/partner/${par}/product/all/year/${year}/datatype/reported`;
const WITS_YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];
export const WITS_REPORTERS: Record<string, string> = {
  USA: "840", ARE: "784", GBR: "826", EUN: "918", CHN: "156", SGP: "702", SAU: "682",
  BGD: "050", HKG: "344", NPL: "524", ZAF: "710", MYS: "458", AUS: "036", IDN: "360",
  JPN: "392", KOR: "410", TUR: "792", BRA: "076", VNM: "704", LKA: "144", EGY: "818",
  ISR: "376", MEX: "484", CAN: "124", OMN: "512", QAT: "634", KEN: "404", THA: "764",
  RUS: "643", CHE: "756", NOR: "578", ISL: "352", PHL: "608", KWT: "414", BHR: "048",
  NGA: "566", TGO: "768", BTN: "064", MUS: "480", NZL: "554", TZA: "834", IRQ: "368",
};
const SERIES = /<Series [^>]*PRODUCTCODE="(\p{Nd}{6})"[^>]*><Obs ([^>]*)\/>/gu;
const ATTR = new RegExp(`([${WORD}]+)="([^"]*)"`, "gu");

/** Python's float(): plain decimals, exponents, inf/nan, "_" separators, surrounding whitespace. */
function pyFloatLoose(v: unknown): number {
  const s = String(v).trim().replaceAll("_", "");
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new Error(`could not convert string to float: '${v}'`);
  return Number(s);
}

export function parseWits(xml: string | null): Row[] {
  const out: Row[] = [];
  for (const [, code, attrs] of (xml || "").matchAll(SERIES)) {
    const a: Record<string, string> = {};
    for (const [, k, v] of attrs.matchAll(ATTR)) a[k] = v;
    try {
      if (!("TIME_PERIOD" in a) || !("OBS_VALUE" in a)) continue;
      out.push({ hs6: code, year: pyInt(a.TIME_PERIOD), type: a.TARIFFTYPE ?? null, avg: pyFloatLoose(a.OBS_VALUE),
        min: pyFloatLoose(a.MIN_RATE || 0), max: pyFloatLoose(a.MAX_RATE || 0), lines: pyInt(a.TOTALNOOFLINES || 0),
        pref_lines: pyInt(a.NBR_PREF_LINES || 0), nomen: a.NOMENCODE ?? null });
    } catch {
      continue;
    }
  }
  return out;
}

async function witsLatest(rep: string, partner: string, refresh: boolean): Promise<[number | null, Row[]]> {
  for (const y of WITS_YEARS) {
    let found: Row[];
    try {
      found = parseWits(await getText("wits", WITS_URL(rep, partner, y), refresh));
    } catch (e) { // WITS answers some empty years with 5xx
      say(`    wits ${rep}/${partner}/${y}: ${(e as Error).message}`);
      found = [];
    }
    if (found.length > (partner === "000" ? 500 : 0)) return [y, found];
  }
  return [null, []];
}

export async function witsTariff(conn: Conn, refresh = false, only: Set<string> | null = null): Promise<number> {
  const runId = startRun(conn, "wits_tariff");
  let n = 0;
  for (const [iso3, code] of Object.entries(WITS_REPORTERS)) {
    if (only && !only.has(iso3)) continue;
    for (const partner of ["000", "356"]) {
      const [year, found] = await witsLatest(code, partner, refresh);
      for (const r of found) {
        conn.run(`INSERT OR REPLACE INTO tariff_hs6 (reporter, hs6, partner, year, tariff_type, avg_pct,
          min_pct, max_pct, lines, pref_lines, nomen, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        iso3, r.hs6, partner, r.year, r.type, r.avg, r.min, r.max, r.lines, r.pref_lines, r.nomen, runId);
      }
      n += found.length;
      say(`  wits ${iso3} partner ${partner}: ${found.length} HS6 lines (year ${year})`);
    }
    conn.commit();
  }
  finishRun(conn, runId, n, "ok", `${Object.keys(WITS_REPORTERS).length} reporters, MFN + India preference`);
  return n;
}

// ---------------------------------------------------------------- tree_index.py

let hsRef: Map<string, string> | null = null;

/** HS chapter/heading/subheading names: from the raw Comtrade file when present (build machines), otherwise from the
 * hs_ref table shipped in the reference database. */
export function hsReference(conn?: Conn): Map<string, string> {
  if (hsRef && hsRef.size) return hsRef;
  hsRef = new Map();
  const dir = path.join(RAW_DIR(), "comtrade_ref");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const body = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (body.url.includes("HS.json")) {
        for (const r of body.body.results as Row[]) hsRef.set(r.id, r.text.includes(" - ") ? r.text.split(" - ").slice(1).join(" - ") : r.text);
        return hsRef;
      }
    }
  }
  try {
    for (const r of conn?.all<{ code: string; text: string }>("SELECT code, text FROM hs_ref") ?? []) hsRef.set(r.code, r.text);
  } catch { /* no table */ }
  return hsRef;
}

export function treeIndex(conn: Conn): number {
  const ref = hsReference(conn);
  const current = new Set(conn.all<{ hs6: string }>("SELECT DISTINCT hs6 FROM tariff_hs6 WHERE reporter='EUN'").map((r) => r.hs6));
  conn.run("DELETE FROM tree_fts");
  let n = 0;
  for (const [code, desc] of ref) {
    if (code.length === 6 && /^\d+$/u.test(code) && (!current.size || current.has(code))) {
      const ctx = `Chapter ${code.slice(0, 2)}: ${ref.get(code.slice(0, 2)) ?? ""} > ${code.slice(0, 4)}: ${ref.get(code.slice(0, 4)) ?? ""}`;
      conn.run("INSERT INTO tree_fts (code, context, text) VALUES (?,?,?)", code, ctx, desc);
      n++;
    }
  }
  for (const { code, path: p } of conn.all<{ code: string; path: string }>("SELECT code, path FROM uk_commodity")) {
    const parts = p.split(" > ");
    const ctx = `Chapter ${code.slice(0, 2)}: ${ref.get(code.slice(0, 2)) ?? ""} > ` + parts.slice(0, -1).join(" > ");
    conn.run("INSERT INTO tree_fts (code, context, text) VALUES (?,?,?)", code, ctx, parts[parts.length - 1]);
    n++;
  }
  conn.commit();
  say(`  tree_index: ${n} entries`);
  return n;
}

// ---------------------------------------------------------------- scope_pull.py

export async function scopePull(conn: Conn): Promise<void> {
  const h4 = hs4s(conn), h6 = products(conn), dest = destinations(conn);
  say(`scope: ${h6.length} HS6 in ${h4.length} headings, ${dest.length} destinations`);
  const haveUk = new Set(conn.all<{ h: string }>("SELECT DISTINCT substr(code,1,4) h FROM uk_commodity").map((r) => r.h));
  haveUk.delete("0303");
  const haveUs = new Set(conn.all<{ h: string }>("SELECT DISTINCT substr(hs6,1,4) h FROM us_hts").map((r) => r.h));
  const steps: [string, () => Promise<number> | number][] = [
    ["uk_tariff", () => ukTariff(conn, false, h4.filter((h) => !haveUk.has(h)), new Set(h6))],
    ["us_hts", () => usHts(conn, false, h4.filter((h) => !haveUs.has(h)))],
    ["tree_index", () => treeIndex(conn)],
    ["comtrade_scope", () => comtradeScope(conn, h6, dest)],
    ["uk_traders", () => {
      const inScope = new Set(conn.all<{ cn8: string }>(`SELECT DISTINCT cn8 FROM uk_commodity WHERE hs6 IN (${h6.map(() => "?").join(",")})`, ...h6).map((r) => r.cn8));
      const done = new Set(conn.all<{ cn8: string }>("SELECT DISTINCT cn8 FROM uk_trader_commodity").map((r) => r.cn8));
      return ukTraders(conn, false, [...inScope].filter((c) => !done.has(c)).sort());
    }],
  ];
  for (const [name, fn] of steps) {
    const t = Date.now();
    say(`[${name}] starting`);
    const n = await fn();
    say(`[${name}] ${n} rows in ${Math.round((Date.now() - t) / 1000)}s`);
  }
}
