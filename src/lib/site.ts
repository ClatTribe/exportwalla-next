// The site's data index (seo_index.json, built by the Python data pipeline until phase 9) and the public API payloads
// made from it. Ports of export-desk/app/seo_data.py (load, slug, NAME_FIX) and seo.py (api_country, api_product,
// mcp_card). Phase 7 adds the pages.
import fs from "node:fs";
import path from "node:path";
import { BRAND, DATA_DIR, siteUrl } from "./config";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const NAME_FIX: Record<string, string> = {
  HKG: "Hong Kong", KOR: "South Korea", USA: "United States", TZA: "Tanzania", RUS: "Russia", VNM: "Vietnam",
  CZE: "Czechia", GBR: "United Kingdom", ARE: "United Arab Emirates", TUR: "Türkiye", IRN: "Iran", BOL: "Bolivia",
  CHN: "China",
};

/** URL slug: accents dropped ("Türkiye" -> "turkiye"), anything else that is not a letter or digit becomes "-". */
export function slug(s: string): string {
  const base = s.normalize("NFKD").replace(/\p{Mn}/gu, "");
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const INDEX = path.join(DATA_DIR, "seo_index.json");
let cache: { mtime: number | null; data: Json } | null = null;

/** The index, re-read when the file changes (a data rebuild in development). `products` and `uk_buyers` are keyed by
 * HS6 codes, which a JavaScript object would reorder ("640391" sorts before "090931"): they are Maps in file order,
 * the order the Python site iterates them in. */
export function loadIndex(): Json {
  const mtime = fs.existsSync(INDEX) ? fs.statSync(INDEX).mtimeMs : null;
  if (!cache || cache.mtime !== mtime) {
    // mark digit-only keys so JSON.parse keeps them in file order, then unmark them into Maps
    const data: Json = mtime !== null ? JSON.parse(fs.readFileSync(INDEX, "utf8").replace(/"(\d+)"(\s*):/g, '"#$1"$2:'))
      : { countries: {}, products: {}, pairs: {}, uk_buyers: {}, verified: "", built: "" };
    for (const k of ["products", "uk_buyers"]) {
      data[k] = new Map(Object.entries(data[k] ?? {}).map(([key, v]) => [key.replace(/^#/, ""), v]));
    }
    data.by_country_slug = Object.fromEntries(Object.entries(data.countries).map(([iso, c]) => [(c as Json).slug, iso]));
    data.by_product_slug = Object.fromEntries([...data.products].map(([h, p]) => [(p as Json).slug, h]));
    cache = { mtime, data };
  }
  return cache.data;
}

const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export function apiCountry(iso3: string): Json | null {
  const d = loadIndex();
  const key = iso3.toUpperCase();
  const c = Object.hasOwn(d.countries, key) ? d.countries[key] : null;
  if (!c) return null;
  return {
    ...pick(c, ["iso3", "name", "deal", "agreement", "agreements", "origin", "vat", "lane", "fob_basis", "customs_url",
      "mission_url", "import_notes"]),
    top_products: c.top_products.map((t: Json) => ({ ...t, name: d.products.get(t.hs6)?.name ?? null })),
    page: `${siteUrl()}/export-to/${c.slug}`, verified: d.verified,
  };
}

export function apiProduct(hs6: string): Json | null {
  const d = loadIndex();
  const p = d.products.get(hs6) ?? null;
  if (!p) return null;
  return {
    ...pick(p, ["hs6", "name", "description", "epc", "uk_lines", "us_lines"]),
    markets: p.markets.map((m: Json) => ({ ...m, country: d.countries[m.iso3]?.name ?? null })),
    page: `${siteUrl()}/hs-code/${p.slug}`, verified: d.verified,
  };
}

/** Discovery card for the MCP server, in the shape of the MCP registry's server.json. */
export function mcpCard(tools: { name: string; description: string }[]): Json {
  const site = siteUrl();
  return {
    name: "in.exportwalla/export-desk", title: `${BRAND} export data`,
    description: "Import duty for Indian goods in 66 countries, best markets for an HS code, country export rules and HS classification.",
    version: "1.0.0", websiteUrl: site + "/",
    remotes: [{ type: "streamable-http", url: site + "/mcp" }],
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    documentation: site + "/llms.txt", openapi: site + "/openapi.json", authentication: "none",
  };
}
