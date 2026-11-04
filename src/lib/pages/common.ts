// Shared page parts: the layout every public page uses, the organisation's structured data, contact points and the
// small text helpers. Port of the top of export-desk/app/seo.py; output must match the Python site byte for byte
// (tests/pages.parity.test.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import guidesJson from "@/content/guides.json";
import { BRAND, contactEmail, deskPhone, siteUrl } from "../config";
import { usLineAdd } from "../engine/markets";
import { S, cpSlice, escapeHtml, fmtG, fmtFixed, pyJson, pyLen, pyStrip } from "../py";
import { loadIndex } from "../site";

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const e = escapeHtml;
export { BRAND };

// settings (export-desk/config.py)
export const env = (k: string, d = "") => process.env[k] ?? d;
export const DESK_WHATSAPP = () => env("DESK_WHATSAPP");
export const LEGAL_NAME = () => env("LEGAL_NAME");
export const BUSINESS_ADDRESS = () => env("BUSINESS_ADDRESS");
export const GRIEVANCE_OFFICER = () => env("GRIEVANCE_OFFICER");
export const PRICE_FROM_INR = () => env("PRICE_FROM_INR", "12,000");
export const FX_AS_OF = () => env("FX_AS_OF", "2 Nov 2026");

export const OGL = "Contains public sector information licensed under the Open Government Licence v3.0.";
export const NOT_AFFILIATED = `${BRAND} is an independent service. It is not affiliated with the Government of India, DGFT, any export ` +
  "promotion council, HMRC, US CBP or any customs authority.";

/** Literal replace-all (String.replace would read "$" patterns in the replacement, and "US$" is common here). */
export const rep = (s: string, a: string, b: string) => s.split(a).join(b);

/** str.rstrip(chars) */
export function rstrip(s: string, chars: string): string {
  const cp = Array.from(s);
  let n = cp.length;
  while (n && chars.includes(cp[n - 1])) n--;
  return cp.slice(0, n).join("");
}

/** s.rsplit(" ", 1)[0] */
export const rsplitHead = (s: string) => { const i = s.lastIndexOf(" "); return i < 0 ? s : s.slice(0, i); };

/** Python's sorted(xs, key=...) for string keys or tuples of keys (code-point order, stable). */
export function sortBy<T>(xs: Iterable<T>, key: (x: T) => (string | number | boolean)[] | string | number): T[] {
  const cmp = (a: unknown, b: unknown): number => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
      return a.length - b.length;
    }
    const x = typeof a === "boolean" ? Number(a) : a, y = typeof b === "boolean" ? Number(b) : b;
    return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
  };
  return [...xs].map((x) => [key(x), x] as const).sort((a, b) => cmp(a[0], b[0])).map(([, x]) => x);
}

export function mobileMenu(lang = "en"): string {
  const hi = lang === "hi";
  const links: [string, string][] = [["/export-to", hi ? "Desh" : "Countries"], ["/fta", "Trade deals"], ["/hs-code", "HS codes"],
    ["/guide", "Guides"], ["/tools", "Free tools"], ["/pricing", hi ? "Fees" : "Pricing"],
    ["/about", hi ? "Hamare baare mein" : "About"], ["/contact", "Contact"]];
  const other = hi ? '<a href="/" hreflang="en">English</a>' : '<a href="/hi" hreflang="hi">हिंदी (Hinglish)</a>';
  return '<details class="mnav"><summary aria-label="Menu"><span></span></summary><div class="mpanel">'
    + links.map(([h, t]) => `<a href="${h}">${e(t)}</a>`).join("") + other
    + `<button type="button" class="mask" data-ask onclick="this.closest('details').open=false">`
    + (hi ? "Desk se poochhiye" : "Ask the desk") + "</button></div></details>";
}

export const CTA_HTML = '<a class="pill go" href="/app"><span class="dk">Check my product</span><span class="mb">Check free</span></a>';

export function contactScript(noFab = false): string {
  const cfg = { phone: deskPhone(), whatsapp: DESK_WHATSAPP(), email: contactEmail(), noFab };
  return `<script>window.EW_CONTACT=${pyJson(cfg)}</script><script src="${asset("lead.js")}" defer></script>`;
}

export function askBox(title: string, text: string, step: string, o: { product?: string; country?: string; label?: string; message?: string } = {}): string {
  const attrs = ([["title", title], ["step", step], ["product", o.product ?? ""], ["country", o.country ?? ""], ["message", o.message ?? ""]] as const)
    .filter(([, v]) => v).map(([k, v]) => `data-ask-${k}="${e(v)}"`).join(" ");
  return `<div class="askbox"><div><b>${e(title)}</b><span>${e(text)}</span></div>`
    + `<button type="button" class="pill go" data-ask ${attrs}>${e(o.label ?? "Ask the desk")}</button></div>`;
}

export function verificationMeta(): string {
  return ([["google-site-verification", env("GOOGLE_SITE_VERIFICATION")], ["msvalidate.01", env("BING_SITE_VERIFICATION")]] as const)
    .filter(([, v]) => v).map(([n, v]) => `<meta name="${n}" content="${e(v)}">`).join("");
}

export const businessLine = () => [LEGAL_NAME(), BUSINESS_ADDRESS(), contactEmail()].filter(Boolean).map(e).join(" · ");

export function flag(iso2: string | null | undefined): string {
  return iso2 && pyLen(iso2) === 2 ? Array.from(iso2.toUpperCase()).map((c) => String.fromCodePoint(127397 + c.codePointAt(0)!)).join("") : "🌐";
}

/** Fill {name} so the whole title stays within `limit` characters, cutting the name at a word. */
export function fit(template: string, name: string, limit = 70, floor = 14): string {
  const room = Math.max(floor, limit - pyLen(rep(template, "{name}", "")));
  if (pyLen(name) > room) name = rstrip(rsplitHead(cpSlice(name, 0, room)), " ,;:(");
  return rep(template, "{name}", name);
}

export const clip = (text: string, limit = 145) =>
  pyLen(text) <= limit ? text : rstrip(rsplitHead(cpSlice(text, 0, limit)), " ,;:") + "…";

export const hasDeal = (c: Json) => c.deal.endsWith("· in force");

/** 'CETA origin declaration (Annex 3B template) completed by ...' -> 'CETA origin declaration' */
export function shortDoc(d: string | null | undefined): string {
  const head = (d || "").split(new RegExp(`[${S}]\\(|;|,| completed| issued| or (?=certificate|a )`, "u"))[0];
  return cpSlice(pyStrip(head), 0, 70);
}

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${fmtG(v)}%`);
export const money = (v: number) => `US$${fmtFixed(v, 0, { comma: true })}`;

const STATIC_DIR = path.join(process.cwd(), "public", "static");
const assetCache = new Map<string, string>();

/** /static/x.css?v=<content hash>: lets the CDN cache assets for a week while every release shows at once. */
export function asset(p: string): string {
  if (!assetCache.has(p)) {
    const f = path.join(STATIC_DIR, p);
    const v = fs.existsSync(f) ? crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex").slice(0, 8) : "0";
    assetCache.set(p, `/static/${p}?v=${v}`);
  }
  return assetCache.get(p)!;
}

export const src = (url: string | null | undefined, label = "source") => (url ? ` (<a href="${e(url)}" rel="nofollow">${label}</a>)` : "");

export function orgLd(): Json {
  const SITE = siteUrl();
  const o: Json = { "@context": "https://schema.org", "@type": "Organization", "@id": SITE + "/#org", name: BRAND, url: SITE + "/",
    logo: SITE + "/static/brand/icon-512.png", description: "Export desk for Indian manufacturers: HS code, best markets, duty, buyers, quotes and documents, plus a human desk from IEC to e-BRC.",
    areaServed: "IN", knowsLanguage: ["en-IN", "hi-IN"],
    knowsAbout: ["Exporting from India", "HS code classification", "Import duty", "Free trade agreements", "Rules of origin",
      "Certificate of origin", "Export documentation", "India-UK CETA", "India-UAE CEPA"],
    contactPoint: { "@type": "ContactPoint", telephone: deskPhone(), contactType: "customer service",
      areaServed: "IN", availableLanguage: ["English", "Hindi"] } };
  if (LEGAL_NAME()) o.legalName = LEGAL_NAME();
  if (contactEmail()) o.email = contactEmail();
  if (BUSINESS_ADDRESS()) o.address = BUSINESS_ADDRESS();
  return o;
}

export const ldScripts = (ld: Json[]) => ld.map((x) => `<script type="application/ld+json">${pyJson(x, { ascii: false })}</script>`).join("");

export interface LayoutOpts { jsonld?: Json[]; crumbs?: [string, string][]; alternates?: Record<string, string> | null; md?: boolean; lang?: string }

export function layout(title: string, description: string, p: string, body: string, o: LayoutOpts = {}): string {
  const SITE = siteUrl(), url = SITE + p, d = loadIndex();
  const crumbs = o.crumbs ?? [], md = o.md ?? true, lang = o.lang ?? "en-IN";
  const modified = d.verified || d.built || "";
  const pageLd = { "@context": "https://schema.org", "@type": "WebPage", "@id": url, url, name: title, description,
    inLanguage: lang, isPartOf: { "@type": "WebSite", "@id": SITE + "/#site", name: BRAND, url: SITE + "/" },
    publisher: { "@id": SITE + "/#org" }, dateModified: modified };
  const ld: Json[] = [orgLd(), pageLd];
  if (crumbs.length) {
    ld.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement:
      crumbs.map(([n, h], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: SITE + h })) });
  }
  ld.push(...(o.jsonld ?? []));
  const alt = Object.entries(o.alternates ?? {}).map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${SITE}${h}">`).join("");
  const mdlink = md ? `<link rel="alternate" type="text/markdown" href="${url}.md">` : "";
  const navCrumbs = crumbs.length ? crumbs.slice(0, -1).map(([n, h]) => `<a href="${h}">${e(n)}</a>`).join(" › ")
    + ` › <span>${e(crumbs[crumbs.length - 1][0])}</span>` : "";
  const wa = DESK_WHATSAPP() ? `<a class="pill ghost" href="https://wa.me/${DESK_WHATSAPP()}">WhatsApp</a>` : "";
  const phone = deskPhone(), biz = businessLine();
  return `<!doctype html><html lang="${lang.startsWith("hi") ? "hi-Latn" : "en-IN"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title><meta name="description" content="${e(description)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">${verificationMeta()}
<link rel="canonical" href="${url}">${alt}${mdlink}
<meta property="og:type" content="article"><meta property="article:modified_time" content="${modified}"><meta property="og:locale" content="en_IN"><meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}"><meta property="og:url" content="${url}">
<meta property="og:site_name" content="${BRAND}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/static/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#0B1F3A">
<meta property="og:image" content="${SITE}/static/brand/og-image.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${asset("site.css")}">
${ldScripts(ld)}
</head><body>
<header class="nav"><div class="wrap"><a class="brand" href="/" aria-label="${BRAND} home"><img src="/static/brand/mark.svg" alt="" width="30" height="30"><span>export<b>walla</b></span></a>
<nav><a href="/export-to">Countries</a><a href="/fta">Trade deals</a><a href="/guide">Guides</a><a href="/tools">Free tools</a><a href="/pricing">Pricing</a>
<a href="/hi" class="lang" hreflang="hi">हिंदी</a>${CTA_HTML}${mobileMenu()}</nav></div></header>
<main class="wrap page">${navCrumbs ? `<div class="crumbs">${navCrumbs}</div>` : ""}${body}</main>
<section class="wrap"><div class="cta-band"><div><h2>Check your own product in one minute</h2>
<p>Upload a GST certificate, an old invoice or a photo. Get your HS code, the best countries, the duty your buyer pays, buyers and a landed-cost quote. Free.</p></div>
<div class="cta-actions"><a class="pill go" href="/app">Start free →</a><a class="pill ghost" href="tel:${rep(phone, " ", "")}">Call ${e(phone)}</a>${wa}</div></div></section>
<footer class="foot"><div class="wrap">
<div><img src="/static/brand/logo.svg" alt="${BRAND}" width="170" height="36" style="display:block;margin-bottom:8px"><p>Export desk for Indian manufacturers: self-serve tools for HS code, markets, duty, buyers, quotes and documents, and a human desk from IEC to e-BRC. You stay the exporter of record.</p></div>
<div><b>Explore</b><a href="/export-to">Export by country</a><a href="/hs-code">HS codes and duty</a><a href="/fta">India's trade agreements</a><a href="/india-exports">Where India exports</a><a href="/guide">Export guides</a><a href="/hi/export-kaise-kare">Export kaise kare (Hinglish)</a><a href="/tools">Free export tools</a></div>
<div><b>About</b><a href="/about">About ${BRAND}</a><a href="/pricing">Pricing</a><a href="/contact">Contact</a><a href="/refund-policy">Refund policy</a><a href="/sources">Sources and licences</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/llms.txt">For AI agents (llms.txt)</a><a href="/docs">Public API</a><a href="/sitemap.xml">Sitemap</a></div>
</div><div class="wrap legal-line"><p>${e(NOT_AFFILIATED)} ${e(OGL)} Duty rates and rules are for guidance: check the linked official source before you sign a contract. <a href="/sources">Sources and licences</a>.</p>
${biz ? `<p>${biz}</p>` : ""}</div></footer>
${contactScript()}</body></html>`;
}

export const verified = (d: Json) =>
  `<p class="verified">Data verified ${e(d.verified || d.built)} against the official sources linked on this page.</p>`;

export function usIndiaRate(line: Json, hs6: string): string {
  const add = usLineAdd(line.code, hs6);
  const rate = line.general_rate || "–";
  return e(add && rate !== "–" ? `${rate} + ${fmtPyNum(add)}%` : rate);
}

/** str() of a number that Python holds as an int or a float; floats print with ".0" ("12.0"). */
export const fmtPyNum = (v: number, isFloat = false) => (isFloat && Number.isInteger(v) ? `${v}.0` : String(v));

// ---------------------------------------------------------------- guides and trade-deal links

export type Guide = Json;
const GUIDES: Map<string, Guide> = new Map(Object.entries(guidesJson as Json));
export const loadGuides = () => GUIDES;

/** Product guides that cover this HS code (same 6 or 4 digits), as links. */
export function guidesForHs(hs6: string): string {
  const out = [...GUIDES].filter(([, g]) => g.kind === "product" && (g.hs6 ?? []).some((h: string) => h === hs6 || h.slice(0, 4) === hs6.slice(0, 4)));
  return out.slice(0, 2).map(([sl, g]) => `<a href="/guide/${sl}">${e(g.h1)}</a>`).join(" · ");
}

export const guideLink = (slug: string, label: string) => (GUIDES.has(slug) ? `<a href="/guide/${slug}">${e(label)}</a>` : "");

export const ftasFor = (d: Json, iso3: string): Json[] => (Object.values(d.ftas ?? {}) as Json[]).filter((f) => f.countries.includes(iso3));

export const ftaLinks = (d: Json, iso3: string) => ftasFor(d, iso3).map((f) => `<a href="/fta/${f.slug}">${e(f.label)} explained</a>`).join(" · ");

/** Countries in the same trade deals first, then India's biggest markets. */
export function relatedCountries(d: Json, c: Json, k = 6): string {
  const same = ftasFor(d, c.iso3).flatMap((f) => f.countries.filter((i: string) => i !== c.iso3));
  const big = (d.india_exports?.partners ?? []).map((p: Json) => p.iso3);
  const out = [...new Set([...same, ...big])].filter((i) => i in d.countries && i !== c.iso3).slice(0, k);
  return out.map((i) => `<a href="/export-to/${d.countries[i].slug}">Export to ${e(d.countries[i].name)}</a>`).join(" · ");
}

export const faqLd = (faqs: [string, string][]) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity:
  faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });
