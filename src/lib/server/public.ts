// Read-only endpoints: app status, the home page's live numbers, the open public API (no key) and rules questions.
// Port of the matching handlers in export-desk/app/main.py.
import { one, rows } from "../db";
import { agreementNote, dealShort, pseudoClass, tariff } from "../engine/markets";
import { answer } from "../engine/rag";
import { classify, destinations, scopeProducts } from "../engine/stages";
import { deskPhone } from "../config";
import { available } from "../llm";
import { NAME_FIX, apiCountry, apiProduct, slug } from "../site";
import { liveHooks } from "./hooks";
import { HttpError, pyLen } from "./http";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const count = (sql: string) => one<{ n: number }>(sql)!.n;

export function status(): Json {
  const counts = Object.fromEntries(["hs6", "uk_commodity", "us_hts", "trade_flow", "uk_trader", "uk_trader_commodity"]
    .map((t) => [t, count(`SELECT COUNT(*) n FROM ${t}`)]));
  const runs = rows("SELECT source, started_at, finished_at, rows, status FROM ingest_runs ORDER BY id DESC LIMIT 12");
  return { ai: available(), counts, runs, desk_phone: deskPhone() };
}

const HOME_NAMES: Record<string, [string, string]> = {
  HKG: ["HK", "Hong Kong"], KOR: ["KR", "South Korea"], USA: ["US", "United States"], TZA: ["TZ", "Tanzania"],
  RUS: ["RU", "Russia"], VNM: ["VN", "Vietnam"], CZE: ["CZ", "Czechia"],
};

/** Live numbers and the country strip for the home page. */
export function home(): Json {
  const dest = destinations();
  const names = new Map<string, [string, string]>();
  for (const r of rows<{ iso3: string; iso2: string; name: string }>("SELECT iso3, iso2, name FROM countries WHERE is_group=0 AND iso2 IS NOT NULL")) {
    if (r.name.includes("...")) continue;
    const had = names.get(r.iso3);
    if (!had || pyLen(r.name) < pyLen(had[1])) names.set(r.iso3, [r.iso2, r.name]);
  }
  for (const [iso, v] of Object.entries(HOME_NAMES)) names.set(iso, v);
  const stats = {
    markets: dest.length, products: scopeProducts().length,
    tariff_rows: count("SELECT COUNT(*) n FROM tariff_hs6") + count("SELECT COUNT(*) n FROM uk_commodity") + count("SELECT COUNT(*) n FROM us_hts"),
    importers: count("SELECT COUNT(*) n FROM uk_trader"),
    trade_rows: count("SELECT COUNT(*) n FROM trade_flow"),
    doc_chunks: count("SELECT COUNT(*) n FROM rag_chunk"),
  };
  const countries = dest.map((iso) => {
    const [iso2, name] = names.get(iso) ?? ["", iso];
    return { iso3: iso, iso2, name, deal: dealShort(iso).endsWith("· in force"), note: agreementNote(iso),
      slug: slug(NAME_FIX[iso] ?? name) };
  });
  return { stats, countries, desk_phone: deskPhone() };
}

/** Duty for Indian goods vs the normal rate, with the source. hs6: 6 digits; country: ISO3 (GBR, ARE, USA...). */
export function publicDuty(hs6: string, country: string): Json {
  if (!(pyLen(hs6) === 6 && /^\p{Nd}+$/u.test(hs6))) throw new HttpError(400, "hs6 must be 6 digits");
  const iso = country.toUpperCase();
  const t = tariff(iso, hs6, pseudoClass(hs6));
  return {
    hs6, country: iso, duty_for_india_pct: t.india_pct, normal_duty_pct: t.mfn_pct, basis: t.basis,
    precision: t.precision, source: t.source, source_url: t.source_url, note: t.note, trade_deal: dealShort(iso),
    additional_duty: t.extra ? { name: "US Section 301 (goods of India)", pct: t.extra.add_pct, status: t.extra.status,
      included_in_duty_for_india: true } : null,
  };
}

export function publicCountry(iso3: string): Json {
  const r = apiCountry(iso3);
  if (!r) throw new HttpError(404, "country not covered");
  return r;
}

export function publicProduct(hs6: string): Json {
  const r = apiProduct(hs6);
  if (!r) throw new HttpError(404, "product not covered");
  return r;
}

export async function publicClassify(q: string): Promise<Json> {
  if (pyLen(q) > 300) throw new HttpError(400, "description too long");
  const c = await classify({ name: q }, liveHooks());
  return { query: q, hs6: c.hs6 ?? null, confidence: c.confidence ?? null, description: c.hs6_description ?? null,
    candidates: (c.candidates ?? []).slice(0, 6), note: "A search result, not a binding ruling." };
}

export async function ask(q: string, country: string | null): Promise<Json> {
  if (pyLen(q) > 300) throw new HttpError(400, "Please keep the question under 300 characters.");
  return answer(q, country, 4);
}
