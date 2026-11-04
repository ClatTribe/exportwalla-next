// Markdown copies of pages (for AI agents) and the crawl files: robots.txt, sitemap.xml, llms.txt, llms-full.txt.
// Port of export-desk/app/seo.py. Python's "." stops only at "\n" and its "\s" is wider than JavaScript's, so the
// patterns spell both out.
import { deskPhone, siteUrl } from "../config";
import { S, pyStrip, unescapeHtml } from "../py";
import { loadIndex } from "../site";
import { BRAND, type Json, PRICE_FROM_INR, loadGuides } from "./common";
import { TOOLS, guidePage } from "./guides";
import { aboutPage, guide } from "./info";
import { FTA_STATUS, countryHub, ftaHub, ftaPage, indiaExportsPage } from "./reference";
import { pricingPage } from "./tools";

const DOT = "[^\\n]"; // Python's "." without re.S
const W = `[${S}]`;   // Python's "\s"
const R = (src: string, flags = "") => new RegExp(src, "gu" + flags);

/** Turn a rendered page into compact markdown: headings, paragraphs, lists, tables, links. */
export function toMarkdown(pageHtml: string): string {
  const SITE = siteUrl();
  const m = pageHtml.match(/<main class="wrap page">([\s\S]*)<\/main>/u);
  let h = m ? m[1] : pageHtml;
  h = h.replace(/<div class="crumbs">[\s\S]*?<\/div>/gu, "");
  h = h.replace(R(`<h1>(${DOT}*?)</h1>`), (_, x) => `\n# ${x}\n`);
  h = h.replace(R(`<h2>(${DOT}*?)</h2>`), (_, x) => `\n## ${x}\n`);
  h = h.replace(R(`<summary>(${DOT}*?)</summary>`), (_, x) => `\n**${x}**\n`);
  h = h.replace(R(`<a [^>]*href=["']([^"']+)["'][^>]*>(${DOT}*?)</a>`), (_, url, label) => `[${label}](${url.startsWith("/") ? SITE + url : url})`);
  h = h.replace(R(`</t[dh]>${W}*<t[dh][^>]*>`), " | ");
  h = h.replace(R(`<tr>${W}*<t[dh][^>]*>`), "\n| ");
  h = h.replace(R(`</t[dh]>${W}*</tr>`), " |");
  h = h.replace(/<li>/gu, "\n- ");
  h = h.replace(/<(p|div)[^>]*>/gu, "\n");
  h = h.replace(R(`<span>([^<]*)</span>${W}*<b>`), (_, x) => `${x}: <b>`);
  h = h.replace(R(`</b>${W}*<small>(${DOT}*?)</small>`), (_, x) => `</b> (${x})`);
  h = h.replace(R(`<b>(${DOT}*?)</b>`), (_, x) => `**${x}**`);
  h = h.replace(/<[^>]+>/gu, "");
  h = unescapeHtml(h);
  h = h.replace(R(`\\n${W}*\\n${W}*\\n+`), "\n\n");
  const can = pageHtml.match(/<link rel="canonical" href="([^"]+)"/u);
  return pyStrip(h) + `\n\nSource page: ${can ? can[1] : SITE}\n`;
}

// search crawlers, AI search and answer bots and the training crawlers: a public reference site wants to be cited
const BOTS = ["Googlebot", "Bingbot", "OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot",
  "anthropic-ai", "PerplexityBot", "Perplexity-User", "Google-Extended", "GoogleOther", "Google-CloudVertexBot",
  "Applebot", "Applebot-Extended", "DuckDuckBot", "DuckAssistBot", "Meta-ExternalAgent", "Meta-ExternalFetcher",
  "Amazonbot", "MistralAI-User", "CCBot", "YandexBot"];

export function robots(): string {
  const allow = BOTS.map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /app\nDisallow: /review\nDisallow: /api/\nAllow: /api/public/\n`).join("\n");
  return `# ${BRAND}: public reference pages are open to search and AI assistants. The workspace is private.\n${allow}\n`
    + "User-agent: *\nDisallow: /app\nDisallow: /review\nDisallow: /api/\nAllow: /api/public/\n\n"
    + `Sitemap: ${siteUrl()}/sitemap.xml\n`;
}

/** Every public URL, in sitemap order. */
export function sitemapUrls(): string[] {
  const d = loadIndex(), gs = loadGuides();
  const urls = ["/", "/hi", "/export-to", "/hs-code", "/fta", "/india-exports", "/guide/how-to-export-from-india", "/hi/export-kaise-kare",
    "/about", "/sources", "/privacy", "/terms"];
  urls.push(...(Object.values(d.ftas ?? {}) as Json[]).map((f) => `/fta/${f.slug}`));
  urls.push("/guide", "/tools", "/pricing", "/contact", "/refund-policy", ...TOOLS.map(([s]) => `/tools/${s}`));
  urls.push(...[...gs.keys()].map((s) => `/guide/${s}`), ...[...gs].filter(([, g]) => g.hi).map(([s]) => `/hi/guide/${s}`));
  urls.push(...(Object.values(d.countries) as Json[]).map((c) => `/export-to/${c.slug}`));
  urls.push(...[...d.products.values()].map((p: Json) => `/hs-code/${p.slug}`));
  urls.push(...Object.keys(d.pairs).map((k) => { const [h, iso] = k.split("|"); return `/export/${d.products.get(h).slug}/${d.countries[iso].slug}`; }));
  return urls;
}

export function sitemap(): string {
  const d = loadIndex(), lm = d.verified || d.built, SITE = siteUrl();
  const body = sitemapUrls().map((u) => `<url><loc>${SITE}${u}</loc><lastmod>${lm}</lastmod></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

const llmsGuides = () => [...loadGuides()].map(([s, g]) => `- [${g.h1}](${siteUrl()}/guide/${s})${g.hi ? ` ([Hinglish](${siteUrl()}/hi/guide/${s}))` : ""}`).join("\n");

export function llmsTxt(): string {
  const d = loadIndex(), SITE = siteUrl();
  const nC = Object.keys(d.countries).length, nF = Object.keys(d.ftas ?? {}).length;
  const topC = ["GBR", "ARE", "USA", "DEU", "AUS", "SAU", "NLD", "JPN"];
  return `# ${BRAND}

> Exportwalla is an export desk for Indian manufacturers. Free tools give the HS code, the best destination countries, the import duty
> an Indian product pays in ${nC} countries (including India–UK CETA, India–UAE CEPA, India–Australia ECTA and
> ASEAN–India rates), named UK importers, a landed-cost quote and export documents. A human desk then handles IEC,
> RCMC, freight, customs, certificates of origin, LC, e-BRC and refunds, paid per shipment. Data verified ${d.verified || d.built}.

Duty figures come from the UK Trade Tariff, USITC HTS and World Bank WITS/TRAINS and link to their source. Market
indicators are derived from UN Comtrade. Trade-agreement facts are researched with a source URL each.

## Reference pages
- [Export by country](${SITE}/export-to): duty, trade deal, certificate of origin and import VAT for ${nC} countries
- [HS codes and duty](${SITE}/hs-code): ${d.products.size} export products with UK/US lines and duty by country
- [India's trade agreements](${SITE}/fta): ${nF} agreements, status, which products pay less, how to claim
- [Where India exports](${SITE}/india-exports): top markets and product chapters as shares
- [How to export from India](${SITE}/guide/how-to-export-from-india): IEC to e-BRC, step by step
- [Export guides](${SITE}/guide): IEC, RCMC, HS codes, certificate of origin, GST LUT, RoDTEP, pricing, Incoterms, LC, ECGC, buyers, shipping; plus product guides
- [Free tools](${SITE}/tools): HS code finder, import duty checker, export price calculator, export readiness check
- [Pricing](${SITE}/pricing): free tools; export desk from ₹${PRICE_FROM_INR()} per shipment + GST; [contact](${SITE}/contact)
- [Export kaise kare (Hinglish)](${SITE}/hi/export-kaise-kare)
- [About ${BRAND}](${SITE}/about) and [sources and licences](${SITE}/sources)
${topC.filter((i) => i in d.countries).map((i) => `- [Export to ${d.countries[i].name}](${SITE}/export-to/${d.countries[i].slug})`).join("\n")}

## Guides
${llmsGuides()}

## Trade agreements
${(Object.values(d.ftas ?? {}) as Json[]).map((f) => `- [${f.label}](${SITE}/fta/${f.slug}): ${FTA_STATUS[f.status].toLowerCase()}${f.since ? " since " + f.since : ""}`).join("\n")}

## Page URL patterns
- \`/export-to/{country}\`: one country (e.g. \`/export-to/united-kingdom\`)
- \`/hs-code/{hs6}-{name}\`: one product (e.g. \`/hs-code/640391-leather-footwear-covering-the-ankle-outer-soles-of-rubber\`)
- \`/export/{product}/{country}\`: one product to one country, with duty, landed cost, documents and buyers
- \`/fta/{agreement}\`: one trade agreement

Every page is also available as markdown: append \`.md\` to its URL. The key pages in one file: ${SITE}/llms-full.txt

## API (JSON, no key)
- \`GET ${SITE}/api/public/duty?hs6=640391&country=GBR\`: duty for Indian goods vs normal duty, with source
- \`GET ${SITE}/api/public/country/ARE\`: trade deal, origin document, VAT, top products
- \`GET ${SITE}/api/public/product/090931\`: HS line, UK/US lines, ranked markets
- \`GET ${SITE}/api/public/classify?q=leather+chelsea+boots\`: HS code candidates for a product description
- OpenAPI: ${SITE}/openapi.json

## MCP
- Streamable HTTP endpoint: \`${SITE}/mcp\`. Tools: lookup_duty, best_markets, country_rules, classify_product.
- Server card: ${SITE}/.well-known/mcp.json

## How to cite
- Quote the page's duty figure with its source link and the "Data verified" date. Rates are guidance, not a customs ruling.

## Contact
- Exportwalla export desk: ${deskPhone()}
`;
}

/** The key pages as one markdown file, for assistants that read a site in one fetch. */
export function llmsFull(): string {
  const d = loadIndex();
  const parts = [llmsTxt(), toMarkdown(aboutPage()), toMarkdown(ftaHub()), toMarkdown(indiaExportsPage()), toMarkdown(countryHub()), toMarkdown(guide("en"))];
  parts.push(...(Object.values(d.ftas ?? {}) as Json[]).map((f) => toMarkdown(ftaPage(f.slug)!)));
  parts.push(toMarkdown(pricingPage()), ...[...loadGuides().keys()].map((s) => toMarkdown(guidePage(s)!)));
  return parts.join("\n\n---\n\n");
}
