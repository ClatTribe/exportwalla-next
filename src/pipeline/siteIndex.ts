// The site index (data/seo_index.json): every public product, product x country pair, country and trade agreement,
// computed with the same engine the API uses (duty, country ranking, deal labels) over the build database. Port of
// export-desk/app/seo_data.py (build and its helpers). The engine reads the database named by EXPORTWALLA_DB.
import fs from "node:fs";
import { DATA_DIR } from "../lib/config";
import { FOB_BASIS, LABELS, agreementNote, dealShort, epcFor, lane, originDocument, pseudoClass, rule, tariff, vat } from "../lib/engine/markets";
import { chooseCountry, destinations, scopeProducts, todayIso } from "../lib/engine/stages";
import { S, WB, cpSlice, pyJson, pyLen, pyRound, pySplit, pyStrip } from "../lib/py";
import { NAME_FIX, slug } from "../lib/site";
import type { Conn, Row } from "./core";
import { hsReference } from "./ingest";

export const INDEX_OUT = () => process.env.EXPORTWALLA_INDEX_OUT ?? `${DATA_DIR}/seo_index.json`;
const ALWAYS_PAIR = ["GBR", "ARE", "USA"]; // high search interest: give these a page whenever data exists
const TOP_PAIRS = 5;
const W = `[${S}]`, DOT = "[^\\n]";
const R = (src: string, flags = "") => new RegExp(src, "u" + flags);

const STOPTAIL = R(`(${W}+(or|of|and|the|for|with|by|in|not|other|whether|than|n\\.e\\.c\\.|excluding|including))+$`, "i");

function clean(t: string | null): string {
  t = (t || "").replace(R(`${WB}n\\.e\\.c\\.( in (heading|item|subheading) no\\.? [\\p{Nd}.]+)?,?`, "g"), "");
  t = t.replace(/\([^)]*\)/g, ""); // parentheticals are qualifiers
  return pyStrip(t.replace(R(`${W}+`, "g"), " "), " ,;:");
}

function cut(t: string, n: number): string {
  if (pyLen(t) <= n) return pyStrip(t.replace(STOPTAIL, ""), " ,;:");
  t = cpSlice(t, 0, n);
  const sp = t.lastIndexOf(" ");
  if (sp >= 0) t = t.slice(0, sp);
  if (t.includes(",")) t = t.split(R(`[,;:]${W}*(?=[^,;:]*$)`))[0];
  return pyStrip(t.replace(STOPTAIL, ""), " ,;:");
}

const QUAL = new Set(["single", "further", "used", "not", "other", "of", "with", "containing", "multiple", "put", "in", "for",
  "weighing", "having", "whether", "unbleached", "bleached", "dyed", "printed", "fresh", "frozen"]);
const lowerFirst = (s: string) => cpSlice(s, 0, 1).toLowerCase() + cpSlice(s, 1);

/** A readable product name from the HS6 text plus its heading. */
export function shortName(desc: string, heading = ""): string {
  const sub = clean(desc), headFull = clean(heading);
  const head = headFull ? cut(headFull.split(/[;,]/)[0], 40) : "";
  const k = sub.indexOf(";");
  const first = k < 0 ? sub : sub.slice(0, k), rest = k < 0 ? "" : sub.slice(k + 1);
  let name: string;
  if (pyStrip(rest)) { // "Spices; cumin seeds, neither crushed nor ground"
    const lead = pyStrip(first), body = pyStrip(rest);
    name = body.toLowerCase().startsWith(cpSlice(pySplit(lead.toLowerCase())[0], 0, 6)) ? body : `${lead}: ${body}`;
  } else if (head && !sub.toLowerCase().startsWith(cpSlice(head.toLowerCase(), 0, 12))) name = `${head}: ${lowerFirst(sub)}`;
  else name = sub;
  if (head && QUAL.has(pyStrip(pySplit(name)[0].toLowerCase(), ","))) name = `${cut(head, 28)}: ${lowerFirst(name)}`;
  name = name.replace(R(`${W}+,`, "g"), ",").replace(R(`${W}*,${W}*,`, "g"), ",").replace(R(`:${W}*,${W}*`, "g"), ": ");
  name = cut(name, 72);
  return cpSlice(name, 0, 1).toUpperCase() + cpSlice(name, 1);
}

// Everyday names exporters search for, by HS heading. The tariff wording stays on the page as the detail.
export const COMMON: Record<string, string> = {
  "0303": "frozen fish", "0304": "fish fillets", "0306": "shrimp and prawns", "0307": "squid and molluscs",
  "0801": "cashew nuts", "0802": "nuts", "0804": "mangoes and dates", "0806": "grapes", "0901": "coffee", "0902": "tea",
  "0904": "black pepper and chillies", "0906": "cinnamon", "0908": "cardamom and nutmeg", "0909": "cumin and coriander seeds",
  "0910": "turmeric, ginger and spices", "1001": "wheat", "1005": "maize", "1006": "rice", "1201": "soybeans", "1207": "sesame and oil seeds",
  "1302": "guar gum and plant extracts", "1701": "sugar", "1905": "biscuits and bakery", "2008": "processed fruit and nuts",
  "2009": "fruit juices", "2106": "food preparations", "2304": "soybean meal", "2309": "animal feed", "3002": "vaccines",
  "3003": "medicines (bulk)", "3004": "medicines", "3301": "essential oils", "3302": "fragrance mixtures", "3304": "cosmetics and skin care",
  "3305": "hair care products", "3923": "plastic packaging", "3926": "plastic articles", "4011": "tyres", "4104": "tanned hides",
  "4107": "finished leather", "4113": "finished leather", "4202": "leather bags, wallets and cases", "4203": "leather garments, gloves and belts",
  "5205": "cotton yarn", "5208": "cotton fabric", "5209": "cotton fabric", "5701": "hand-knotted carpets", "5702": "woven carpets and rugs",
  "5703": "tufted carpets", "6104": "women's knitted suits and dresses", "6105": "men's knitted shirts", "6106": "women's knitted blouses",
  "6109": "T-shirts", "6110": "sweaters and pullovers", "6111": "babies' garments", "6203": "men's suits and trousers",
  "6204": "women's suits and dresses", "6205": "men's shirts", "6206": "women's blouses and tops", "6211": "tracksuits and garments",
  "6302": "bed linen and towels", "6304": "furnishing articles", "6402": "rubber and plastic footwear", "6403": "leather footwear",
  "6404": "textile footwear", "6405": "footwear", "6406": "footwear parts", "6802": "granite and marble", "6907": "ceramic tiles",
  "6910": "ceramic sanitaryware", "7102": "diamonds", "7108": "gold", "7113": "jewellery", "7117": "imitation jewellery",
  "7208": "hot-rolled steel", "7304": "steel pipes", "7306": "steel pipes and tubes", "7307": "pipe fittings",
  "7318": "bolts, screws and nuts", "7323": "steel kitchenware", "7325": "iron castings", "7326": "iron and steel articles",
  "7419": "brass and copper articles", "7601": "aluminium", "7604": "aluminium profiles", "8413": "pumps", "8481": "valves",
  "8482": "ball bearings", "8483": "gears and shafts", "8504": "transformers", "8517": "smartphones", "8541": "solar panels",
  "8544": "cables and wires", "8703": "cars", "8708": "auto parts", "8711": "motorcycles", "8714": "bicycle and motorcycle parts",
  "9403": "furniture", "9405": "lamps and lighting", "9503": "toys",
};

/** 'Leather footwear (covering the ankle, outer soles of rubber)' for pages and titles. */
export function displayName(hs6: string, technical: string): string {
  const common = Object.hasOwn(COMMON, hs6.slice(0, 4)) ? COMMON[hs6.slice(0, 4)] : null;
  if (!common) return technical;
  const k = technical.indexOf(":");
  let detail = k >= 0 ? pyStrip(technical.slice(k + 1)) : "";
  const stem = (w: string) => w.toLowerCase().replace(/s+$/, "");
  const seen = new Set((common.match(/[A-Za-z-]+/g) ?? []).map(stem));
  const words = (detail.match(R(`[^${S}]+`, "g")) ?? []).filter((w) => !seen.has(stem(w.replace(/[^A-Za-z-]/g, ""))));
  detail = pyStrip(words.join(" ").replace(R(`${W}+(and|or)${W}*(,|$)`, "g"), (_, __, end) => end).replace(R(`^(and|or|of|,)${W}+`), ""), " ,;");
  detail = detail.replace(R(`,?${W}*${WB}whether or not${WB}${DOT}*$`), "").replace(R(`${W}*,${W}*,`, "g"), ",");
  detail = cut(detail, 48).replace(R(`${W}+(their|its|with|for)$`), "");
  return cpSlice(common, 0, 1).toUpperCase() + cpSlice(common, 1) + (detail ? ` (${detail})` : "");
}

function countryNames(conn: Conn): Map<string, [string, string]> {
  const names = new Map<string, [string, string]>();
  for (const r of conn.all<{ iso3: string; iso2: string; name: string }>("SELECT iso3, iso2, name FROM countries WHERE is_group=0 AND iso2 IS NOT NULL")) {
    if (r.name.includes("...") || r.name.includes("(")) continue;
    const had = names.get(r.iso3);
    if (!had || pyLen(r.name) < pyLen(had[1])) names.set(r.iso3, [r.iso2, r.name]);
  }
  for (const [iso, n] of Object.entries(NAME_FIX)) names.set(iso, [names.get(iso)?.[0] ?? "", n]);
  return names;
}

const band = (share: number) => (share >= 0.10 ? "high" : share >= 0.03 ? "medium" : "low");
const label = (name: string) => LABELS.find(([pat]) => pat.test(name))?.[1] ?? null;

export function buildSiteIndex(conn: Conn): Row {
  const names = countryNames(conn);
  const dest = destinations();
  const hsDesc = new Map(conn.all<{ code: string; description: string }>("SELECT code, description FROM hs6").map((r) => [r.code, r.description]));
  const hsRef = hsReference(conn);
  const verified = (conn.get<{ t: string }>("SELECT MAX(finished_at) t FROM ingest_runs WHERE status='ok'")?.t ?? "").slice(0, 10);
  const products = new Map<string, Row>(), pairs: Record<string, Row> = {};
  for (const hs6 of scopeProducts()) {
    if (!hsDesc.has(hs6)) continue;
    const cls = pseudoClass(hs6);
    const cc = chooseCountry({ products: [{ product_id: hs6, name: hs6, classification: cls }] });
    if (cc.status !== "ok") continue;
    const technical = shortName(hsDesc.get(hs6)!, hsRef.get(hs6.slice(0, 4)) ?? "");
    const name = displayName(hs6, technical);
    let sl = slug(name);
    if (pyLen(sl) > 60) { sl = cpSlice(sl, 0, 60); const i = sl.lastIndexOf("-"); if (i >= 0) sl = sl.slice(0, i); }
    const p: Row = { hs6, name, common: COMMON[hs6.slice(0, 4)] ?? technical, technical, slug: `${hs6}-${sl}`, description: hsDesc.get(hs6),
      chapter: hs6.slice(0, 2), epc: epcFor(hs6),
      uk_lines: conn.all("SELECT code, description, mfn_rate, india_rate FROM uk_commodity WHERE hs6=? ORDER BY code", hs6).slice(0, 12),
      us_lines: conn.all("SELECT code, description, general_rate FROM us_hts WHERE hs6=? AND is_leaf=1 ORDER BY code", hs6).slice(0, 12),
      markets: [] as Row[] };
    (cc.all as Row[]).forEach((m, k) => {
      const t = tariff(m.iso3, hs6, cls);
      p.markets.push({ iso3: m.iso3, rank: k + 1, score: m.score, india_share: pyRound(m.india_share, 3), share_band: band(m.india_share),
        growth: pyRound(m.growth, 2), india_pct: t.india_pct, mfn_pct: t.mfn_pct, precision: t.precision, duty_source: t.source,
        duty_url: t.source_url, duty_year: t.year, duty_note: t.note, basis: t.basis, deal: dealShort(m.iso3),
        // a deal is in force but its preferential rate is not in the data: the figure is the normal rate
        pref_pending: (t.note || "").includes("FTA schedule") });
    });
    const chosen = [...p.markets.slice(0, TOP_PAIRS).map((m: Row) => m.iso3), ...ALWAYS_PAIR.filter((i) => p.markets.some((m: Row) => m.iso3 === i))];
    for (const iso of new Set(chosen)) {
      const m = p.markets.find((x: Row) => x.iso3 === iso);
      if (m.india_pct === null) continue;
      const { iso3: _iso3, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars
      pairs[`${hs6}|${iso}`] = { hs6, iso3: iso, ...rest };
    }
    products.set(hs6, p);
  }
  const countries: Record<string, Row> = {};
  for (const iso of dest) {
    const r = rule(iso);
    const [iso2, nm] = names.get(iso) ?? ["", iso];
    const top = [...products.values()].filter((p) => p.markets.some((m: Row) => m.iso3 === iso))
      .map((p) => [p.hs6, p.markets.find((m: Row) => m.iso3 === iso)] as [string, Row])
      .map((x, i) => [x, i] as const).sort((a, b) => b[0][1].india_share - a[0][1].india_share || a[1] - b[1]).map(([x]) => x);
    const od = originDocument(iso);
    const [vatPct, vatName, vatUrl] = vat(iso);
    countries[iso] = { iso3: iso, iso2, name: nm, slug: slug(nm), deal: dealShort(iso), agreement: agreementNote(iso),
      agreements: r.agreements || [], gsp: r.gsp || {}, origin: Object.fromEntries(["preferential", "issued_by", "how", "source_url"].map((k) => [k, od[k] ?? null])),
      non_preferential: od.non_preferential || {}, vat: { pct: vatPct, name: cpSlice((vatName || "VAT").split(R(`${W}*[(:;]`))[0] || "VAT", 0, 30), url: vatUrl },
      customs_url: r.customs_url ?? null, mission_url: r.india_mission_commerce_url ?? null, import_notes: r.import_notes || [], lane: lane(iso),
      fob_basis: FOB_BASIS.has(iso), confidence: r.confidence ?? null,
      top_products: top.slice(0, 20).map(([h, m]) => ({ hs6: h, india_share: m.india_share, share_band: m.share_band, india_pct: m.india_pct,
        mfn_pct: m.mfn_pct, has_page: `${h}|${iso}` in pairs, pref_pending: m.pref_pending ?? false })) };
  }
  const ukBuyers = new Map<string, Row[]>();
  for (const pr of Object.values(pairs)) {
    if (pr.iso3 === "GBR") {
      ukBuyers.set(pr.hs6, conn.all(`SELECT t.name, t.postcode, MAX(tc.year) year, COUNT(DISTINCT tc.cn8) codes,
          MAX(LENGTH(tc.import_months) - LENGTH(REPLACE(tc.import_months, ',', '')) + 1) months
        FROM uk_trader_commodity tc JOIN uk_trader t ON t.trader_id=tc.trader_id
        WHERE tc.cn8 LIKE ? AND tc.import_months <> '' GROUP BY t.trader_id ORDER BY months DESC, codes DESC LIMIT 10`, pr.hs6 + "%"));
    }
  }
  return { built: todayIso(), verified, countries, products, pairs, uk_buyers: ukBuyers, ...extras(conn, countries) };
}

/** India's export mix as shares, UK CETA line counts, and one entry per trade agreement in force or concluded. */
function extras(conn: Conn, countries: Record<string, Row>): Row {
  const ref = hsReference(conn), names = countryNames(conn);
  const m49 = new Map(conn.all<{ m49: number; iso3: string }>("SELECT m49, iso3 FROM countries WHERE is_group=0 AND iso3 IS NOT NULL").map((r) => [r.m49, r.iso3]));
  const tot = new Map<string, [number, number, number]>();
  for (const r of conn.all<{ year: number; partner_m49: number; value_usd: number }>("SELECT year, partner_m49, value_usd FROM india_export WHERE level='TOTAL'")) {
    tot.set(`${r.year}|${r.partner_m49}`, [r.year, r.partner_m49, r.value_usd]);
  }
  const year = Math.max(...[...tot.values()].map(([y]) => y));
  const world = tot.get(`${year}|0`)![2];
  const partners = [...tot.values()].filter(([y, p]) => y === year && m49.has(p)).map(([, p, v]) => [m49.get(p)!, p, v] as [string, number, number])
    .map((x, i) => [x, i] as const).sort((a, b) => b[0][2] - a[0][2] || a[1] - b[1]).map(([x]) => x).slice(0, 30);
  const top = partners.map(([iso, p, v]) => {
    const prev = tot.get(`${year - 1}|${p}`)?.[2];
    return { iso3: iso, name: iso in countries ? countries[iso].name : names.get(iso)?.[1] ?? iso, iso2: names.get(iso)?.[0] ?? "",
      share: pyRound(v / world * 100, 1), growth: prev ? pyRound(v / prev - 1, 3) : null, slug: iso in countries ? countries[iso].slug : null };
  });
  const ch = conn.all<{ hs: string; value_usd: number }>("SELECT hs, value_usd FROM india_export WHERE level='2' AND partner_m49=0 AND year=? ORDER BY value_usd DESC", year);
  const chapters = ch.slice(0, 25).map((r) => ({ chapter: r.hs, name: cpSlice((ref.get(r.hs) ?? r.hs).split(";")[0], 0, 80), share: pyRound(r.value_usd / world * 100, 1) }));
  const uk = conn.get(`SELECT COUNT(*) total, SUM(india_rate='0.00 %' AND mfn_rate IS NOT NULL AND mfn_rate <> '0.00 %') cut,
    SUM(india_rate='0.00 %' AND mfn_rate='0.00 %') already FROM uk_commodity`);
  const docs = conn.all<{ title: string; url: string; country: string; agreement: string | null }>("SELECT title, url, country, agreement FROM rag_doc WHERE url LIKE 'http%'");
  const ftas = new Map<string, Row>();
  for (const c of Object.values(countries)) {
    for (const a of c.agreements as Row[]) {
      const lab = label(a.name);
      if (!lab) continue;
      if (!ftas.has(lab)) ftas.set(lab, { label: lab, slug: slug(lab.split(" (")[0]), name: a.name, status: a.status ?? null, since: null,
        source_url: a.source_url ?? null, countries: [], negotiating: [] });
      const f = ftas.get(lab)!;
      if (a.status === "in_force" || a.status === "concluded") {
        if (f.status !== "in_force" || a.status === "in_force") {
          f.status = a.status; f.name = a.name;
          f.source_url = f.source_url || a.source_url || null;
        }
        if (a.in_force_date && (!f.since || a.in_force_date < f.since)) f.since = a.in_force_date;
        if (!f.countries.includes(c.iso3)) f.countries.push(c.iso3);
      } else if (!f.negotiating.includes(a.name)) f.negotiating.push(a.name);
    }
  }
  for (const f of [...ftas.values()]) {
    if (!f.countries.length) { ftas.delete(f.label); continue; }
    const n = f.countries.length;
    f.texts = docs.filter((d) => d.country.split(",").length <= n + 1 && d.country.split(",").some((x) => f.countries.includes(x))
      && label((d.agreement || "").split(/[;,]/)[0] || "") === f.label).slice(0, 12).map((d) => ({ title: cpSlice(d.title, 0, 120), url: d.url }));
  }
  return { india_exports: { year, partners: top, chapters, source: "UN Comtrade (India as reporter), shares derived" },
    uk_ceta: uk, ftas: Object.fromEntries(ftas) };
}

/** Writes the index (json.dumps(..., ensure_ascii=False) layout; whole-number floats print without ".0"). */
export function writeSiteIndex(index: Row, file = INDEX_OUT()) {
  fs.writeFileSync(file, pyJson(index, { ascii: false }));
}
