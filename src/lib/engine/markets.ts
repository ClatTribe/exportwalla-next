// Per-country facts the stages need: duty for India, import VAT, freight lane, customs valuation basis, trade
// agreement and origin document. Port of export-desk/app/markets.py; outputs must match it exactly (see
// tests/markets.parity.test.ts). Duty comes from the database; the rest from data/reference/country_rules*.json.
import fs from "node:fs";
import path from "node:path";
import { REFERENCE_DIR } from "../config";
import { one, rows } from "../db";
import { fmtG, pyRound } from "../py";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const EU27 = new Set("AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE".split(" "));
export const TARIFF_ALIAS: Record<string, string> = { ...Object.fromEntries([...EU27].map((c) => [c, "EUN"])), LIE: "CHE" };

// Customs value basis: most countries charge duty on CIF; these on FOB (excluding international freight and insurance).
export const FOB_BASIS = new Set(["USA", "CAN", "AUS", "NZL"]);

// Indicative 20ft container rates from Nhava Sheva (US$): assumptions the quote lets people edit, not data.
export const LANES: [string, number, string][] = [
  ["North Europe (Rotterdam / Hamburg / Felixstowe)", 1800, "NLD BEL DEU FRA GBR IRL DNK SWE FIN POL LTU LVA EST NOR ISL"],
  ["Mediterranean (Genoa / Valencia / Piraeus)", 1900, "ITA ESP PRT GRC MLT CYP HRV SVN TUR ISR EGY"],
  ["Central Europe via North Europe port + rail", 2300, "AUT CZE SVK HUN ROU BGR LUX CHE LIE"],
  ["US East / West Coast", 3000, "USA"],
  ["Canada (Montreal / Vancouver)", 3200, "CAN"],
  ["Mexico / Brazil (Manzanillo / Santos)", 3300, "MEX BRA"],
  ["Gulf (Jebel Ali / Dammam / Sohar)", 700, "ARE SAU OMN QAT KWT BHR IRQ"],
  ["East / West Africa (Mombasa / Dar / Lagos / Lome)", 1700, "KEN TZA NGA TGO MUS"],
  ["South Africa (Durban)", 1600, "ZAF"],
  ["South-East Asia (Singapore / Port Klang / Laem Chabang)", 600, "SGP MYS IDN THA VNM PHL"],
  ["China / Hong Kong / Korea / Japan", 900, "CHN HKG KOR JPN"],
  ["Australia / New Zealand", 1600, "AUS NZL"],
  ["Neighbours by sea or road (Chittagong / Colombo / Birgunj)", 500, "BGD LKA NPL BTN"],
  ["Russia (St Petersburg / Novorossiysk)", 3200, "RUS"],
];
const LANE_OF = new Map<string, [string, number]>(LANES.flatMap(([lane, usd, isos]) => isos.split(" ").map((iso) => [iso, [lane, usd]] as [string, [string, number]])));

// Export promotion council by HS chapter (DGFT Foreign Trade Policy, Appendix 2T).
export const EPC: [string, string, string][] = [
  ["41 42 43 64", "Council for Leather Exports (CLE)", "https://leatherindia.org"],
  ["61 62", "Apparel Export Promotion Council (AEPC)", "https://www.aepcindia.com"],
  ["50 51 52 53 54 55 56 58 59 60 63", "Cotton Textiles Export Promotion Council (TEXPROCIL) / sector EPC", "https://texprocil.org"],
  ["57", "Carpet Export Promotion Council (CEPC)", "https://www.cepc.co.in"],
  ["03 16", "Marine Products Export Development Authority (MPEDA)", "https://mpeda.gov.in"],
  ["09", "Spices Board India", "https://www.indianspices.com"],
  ["02 04 07 08 10 11 12 15 17 19 20 21 22", "APEDA", "https://apeda.gov.in"],
  ["71", "Gem & Jewellery Export Promotion Council (GJEPC)", "https://gjepc.org"],
  ["30", "Pharmexcil", "https://pharmexcil.com"],
  ["28 29 32 33 34 35 38", "CHEMEXCIL", "https://chemexcil.in"],
  ["39", "PLEXCONCIL", "https://plexconcil.org"],
  ["44 46 66 67 70 83 94 95 96", "Export Promotion Council for Handicrafts (EPCH)", "https://epch.in"],
  ["25 40 48 68 69", "CAPEXIL", "https://capexil.org"],
  ["72 73 74 75 76 78 79 80 81 82 84 85 86 87 89 90 91", "Engineering Export Promotion Council (EEPC India)", "https://www.eepcindia.org"],
];

export function epcFor(hs6: string | null): { name: string; url: string } | null {
  const ch = (hs6 ?? "").slice(0, 2);
  const hit = EPC.find(([chs]) => chs.split(" ").includes(ch));
  return hit ? { name: hit[1], url: hit[2] } : null;
}

let _rules: Record<string, Json> | null = null;
export function rules(): Record<string, Json> {
  if (_rules) return _rules;
  const out: Record<string, Json> = {};
  for (const f of fs.readdirSync(REFERENCE_DIR).filter((n) => /^country_rules.*\.json$/.test(n)).sort()) {
    try {
      for (const c of JSON.parse(fs.readFileSync(path.join(REFERENCE_DIR, f), "utf8")).countries ?? []) out[c.iso3] = c;
    } catch {
      continue;
    }
  }
  return (_rules = out);
}

export const rule = (iso3: string): Json => rules()[iso3] ?? {};

export const agreementsInForce = (iso3: string): Json[] => (rule(iso3).agreements ?? []).filter((a: Json) => a.status === "in_force");

const truthy = (r: Json) => Object.keys(r).length > 0;

export function agreementNote(iso3: string): string {
  const r = rule(iso3);
  const live = agreementsInForce(iso3);
  if (live.length) {
    const a = live[0];
    return `${a.name} in force` + (a.in_force_date ? ` since ${a.in_force_date}` : "");
  }
  const pending = (r.agreements ?? []).filter((a: Json) => a.status === "signed" || a.status === "concluded");
  const gsp = r.gsp ?? {};
  if (pending.length) {
    return `${pending[0].name} ${pending[0].status}, not yet in force` +
      (gsp.india_beneficiary ? `; ${gsp.scheme || "GSP"} preferences apply to some goods` : "");
  }
  if (gsp.india_beneficiary) return `No FTA; India gets ${gsp.scheme || "GSP"} preferences on some goods`;
  if (truthy(r) && r.confidence === "low" && !(r.agreements ?? []).length) return "Rules not researched yet: our desk confirms";
  return truthy(r) ? "No trade agreement with India in force" : "Rules not researched yet: our desk confirms";
}

export function vat(iso3: string): [number | null, string, string | null] {
  const v = rule(iso3).import_vat ?? {};
  return [v.rate_pct ?? null, v.name || "VAT", v.source_url ?? null];
}

export interface Tariff {
  mfn_pct: number | null; india_pct: number | null; basis: string; source: string; source_url: string | null;
  year: string | number | null; lines: number; precision: string; note: string; range?: string; extra?: S301;
}

/** Duty an Indian exporter's buyer pays in iso3 on this HS6. */
export function tariff(iso3: string, hs6: string, classification: Json | null = null): Tariff {
  const cls = classification ?? {};
  let specific = "";
  if (iso3 === "GBR" && cls.uk && cls.uk.mfn_pct == null && cls.uk.mfn) {
    specific = `UK line ${cls.uk.code} has a specific duty (${cls.uk.mfn}); shown here is the WITS ad-valorem average. `;
  }
  if (iso3 === "GBR" && cls.uk && cls.uk.mfn_pct != null) {
    const uk = cls.uk;
    return {
      mfn_pct: uk.mfn_pct, india_pct: uk.india_pct != null ? uk.india_pct : uk.mfn_pct,
      basis: "CIF", source: `UK Trade Tariff, commodity ${uk.code}`,
      source_url: `https://www.trade-tariff.service.gov.uk/commodities/${uk.code}`,
      year: (uk.fetched_at || "").slice(0, 10), lines: 1, precision: "national line",
      note: "India rate is the CETA preference; needs an origin declaration",
    };
  }
  if (iso3 === "USA" && cls.us && cls.us.general_pct != null) {
    const us = cls.us;
    const x = usSection301(hs6, us.code);
    return {
      mfn_pct: us.general_pct, india_pct: pyRound(us.general_pct + x.add_pct, 2), basis: "FOB",
      source: `USITC HTS ${us.code} (general rate)${x.add_pct ? " + 10% Section 301" : ""}`,
      source_url: "https://hts.usitc.gov/", year: (us.fetched_at || "").slice(0, 10), lines: 1,
      precision: "national line", note: x.note, extra: x,
    };
  }
  const rep = TARIFF_ALIAS[iso3] ?? iso3;
  const mfn = one<Json>("SELECT * FROM tariff_hs6 WHERE reporter=? AND hs6=? AND partner='000'", rep, hs6);
  const pref = one<Json>("SELECT * FROM tariff_hs6 WHERE reporter=? AND hs6=? AND partner='356'", rep, hs6);
  if (!mfn) {
    return {
      mfn_pct: null, india_pct: null, basis: FOB_BASIS.has(iso3) ? "FOB" : "CIF", source: "not in WITS for this market",
      source_url: null, year: null, lines: 0, precision: "none", note: "Our desk confirms the rate",
    };
  }
  let india: number = mfn.avg_pct;
  let note = "No preference for India on this line in the latest WITS data";
  if (pref && pref.avg_pct != null && pref.avg_pct < mfn.avg_pct) {
    india = pref.avg_pct;
    note = `India preference reported to WITS (${pref.year})`;
  }
  const live = agreementsInForce(iso3);
  if (live.length && !(pref && pref.avg_pct != null)) {
    const a = live[0];
    const newer = (a.in_force_date || "9999").slice(0, 4) > String(mfn.year);
    note = `${a.name} in force${a.in_force_date ? " since " + a.in_force_date : ""}: ` +
      (newer ? "newer than WITS data, so the India rate shown is the normal rate. Our desk checks the FTA schedule."
             : "preferential rate not in WITS; our desk checks the FTA schedule.");
  }
  let extra: S301 | null = null;
  if (iso3 === "USA") {
    extra = usSection301(hs6);
    india = india + extra.add_pct;
    note = extra.note;
  }
  const gsp = rule(iso3).gsp ?? {};
  if (gsp.india_beneficiary && !(pref && pref.avg_pct != null) && !live.length) {
    note = `${gsp.scheme || "GSP"}: India may get a lower rate on this line if it is not in a suspended ` +
      `section. The rate shown is the normal rate; the claim needs ${preferentialDoc(iso3) || "a GSP origin statement"}.`;
  }
  note = specific + note;
  const rng = mfn.max_pct !== mfn.min_pct ? `${fmtG(mfn.min_pct)}–${fmtG(mfn.max_pct)}%` : `${fmtG(mfn.min_pct)}%`;
  return {
    mfn_pct: pyRound(mfn.avg_pct, 2), india_pct: pyRound(india, 2), basis: FOB_BASIS.has(iso3) ? "FOB" : "CIF",
    source: `WITS/TRAINS ${rep} ${mfn.year}, average of ${mfn.lines} national lines in HS ${hs6} (range ${rng})`,
    source_url: `https://wits.worldbank.org/tariff/trains/en/country/${rep}/partner/IND/product/${hs6}`,
    year: mfn.year, lines: mfn.lines, precision: mfn.lines > 1 ? "HS6 average" : "national line",
    range: rng, note, ...(extra ? { extra } : {}),
  };
}

// ---------------------------------------------------------------- US Section 301 (goods of India, since 24 Jul 2026)

export interface S301 { add_pct: number; status: string; note: string }

let _s301: Json | null | undefined;
function s301(): Json | null {
  if (_s301 === undefined) {
    const p = path.join(REFERENCE_DIR, "us_section301.json");
    _s301 = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  }
  return _s301 ?? null;
}

export const S232_CHAPTERS = ["72", "73", "76"]; // steel and aluminium articles
export const S232_HS4 = ["8703", "8704", "8708"]; // vehicles and parts

/** The extra US duty on goods of India: +10% unless exempt (U.S. note 52(b)) or under Section 232 (note 52(f)). */
export function usSection301(hs6: string, code: string | null = null): S301 {
  const s = s301();
  if (!s) return { add_pct: 0, status: "unknown", note: usExtraNote() };
  const strip = (c: string) => c.replaceAll(".", "");
  const eff = "since 24 Jul 2026";
  if (S232_CHAPTERS.includes(hs6.slice(0, 2)) || S232_HS4.includes(hs6.slice(0, 4))) {
    return {
      add_pct: 0, status: "section232",
      note: "Steel, aluminium and vehicle-part articles pay US Section 232 duties (up to 50% on covered goods) instead of " +
        "the 10% Section 301 duty on Indian goods. The rate shown is the HTSUS general rate only; check CBP's Section 232 " +
        "guidance for your line.",
    };
  }
  const ex: string[] = s.exempt_lines.map(strip);
  const ph: string[] = s.exempt_if_pharmaceutical_use.map(strip);
  const leaves = rows<{ code: string }>("SELECT code FROM us_hts WHERE hs6=? AND is_leaf=1", hs6).map((r) => strip(r.code));
  const isEx = (c: string) => ex.some((x) => c.startsWith(x));
  const target = code ? strip(code) : null;
  const nEx = leaves.filter(isEx).length;
  if ((target && isEx(target)) || (!target && leaves.length && nEx === leaves.length)) {
    return {
      add_pct: 0, status: "exempt",
      note: "Exempt from the 10% US Section 301 duty on Indian goods (listed in U.S. note 52(b)). Rate shown is the HTSUS general rate.",
    };
  }
  const extra: string[] = [];
  if (nEx) extra.push(`${nEx} of ${leaves.length} US lines in this HS code are exempt, so check your exact line.`);
  if ((target ? [target] : leaves).some((c) => ph.some((x) => c.startsWith(x)))) {
    extra.push("Exempt if the goods are for pharmaceutical use (U.S. note 52(e)).");
  }
  if (hs6.slice(0, 2) === "74") extra.push("If your copper or brass article is covered by Section 232 copper duties, those apply instead.");
  if (["44", "94"].includes(hs6.slice(0, 2))) {
    extra.push("Wood products under Section 232 (such as upholstered wooden seating and kitchen cabinets) pay that duty instead.");
  }
  return {
    add_pct: s.rate_pct,
    status: nEx ? "partly_exempt" : extra.some((x) => x.includes("pharmaceutical")) ? "pharma" : "applies",
    note: `Includes the 10% US Section 301 duty on goods of India (${eff}), added to the HTSUS general rate. ` + extra.join(" "),
  };
}

/** Section 301 percentage points on one US tariff line for goods of India (0 if exempt or under Section 232). */
export function usLineAdd(code: string, hs6: string): number {
  const s = s301();
  if (!s || S232_CHAPTERS.includes(hs6.slice(0, 2)) || S232_HS4.includes(hs6.slice(0, 4))) return 0;
  const c = code.replaceAll(".", "");
  return s.exempt_lines.some((x: string) => c.startsWith(x.replaceAll(".", ""))) ? 0 : s.rate_pct;
}

function usExtraNote(): string {
  const notes = (rule("USA").import_notes ?? []).map((n: Json) => n.text as string)
    .filter((t: string) => ["reciprocal", "additional", "section", "ieepa", "tariff"].some((w) => t.toLowerCase().includes(w)));
  return notes[0] ?? "Additional US tariffs on Indian goods may apply on top of the general rate: our desk confirms.";
}

/** The researched preferential proof of origin, or null ("None (no agreement...)" counts as none). */
export function preferentialDoc(iso3: string): string | null {
  const d = ((rule(iso3).origin_proof ?? {}).preferential_document || "").trim();
  const low = d.toLowerCase();
  return !d || low.startsWith("none") || low.startsWith("n/a") || low.startsWith("not applicable") ? null : d;
}

export function originDocument(iso3: string): Json {
  const r = rule(iso3);
  const op = r.origin_proof ?? {};
  const np = r.non_preferential_coo ?? {};
  return {
    agreement: agreementNote(iso3), preferential: preferentialDoc(iso3),
    issued_by: op.issued_by ?? null, how: op.how ?? null, source_url: op.source_url ?? null,
    non_preferential: np, docs: r.rules_docs ?? [], import_notes: r.import_notes ?? [],
    customs_url: r.customs_url ?? null, mission_url: r.india_mission_commerce_url ?? null, confidence: r.confidence ?? null,
  };
}

export function lane(iso3: string): { lane: string; sea_freight_usd: number } {
  const [name, usd] = LANE_OF.get(iso3) ?? ["Other (desk quotes)", 2500];
  return { lane: name, sea_freight_usd: usd };
}

export const LABELS: [RegExp, string][] = [
  [/SAFTA/, "SAFTA"], [/GSTP|Global System/, "GSTP (few goods)"], [/Sri Lanka/, "India–Sri Lanka FTA"],
  [/Japan/, "India–Japan CEPA"], [/Korea/, "India–Korea CEPA"], [/ASEAN|AITIGA|AIFTA/, "ASEAN–India FTA"],
  [/Asia-Pacific|APTA/, "APTA"], [/Malaysia/, "India–Malaysia CECA"], [/New Zealand/, "India–NZ FTA"],
  [/European Union|India-EU|EU Free/, "India–EU FTA"], [/MERCOSUR/, "India–Mercosur PTA"],
  [/Nepal/, "India–Nepal treaty"], [/Bhutan/, "India–Bhutan agreement"], [/UAE|Emirates/, "India–UAE CEPA"],
  [/Oman/, "India–Oman CEPA"], [/Australia/, "India–Australia ECTA"], [/Mauritius/, "India–Mauritius CECPA"],
  [/Singapore/, "India–Singapore CECA"], [/EFTA/, "India–EFTA TEPA"], [/United Kingdom|India-UK|UK Comp/, "India–UK CETA"],
];

export function short(name: string | null): string {
  const s = name ?? "";
  for (const [pat, label] of LABELS) if (pat.test(s)) return label;
  const n = s.split(/\s[(\-–]\s?|\s\(/)[0].trim();
  const m = s.match(/\(([A-Z][A-Za-z-]{2,10})\)/); // prefer the acronym: CEPA, ECTA, AITIGA...
  return m && n.length > 28 ? `${n.split(/\s+/)[0]} ${m[1]}` : n;
}

/** A label a merchant can read at a glance: 'India–UAE CEPA · in force', 'India–EU FTA agreed, not yet in force'. */
export function dealShort(iso3: string): string {
  const r = rule(iso3);
  const live = agreementsInForce(iso3);
  if (live.length) return `${short(live[0].name)} · in force`;
  const pending = (r.agreements ?? []).filter((a: Json) => a.status === "signed" || a.status === "concluded");
  const gsp = r.gsp ?? {};
  if (pending.length) return `${short(pending[0].name)} agreed, not yet in force` + (gsp.india_beneficiary ? " · GSP on some goods" : "");
  if (gsp.india_beneficiary) return "GSP on some goods";
  return truthy(r) && r.confidence !== "low" ? "No trade deal" : "Not researched yet";
}

// ---------------------------------------------------------------- the line a bare HS6 is priced on

/** A classification for a bare HS6, with the UK and US lines carrying the most common rate under it (port of
 * seo_data._pseudo_class). */
export function pseudoClass(hs6: string): Json {
  const uk = one<Json>(`SELECT * FROM uk_commodity c WHERE hs6=? ORDER BY mfn_pct IS NULL,
                         (SELECT COUNT(*) FROM uk_commodity x WHERE x.hs6=c.hs6 AND x.mfn_rate IS c.mfn_rate) DESC, code LIMIT 1`, hs6);
  const us = one<Json>(`SELECT * FROM us_hts h WHERE hs6=? AND is_leaf=1 ORDER BY general_pct IS NULL,
                         (SELECT COUNT(*) FROM us_hts x WHERE x.hs6=h.hs6 AND x.is_leaf=1 AND x.general_pct IS h.general_pct) DESC, code LIMIT 1`, hs6);
  return {
    status: "ok", hs6,
    uk: uk && { code: uk.code, path: uk.path, mfn: uk.mfn_rate, mfn_pct: uk.mfn_pct, india: uk.india_rate, india_pct: uk.india_pct, fetched_at: uk.fetched_at },
    us: us && { code: us.code, path: us.path, general: us.general_rate, general_pct: us.general_pct, fetched_at: us.fetched_at },
  };
}
