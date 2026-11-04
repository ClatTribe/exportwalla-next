// The ingested data against the sources that keep the record, re-fetched live (cache bypassed): UK duty vs the UK
// Trade Tariff, US duty vs USITC, UK importers vs HMRC, and the code structure (every UK and US code maps to a known
// HS6). Reads the build database. Port of export-desk/evals/check_data.py.
import { SCOPE_HS4 } from "../lib/config";
import { Conn, FULL_DB, getJson } from "../pipeline/core";
import { ukRatesForCheck } from "../pipeline/ingest";

const UK_BASE = "https://www.trade-tariff.service.gov.uk/api/v2";
const UK_HEADERS = { Accept: "application/vnd.hmrc.2.0+json" };
const pyQuote = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%2F/g, "/");
const str = (v: unknown) => (v === null || v === undefined ? "None" : String(v));

async function ukDuty(conn: Conn, n: number): Promise<[number, string[]]> {
  const sample = conn.all<{ code: string; mfn_rate: string | null; india_rate: string | null }>("SELECT code, mfn_rate, india_rate FROM uk_commodity ORDER BY RANDOM() LIMIT ?", n);
  const bad: string[] = [];
  for (const r of sample) {
    const doc = await getJson("uk_tariff", `${UK_BASE}/commodities/${r.code}`, UK_HEADERS, true);
    const [mfn, india] = doc ? ukRatesForCheck(doc) : [null, null];
    if (mfn !== r.mfn_rate || india !== r.india_rate) bad.push(`${r.code}: stored ${str(r.mfn_rate)}/${str(r.india_rate)} live ${str(mfn)}/${str(india)}`);
  }
  return [sample.length, bad];
}

async function usDuty(conn: Conn, n: number): Promise<[number, string[]]> {
  const sample = conn.all<{ code: string; general_rate: string }>("SELECT code, general_rate FROM us_hts WHERE is_leaf=1 ORDER BY RANDOM() LIMIT ?", n);
  const bad: string[] = [];
  for (const r of sample) {
    const lines = (await getJson("usitc", `https://hts.usitc.gov/reststop/search?keyword=${r.code}`, {}, true)) || [];
    const exact = lines.filter((l: { htsno?: string }) => (l.htsno || "").trim() === r.code);
    if (!exact.length) { bad.push(`${r.code}: not found live`); continue; }
    const live = (exact[0].general || "").trim();
    if (live && live !== r.general_rate) bad.push(`${r.code}: stored ${r.general_rate} live ${live}`);
  }
  return [sample.length, bad];
}

async function ukBuyers(conn: Conn, n: number): Promise<[number, string[]]> {
  const sample = conn.all<{ trader_id: number; cn8: string; year: number; name: string }>(`SELECT tc.trader_id, tc.cn8, tc.year, t.name FROM uk_trader_commodity tc
    JOIN uk_trader t USING (trader_id) ORDER BY RANDOM() LIMIT ?`, n);
  const bad: string[] = [];
  for (const r of sample) {
    const flt = `TraderId eq ${r.trader_id} and CommodityId eq ${Number(r.cn8)} and Year eq ${r.year}`;
    const body = await getJson("uktradeinfo", `https://api.uktradeinfo.com/YearlyTrade?$filter=${pyQuote(flt)}`, {}, true);
    if (!((body ?? {}).value ?? []).some((v: { ImportMonths?: string }) => (v.ImportMonths || "").trim())) bad.push(`${r.name} / ${r.cn8} / ${r.year}: no live import record`);
  }
  return [sample.length, bad];
}

function structure(conn: Conn): [number, string[]] {
  const bad = [...conn.all<{ code: string }>("SELECT code FROM uk_commodity WHERE hs6 NOT IN (SELECT code FROM hs6)").map((r) => `UK ${r.code}: HS6 unknown`),
    ...conn.all<{ code: string }>("SELECT code FROM us_hts WHERE is_leaf=1 AND hs6 NOT IN (SELECT code FROM hs6)").map((r) => `US ${r.code}: HS6 unknown`)];
  const total = conn.get<{ n: number }>("SELECT COUNT(*) n FROM uk_commodity")!.n + conn.get<{ n: number }>("SELECT COUNT(*) n FROM us_hts WHERE is_leaf=1")!.n;
  return [total, bad];
}

/** Comtrade's reference list mixes HS editions; codes absent from today's UK tariff are old ones. */
const obsolete = (conn: Conn) => conn.all<{ code: string }>(`SELECT code FROM hs6 WHERE hs4 IN (${SCOPE_HS4.map(() => "?").join(",")})
  AND code NOT IN (SELECT hs6 FROM uk_commodity) AND code NOT IN (SELECT hs6 FROM us_hts)`, ...SCOPE_HS4).map((r) => r.code);

export async function checkData(n = 20): Promise<number> {
  const conn = new Conn(FULL_DB());
  let failed = 0;
  try {
    for (const [name, fn] of [["UK duty vs live tariff", () => ukDuty(conn, n)], ["US duty vs live HTS", () => usDuty(conn, n)],
      ["UK buyers vs live HMRC", () => ukBuyers(conn, n)], ["Code structure", async () => structure(conn)]] as [string, () => Promise<[number, string[]]>][]) {
      const [checked, bad] = await fn();
      failed += bad.length ? 1 : 0;
      console.log(`${bad.length ? "FAIL" : "PASS"}  ${name}: ${checked - bad.length}/${checked} match`);
      for (const b of bad.slice(0, 10)) console.log(`      ${b}`);
    }
    const old = obsolete(conn);
    if (old.length) {
      console.log(`WARN  ${old.length} HS6 codes in the Comtrade reference are not in today's UK or US tariff `
        + `(older HS editions, ignored): ${old.slice(0, 8).join(", ")}${old.length > 8 ? "…" : ""}`);
    }
  } finally {
    conn.close();
  }
  return failed && process.env.CHECK_DATA_STRICT === "1" ? 1 : 0; // reports, like the Python check: live sources drift
}
