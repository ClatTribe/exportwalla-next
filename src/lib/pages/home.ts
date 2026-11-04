// The home page (English and the Hinglish /hi), the workspace and review shells, and the web manifest. The home page
// is the template src/templates/home.html with the data put in server-side, so crawlers see every country, cluster
// and step. Port of export-desk/app/seo.py (home_html, _prerender_home, clusters_html) and scripts/build_static.py.
import fs from "node:fs";
import path from "node:path";
import hinglish from "@/content/hinglish.json";
import site from "@/content/site.json";
import { siteUrl } from "../config";
import { loadIndex } from "../site";
import {
  BRAND, type Json, NOT_AFFILIATED, OGL, PRICE_FROM_INR, asset, businessLine, contactScript, e, flag, hasDeal, ldScripts,
  mobileMenu, orgLd, pct, rep, verificationMeta,
} from "./common";

const TEMPLATES = path.join(process.cwd(), "src", "templates");
const template = (name: string) => fs.readFileSync(path.join(TEMPLATES, name), "utf8");

export function clustersHtml(lang = "en"): string {
  const d = loadIndex();
  const P = d.products, C = d.countries, hi = lang === "hi";
  const acc = Object.fromEntries((site.CLUSTER_SECTORS as string[][]).map(([k, , c]) => [k, c]));
  const cards: string[] = [];
  for (const [sector, ico, towns, state, prod, hs] of site.CLUSTERS as string[][]) {
    const p = P.get(hs);
    if (!p) continue;
    const m = (p.markets as Json[]).find((x) => `${hs}|${x.iso3}` in d.pairs && x.india_pct !== null);
    let mk = "";
    if (m && m.iso3 in C) {
      const c = C[m.iso3];
      const deal = (m.mfn_pct || 0) > (m.india_pct || 0);
      mk = `<span>${hi ? "Sabse accha" : "Best market"}: <em>${flag(c.iso2)} ${e(c.name)}</em></span>`
        + `<span>${pct(m.india_pct)} duty</span>`
        + (deal ? `<span class="deal">${e(c.deal.split(" · ")[0])}</span>` : "");
    }
    cards.push(`<a class="cl" data-sector="${sector}" style="--acc:${acc[sector]}" href="/hs-code/${p.slug}">`
      + `<div class="top"><span class="ico">${ico}</span><div><b>${e(towns)}</b><small>${e(state)}</small></div></div>`
      + `<span class="prod">${e(prod)}</span><span class="hs">HS ${hs}</span>`
      + `<div class="mk">${mk}<span class="go">${hi ? "Dekhiye" : "See"} →</span></div></a>`);
  }
  const chips = `<button type="button" data-f="all" aria-pressed="true">${hi ? "Sabhi" : "All"}</button>`
    + (site.CLUSTER_SECTORS as string[][]).map(([k, n]) => `<button type="button" data-f="${k}" aria-pressed="false">${e(n)}</button>`).join("");
  const js = "<script>document.querySelector('.cfilter').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;"
    + "document.querySelectorAll('.cfilter button').forEach(x=>x.setAttribute('aria-pressed',x===b));"
    + "document.querySelectorAll('.clusters .cl').forEach(c=>c.hidden=b.dataset.f!=='all'&&c.dataset.sector!==b.dataset.f);});</script>";
  const more = '<p class="sub" style="margin-top:14px">' + (hi ? "Apna shehar nahi dikha? " : "Don't see your town? ")
    + '<a href="/hs-code">' + (hi ? "Sabhi 357 products dekhiye" : "Search all 357 products") + "</a> "
    + (hi ? "ya" : "or") + ' <a href="#" data-ask data-ask-step="cluster" data-ask-title="'
    + (hi ? "Aapka shehar kya banata hai?" : "Tell us what your town makes") + '">'
    + (hi ? "desk se poochhiye" : "ask the desk") + "</a>.</p>";
  return `<div class="cfilter" role="group" aria-label="Filter by sector">${chips}</div><div class="clusters">${cards.join("")}</div>${more}${js}`;
}

/** Put the country strip and all 13 journey steps in the HTML itself, for crawlers that don't run JavaScript. */
function prerenderHome(tpl: string, lang: string): string {
  const d = loadIndex();
  const chips = (Object.values(d.countries) as Json[]).map((c) => `<a class="cty${hasDeal(c) ? " deal" : ""}" href="/export-to/${c.slug}" title="${e(c.agreement)}">`
    + `<span class="f">${flag(c.iso2)}</span>${e(c.name)}${hasDeal(c) ? " <small>trade deal</small>" : ""}</a>`).join("");
  tpl = rep(tpl, "__CLUSTERS__", clustersHtml(lang));
  tpl = rep(tpl, '<div class="track" id="track"></div>', `<div class="track" id="track">${chips}${chips}</div>`);
  const a = tpl.indexOf("const STEPS = [") + "const STEPS = ".length;
  const b = tpl.indexOf("];", a) + 1;
  const steps = JSON.parse(tpl.slice(a, b).trim().replace(/,\s*\]$/, "]")) as [number, string, string, string, string, number, string[]][];
  const hi = lang === "hi";
  const kind: Record<string, string> = { self: hi ? "Khud karein, turant" : "Self-serve", desk: hi ? "Hamari desk" : "Our desk" };
  const items = steps.map(([n, , title, desc, k, sign]) => `<li><b>${n}. ${e(title)}</b> <small>(${kind[k]}${sign && !hi ? ", you or your CA sign" : sign ? ", aap ya CA sign karte hain" : ""})</small>`
    + ` ${e(desc)}</li>`).join("");
  const [n, , title, desc, , , outs] = steps[0];
  const first = `<div><h3>${n}. ${e(title)}</h3><p>${e(desc)}</p><a class="pill go" href="/app">Do it now, free →</a></div>`
    + `<div class="outbox"><h4>What you get</h4><ul>${outs.map((o) => `<li>${e(o)}</li>`).join("")}</ul></div>`;
  const summary = hi ? "Sabhi 13 steps ek nazar mein" : "All 13 steps at a glance";
  return rep(tpl, '<div class="detail" id="detail"></div>',
    `<div class="detail" id="detail">${first}</div>`
    + `<details class="allsteps"><summary>${summary}</summary><ol>${items}</ol></details>`);
}

export function homeHtml(lang = "en"): string {
  let tpl = template("home.html");
  let faqs = site.HOME_FAQ as [string, string][];
  if (lang === "hi") {
    for (const [en, hiText] of hinglish.HOME as [string, string][]) tpl = rep(tpl, en, hiText);
    const a = tpl.indexOf("const STEPS = ["), b = tpl.indexOf("];", tpl.indexOf("const STEPS = [")) + 2;
    tpl = tpl.slice(0, a) + hinglish.STEPS + tpl.slice(b);
    faqs = hinglish.FAQ as [string, string][];
  }
  const faq = faqs.map(([q, a]) => `<details><summary>${e(q)}</summary><p>${e(a)}</p></details>`).join("");
  tpl = prerenderHome(tpl, lang);
  const SITE = siteUrl();
  const ld = [
    orgLd(),
    { "@context": "https://schema.org", "@type": "WebSite", "@id": SITE + "/#site", name: BRAND, url: SITE + "/",
      inLanguage: "en-IN", publisher: { "@id": SITE + "/#org" } },
    { "@context": "https://schema.org", "@type": "Service", name: "Export desk for Indian manufacturers",
      serviceType: "Export documentation, market selection and customs facilitation", provider: { "@id": SITE + "/#org" },
      areaServed: "IN", offers: [{ "@type": "Offer", name: "Self-serve export tools", price: "0", priceCurrency: "INR" },
        { "@type": "Offer", name: "Export desk, per shipment (excluding GST)", price: rep(PRICE_FROM_INR(), ",", ""), priceCurrency: "INR" }] },
    { "@context": "https://schema.org", "@type": "FAQPage", inLanguage: lang === "hi" ? "hi-Latn" : "en-IN", mainEntity:
      faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  const biz = businessLine();
  tpl = rep(tpl, 'href="/static/style.css"', `href="${asset("style.css")}"`);
  for (const [a, b] of [["__SITE__", SITE], ["__JSONLD__", ldScripts(ld)], ["__VERIFY__", verificationMeta()], ["__PRICE__", e(PRICE_FROM_INR())],
    ["__NOTAFFILIATED__", e(NOT_AFFILIATED)], ["__OGL__", e(OGL)], ["__BUSINESS__", biz ? `<p>${biz}</p>` : ""],
    ["__CONTACT__", contactScript()], ["__MNAV__", mobileMenu(lang)], ['<div class="faq" id="faq"></div>', `<div class="faq" id="faq">${faq}</div>`]]) {
    tpl = rep(tpl, a, b);
  }
  return tpl;
}

/** The workspace (/app) and review console shells: static pages, with a versioned stylesheet URL and the contact script. */
export const shell = (name: "app.html" | "review.html") =>
  rep(rep(template(name), 'href="/static/style.css"', `href="${asset("style.css")}"`), "__CONTACT__", contactScript());

export const manifest = () => ({ name: BRAND, short_name: BRAND, start_url: "/app", display: "standalone",
  background_color: "#FAF7F2", theme_color: "#0B1F3A", description: "Export from India to the right country.",
  icons: [{ src: "/static/brand/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/static/brand/icon-512.png", sizes: "512x512", type: "image/png" }] });
