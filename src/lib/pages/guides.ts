// Guides (English and Hinglish) and the guides hub. Content lives in src/content/guides.json. Port of
// export-desk/app/pages.py (guide_page, guides_hub and their helpers).
import site from "@/content/site.json";
import { siteUrl } from "../config";
import { S, cpSlice } from "../py";
import { loadIndex } from "../site";
import {
  BRAND, type Guide, type Json, askBox, e, ftasFor, hasDeal, layout, loadGuides, pct, rep,
} from "./common";

export const TOOLS = site.TOOLS as [string, string, string][];

/** Escape text, then allow **bold** and [label](url). */
export function md(text: string): string {
  let t = e(text);
  t = t.replace(/\*\*(.+?)\*\*/g, (_, x) => `<b>${x}</b>`);
  return t.replace(new RegExp(`\\[([^\\]]+)\\]\\(([^)${S}]+)\\)`, "gu"), (_, label, url) =>
    `<a href="${url}"${url.startsWith("/") ? "" : ' rel="noopener"'}>${label}</a>`);
}

export const plain = (text: string) => rep(text.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, x) => x), "**", "");

const guideUrl = (slug: string, lang = "en") => (lang === "hi" ? `/hi/guide/${slug}` : `/guide/${slug}`);

function section(s: Json): string {
  let out = `<h2>${md(s.h2)}</h2>`;
  out += (s.paras ?? []).map((p: string) => `<p>${md(p)}</p>`).join("");
  if (s.steps?.length) out += '<ol class="howto">' + s.steps.map((x: string) => `<li>${md(x)}</li>`).join("") + "</ol>";
  if (s.bullets?.length) out += "<ul>" + s.bullets.map((x: string) => `<li>${md(x)}</li>`).join("") + "</ul>";
  if (s.table && Object.keys(s.table).length) {
    const t = s.table;
    out += '<div class="table-wrap"><table><thead><tr>' + t.head.map((h: string) => `<th>${md(h)}</th>`).join("") + "</tr></thead><tbody>"
      + t.rows.map((row: string[]) => "<tr>" + row.map((c) => `<td>${md(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>";
  }
  return out;
}

/** Live tables for a product guide: best markets with duty for Indian goods, the deals behind them, the HS codes. */
function productData(g: Guide): string {
  const d = loadIndex();
  const P = d.products, C = d.countries;
  const rowsOut: string[] = [], deals = new Map<string, Json>();
  for (const h of (g.hs6 ?? []).slice(0, 6)) {
    const p = P.get(h);
    if (!p) continue;
    let shown = 0;
    for (const m of p.markets as Json[]) {
      if (!(`${h}|${m.iso3}` in d.pairs) || m.india_pct === null) continue;
      const c = C[m.iso3];
      rowsOut.push(`<tr><td><a href="/export/${p.slug}/${c.slug}">${e(cpSlice(p.name, 0, 60))}</a> <small>HS ${h}</small></td>
<td>${e(c.name)}</td><td class="num"><b>${pct(m.india_pct)}</b>${m.pref_pending ? "*" : ""}${m.iso3 === "USA" && (m.india_pct || 0) > (m.mfn_pct || 0) ? "†" : ""}</td><td class="num">${pct(m.mfn_pct)}</td></tr>`);
      for (const f of ftasFor(d, m.iso3)) if (f.status === "in_force" && hasDeal(c)) deals.set(f.slug, f);
      shown++;
      if (shown === 3) break;
    }
  }
  if (!rowsOut.length) return "";
  const codes = (g.hs6 ?? []).filter((h: string) => P.has(h)).map((h: string) => `<li><a href="/hs-code/${P.get(h).slug}">HS ${h}: ${e(P.get(h).name)}</a></li>`).join("");
  const dealLinks = [...deals.values()].map((f) => `<a href="/fta/${f.slug}">${e(f.label)}</a>`).join(" · ");
  const all = rowsOut.join("");
  return `<h2>Best markets and the duty Indian goods pay</h2>
<p>The top three markets for each product, ranked on demand, growth, India's foothold and duty, from our verified data. Click a row for the
landed cost, documents and buyers.</p>
<div class="table-wrap"><table><thead><tr><th>Product</th><th>Country</th><th>Duty on Indian goods</th><th>Normal duty</th></tr></thead>
<tbody>${all}</tbody></table></div>
<p class="src">* A trade deal is in force but its lower rate is not yet in our tariff data, so the normal rate is shown.
${all.includes("†") ? "† Includes the 10% US Section 301 duty on goods of India, in force since 24 July 2026." : ""}</p>
${dealLinks ? `<p><b>Trade deals that cut the duty here:</b> ${dealLinks}</p>` : ""}
<h2>HS codes covered</h2><ul class="cols">${codes}</ul>`;
}

function pathLabel(p: string): string {
  const labels: Record<string, string> = { "/app": "Free workspace", "/pricing": "Pricing", "/contact": "Talk to the desk", "/fta": "India's trade agreements",
    "/india-exports": "Where India exports", "/export-to": "Export by country", "/hs-code": "HS codes and duty",
    "/tools": "Free export tools", "/guide": "All export guides", "/guide/how-to-export-from-india": "How to export from India" };
  for (const [s, n] of TOOLS) labels[`/tools/${s}`] = n;
  if (Object.hasOwn(labels, p)) return labels[p];
  const d = loadIndex();
  if (p.startsWith("/fta/")) {
    const f = (Object.values(d.ftas) as Json[]).find((x) => x.slug === p.slice(5));
    return f ? `${f.label} explained` : p;
  }
  if (p.startsWith("/export-to/")) {
    const c = (Object.values(d.countries) as Json[]).find((x) => x.slug === p.slice(11));
    return c ? `Export to ${c.name}` : p;
  }
  if (p.startsWith("/hs-code/")) {
    const pr = d.products.get(p.slice(9, 15));
    return pr ? `HS ${pr.hs6}: ${pr.name}` : p;
  }
  return p;
}

const GUIDE_ASK = site.GUIDE_ASK as unknown as Record<string, [string, string, string]>;
const productName = (g: Guide) => rep(rep(plain(g.h1), "How to export ", ""), " from India", "");

export function guidePage(slug: string, lang = "en"): string | null {
  const gs = loadGuides();
  const g = gs.get(slug);
  if (!g || (lang === "hi" && !g.hi)) return null;
  const hi = lang === "hi";
  const v: Json = hi ? { ...g, ...g.hi } : g;
  const sections: Json[] = v.sections;
  const bodyParts: string[] = [];
  sections.forEach((s, i) => {
    bodyParts.push(section(s));
    if (i === 0 && g.kind === "product") bodyParts.push(productData(g));
  });
  const facts = ((v.facts ?? g.facts ?? []) as [string, string][]).map(([k, x]) => `<div><span>${e(k)}</span><b>${md(x)}</b></div>`).join("");
  const faq = (v.faqs as [string, string][]).map(([q, a]) => `<details open><summary>${md(q)}</summary><p>${md(a)}</p></details>`).join("");
  const sources = (g.sources as [string, string][]).map(([n, u]) => `<li><a href="${e(u)}" rel="noopener">${e(n)}</a></li>`).join("");
  const rel = (g.related ?? []).map((r: string) => {
    if (gs.has(r)) {
      const other = gs.get(r)!;
      return `<a href="${guideUrl(r, other.hi ? lang : "en")}">${e((hi && other.hi ? other.hi : other).h1)}</a>`;
    }
    return `<a href="${r}">${e(pathLabel(r))}</a>`;
  });
  const other = g.hi ? `<p>${hi ? "English version" : "Yeh guide Hinglish mein padhiye"}: <a href="${guideUrl(slug, hi ? "en" : "hi")}" hreflang="${hi ? "en" : "hi"}">`
    + `${e(hi ? g.h1 : g.hi.h1)}</a></p>` : "";
  const cta = hi ? '<p><b>Apne product par try kijiye:</b> <a href="/app">invoice ya photo upload kijiye</a> aur HS code, desh, duty, buyers aur quote paiye. Free.</p>'
    : '<p><b>Try it on your own product:</b> <a href="/app">upload an invoice or photo</a> to get your HS code, best countries, duty, buyers and a quote. Free.</p>';
  const [step, at, ax] = GUIDE_ASK[slug] ?? [g.kind === "product" ? "product" : "general",
    g.kind === "product" ? `Exporting ${productName(g)}?` : "Ask the desk",
    "Tell us your product. We help with markets, buyers, documents and shipping."];
  const ask = askBox(at, ax, step, { product: g.kind === "product" ? productName(g) : "", label: hi ? "Poochhiye" : "Ask the desk" });
  const body = `<h1>${md(v.h1)}</h1>
<div class="answer"><b>${hi ? "Seedhi baat" : "In short"}:</b> ${md(v.answer)}</div>
${facts ? `<div class="facts">${facts}</div>` : ""}
${bodyParts.join("")}
${cta}
${ask}
<h2>${hi ? "Aksar pooche jaane wale sawal" : "Questions"}</h2>${faq}
<h2>${hi ? "Sarkari sources" : "Official sources"}</h2><ul>${sources}</ul>
${rel.length ? `<h2>${hi ? "Aage padhiye" : "Read next"}</h2><p class="rel">${rel.join(" · ")}</p>` : ""}
${other}
<p class="verified">${hi ? "Jaankari check ki gayi" : "Facts checked"} ${e(g.checked)} against the official sources above. Rules change: check the source before you file.</p>`;
  const url = guideUrl(slug, lang), SITE = siteUrl();
  const article = { "@context": "https://schema.org", "@type": "Article", headline: cpSlice(plain(v.h1), 0, 110), description: v.description,
    inLanguage: hi ? "hi-Latn" : "en-IN", dateModified: g.checked, datePublished: g.checked,
    author: { "@id": SITE + "/#org" }, publisher: { "@id": SITE + "/#org" }, mainEntityOfPage: SITE + url,
    citation: (g.sources as [string, string][]).map(([, u]) => u) };
  const ld: Json[] = [article, { "@context": "https://schema.org", "@type": "FAQPage", mainEntity:
    (v.faqs as [string, string][]).map(([q, a]) => ({ "@type": "Question", name: plain(q), acceptedAnswer: { "@type": "Answer", text: plain(a) } })) }];
  const steps = sections.find((s) => s.steps?.length);
  if (steps) {
    ld.push({ "@context": "https://schema.org", "@type": "HowTo", name: plain(steps.h2),
      step: steps.steps.map((x: string, i: number) => ({ "@type": "HowToStep", position: i + 1, text: plain(x) })) });
  }
  const alternates = g.hi ? { "en-IN": guideUrl(slug), "hi-IN": guideUrl(slug, "hi") } : null;
  const title: string = v.title;
  return layout([...title].length + [...BRAND].length + 3 <= 70 ? `${title} | ${BRAND}` : title, v.description, url, body,
    { jsonld: ld, crumbs: [["Home", "/"], ["Guides", "/guide"], [cpSlice(plain(v.h1), 0, 40), url]], alternates, lang: hi ? "hi-Latn" : "en-IN" });
}

export function guidesHub(): string {
  const gs = loadGuides();
  const card = (s: string) => {
    const g = gs.get(s)!;
    return `<a class="gcard" href="/guide/${s}"><b>${e(g.h1)}</b><small>${e(cpSlice(plain(g.answer), 0, 150))}…</small>`
      + `${g.hi ? "<i>Hinglish bhi</i>" : ""}</a>`;
  };
  const GROUPS = site.GUIDE_GROUPS as [string, string[]][];
  const groups = GROUPS.filter(([, slugs]) => slugs.some((s) => gs.has(s)))
    .map(([name, slugs]) => `<h2>${e(name)}</h2><div class="gcards">${slugs.filter((s) => gs.has(s)).map(card).join("")}</div>`).join("");
  const prods = (site.PRODUCT as string[]).filter((s) => gs.has(s)).map(card).join("");
  const body = `<h1>Export guides for Indian manufacturers</h1>
<p class="lede">Plain-language guides to every step of exporting from India, from your IEC to your refunds, checked against the official
sources. Procedure guides are in English and Hinglish.</p>
<div class="answer"><b>New to exporting?</b> Start with <a href="/guide/how-to-export-from-india">how to export from India in 9 steps</a>
(<a href="/hi/export-kaise-kare">Hinglish</a>), then take the <a href="/tools/export-readiness">3-minute readiness check</a> to see what to do first.</div>
${groups}
${prods ? `<h2>Guides by product</h2><div class="gcards">${prods}</div>` : ""}
<h2>Free tools</h2><p>${TOOLS.map(([s, n]) => `<a href="/tools/${s}">${e(n)}</a>`).join(" · ")}</p>`;
  const items = [...GROUPS.flatMap(([, ss]) => ss.filter((s) => gs.has(s))), ...(site.PRODUCT as string[]).filter((s) => gs.has(s))];
  const ld = [{ "@context": "https://schema.org", "@type": "ItemList", name: "Export guides", itemListElement:
    items.map((s, i) => ({ "@type": "ListItem", position: i + 1, name: gs.get(s)!.h1, url: `${siteUrl()}/guide/${s}` })) }];
  return layout("Export guides: IEC, HS codes, CoO, GST refund, LC and more | " + BRAND,
    "Step-by-step export guides for Indian manufacturers: IEC, RCMC, HS codes, certificate of origin, GST LUT, RoDTEP, pricing, LC, ECGC and shipping.",
    "/guide", body, { jsonld: ld, crumbs: [["Home", "/"], ["Guides", "/guide"]] });
}
