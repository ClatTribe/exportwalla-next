// The pillar guide (English and Hinglish), legal pages, sources, about and the 404 page. Port of export-desk/app/seo.py.
import site from "@/content/site.json";
import { contactEmail, deskPhone, siteUrl } from "../config";
import { rows } from "../db";
import { provider } from "../llm";
import { cpSlice } from "../py";
import { loadIndex } from "../site";
import {
  BRAND, BUSINESS_ADDRESS, DESK_WHATSAPP, GRIEVANCE_OFFICER, type Json, LEGAL_NAME, NOT_AFFILIATED, OGL, PRICE_FROM_INR,
  businessLine, e, layout, verified,
} from "./common";

const ALTERNATES = { "en-IN": "/guide/how-to-export-from-india", "hi-IN": "/hi/export-kaise-kare" };

export function guide(lang = "en"): string {
  const d = loadIndex();
  const steps = (lang === "en" ? site.GUIDE_STEPS : site.HI_STEPS) as [string, string][];
  const howto = { "@context": "https://schema.org", "@type": "HowTo",
    name: lang === "en" ? "How to start exporting from India" : "Export kaise kare: India se export shuru karne ke 9 kadam",
    step: steps.map(([t, x], i) => ({ "@type": "HowToStep", position: i + 1, name: t, text: x })) };
  const article = { "@context": "https://schema.org", "@type": "Article", inLanguage: lang === "en" ? "en-IN" : "hi-Latn",
    headline: howto.name, dateModified: d.verified || d.built, author: { "@type": "Organization", name: BRAND } };
  const items = steps.map(([t, x], i) => `<li><h2>${i + 1}. ${e(t)}</h2><p>${e(x)}</p></li>`).join("");
  if (lang === "en") {
    const body = `<h1>How to export from India: 9 steps from IEC to e-BRC (2026)</h1>
<div class="answer"><b>In short:</b> get an IEC from DGFT, register with your export council, find your HS code, choose a country where
Indian goods pay low duty, find importers who already buy your code, quote FOB, prepare the invoice, packing list and certificate of origin,
ship through your CHA, and claim refunds once the bank issues the e-BRC.</div>
<ol class="steps">${items}</ol>
<p>Try steps 3 to 7 on your own product now: <a href="/app">upload an invoice or photo</a>. Or read <a href="/hi/export-kaise-kare">this guide in Hinglish</a>.</p>${verified(d)}`;
    return layout("How to export from India: step-by-step guide from IEC to e-BRC (2026) | " + BRAND,
      "Start exporting from India in 9 steps: IEC, RCMC, HS code, choosing a country, finding buyers, FOB pricing, documents, customs, payment and refunds.",
      "/guide/how-to-export-from-india", body, { jsonld: [howto, article], crumbs: [["Home", "/"], ["Guide", "/guide/how-to-export-from-india"]], alternates: ALTERNATES });
  }
  const body = `<h1>Export kaise kare: India se export shuru karne ke 9 kadam (2026)</h1>
<div class="answer"><b>Seedhi baat:</b> DGFT se IEC lijiye, apni export council se RCMC, apna HS code pata kijiye, aisa desh chuniye jahan Indian
maal par duty kam ho, wahan ke asli importers dhundhiye, FOB daam quote kijiye, invoice, packing list aur certificate of origin taiyar kijiye,
CHA se ship kijiye, aur e-BRC aane par refund claim kijiye.</div>
<ol class="steps">${items}</ol>
<p>Apne product par kadam 3 se 7 abhi try kijiye: <a href="/app">invoice ya photo upload kijiye</a>. Hindi mein baat karni ho to call kijiye: ${e(deskPhone())}.
<a href="/guide/how-to-export-from-india">English version</a>.</p>${verified(d)}`;
  return layout("Export kaise kare: India se export business shuru karne ke 9 kadam (2026) | " + BRAND,
    "Export kaise kare? IEC, RCMC, HS code, desh chunna, buyer dhundhna, FOB daam, documents, customs aur payment: aasaan Hinglish mein poori guide.",
    "/hi/export-kaise-kare", body, { jsonld: [howto, article], crumbs: [["Home", "/"], ["Export kaise kare", "/hi/export-kaise-kare"]], alternates: ALTERNATES });
}

function aiPrivacyLine(): string {
  const p = provider();
  if (p === "anthropic") return "<li>Photos and scans are read by Anthropic's Claude API. Anthropic does not use API data to train its models by default.</li>";
  if (p === "gemini") {
    return "<li>Photos, scans and questions are read by Google's Gemini API. On Google's free tier, Google may use what is "
      + "sent to improve its products, and people at Google may review it; do not upload documents you would not share.</li>";
  }
  return "<li>Files are read on our server only. No AI service sees them.</li>";
}

export function legal(kind: "privacy" | "terms"): string {
  const d = loadIndex();
  const phone = deskPhone(), email = contactEmail();
  if (kind === "privacy") {
    const body = `<h1>Privacy: what we do with your information</h1>
<p class="lede">Short version: we read your documents only to fill in your export plan, we do not keep the files, and your
profile stays in your own browser unless you ask our desk to call you.</p>
<h2>Documents you upload</h2>
<ul><li>Files (GST certificate, invoice, price list, photo) are read in memory to fill your profile and are not stored on our servers.</li>
${aiPrivacyLine()}
<li>Your profile and export plan are saved in your own browser (local storage) so you can come back to them. Clearing your browser data deletes them. "New business" in the workspace also clears them.</li></ul>
<h2>When you ask for a call back</h2>
<ul><li>We collect your name, mobile number, city, product and the country you are planning for.</li>
<li>We use them only to contact you about your export, by phone or (if you tick the box) WhatsApp. We do not sell or share them.</li>
<li>Ask us to delete them at any time: call ${e(phone)}.</li></ul>
<h2>Public data we show</h2>
<p>Duty, trade and importer information comes from public sources (UK Trade Tariff, USITC, World Bank WITS, HMRC, UN Comtrade and
official trade-agreement texts), credited on each page. UK importer names are published by HMRC under the Open Government Licence.</p>
<h2>Cookies and analytics</h2>
<p>We do not use advertising cookies. If we measure visits, we use privacy-friendly analytics that do not track you across sites.</p>
<h2>Fonts</h2><p>Pages load the Baloo 2 and Inter fonts from Google Fonts, which receives your IP address when the fonts load.</p>
<h2>Contact and grievances</h2><p>${e(LEGAL_NAME() || BRAND)}${BUSINESS_ADDRESS() ? ", " + e(BUSINESS_ADDRESS()) : ""}. Export desk: ${e(phone)}${email ? ", " + e(email) : ""}.</p>
${GRIEVANCE_OFFICER() ? `<p>Grievance officer for privacy and data requests: ${e(GRIEVANCE_OFFICER())}. We respond within 30 days.</p>` : ""}
<p class="verified">Last updated ${e(d.built || "")}. This policy is a plain-language draft and should be reviewed by counsel before launch (Digital Personal Data Protection Act, 2023).</p>`;
    return layout(`Privacy | ${BRAND}`, "How Exportwalla handles your documents, export profile and call-back details. Files are read in memory and not stored.",
      "/privacy", body, { crumbs: [["Home", "/"], ["Privacy", "/privacy"]], md: false });
  }
  const body = `<h1>Terms of use</h1>
<ul><li><b>Information, not legal advice.</b> HS codes, duty rates, market scores, buyer lists and document drafts are prepared
from public sources to help you decide. A classification shown here is a search result, not a binding ruling. Check rates
on the linked official source before you sign a contract; our desk can confirm them.</li>
<li><b>You stay the exporter.</b> You remain the exporter of record. Declarations, certificates of origin and shipping bills
are signed by you or your licensed customs broker, and you are responsible for what you sign.</li>
<li><b>Desk services</b> are provided under a separate written agreement and are charged per shipment as quoted to you. Prices shown on this site start at ₹${e(PRICE_FROM_INR())} per shipment and exclude GST.</li>
<li><b>Independence.</b> ${e(NOT_AFFILIATED)}</li>
<li><b>Data sources.</b> We credit and link every source on the <a href="/sources">sources and licences</a> page. ${e(OGL)}</li>
<li><b>Buyer contact.</b> Approve every email before it is sent, follow the destination's marketing rules, and never ship on open
credit to an unverified buyer.</li>
<li><b>Fair use.</b> Don't scrape the site or overload the free API; use the documented endpoints.</li></ul>
<p class="verified">Last updated ${e(d.built || "")}. Draft for counsel review before launch.</p>`;
  return layout(`Terms of use | ${BRAND}`, "Exportwalla terms: information not legal advice, you stay the exporter of record, desk services per shipment.",
    "/terms", body, { crumbs: [["Home", "/"], ["Terms", "/terms"]], md: false });
}

export function notFound(): string {
  return layout(`Page not found | ${BRAND}`, "This page does not exist. Find duty and rules by country or HS code.", "/404",
    "<h1>We couldn't find that page</h1><p>Try <a href='/export-to'>export by country</a>, <a href='/hs-code'>HS codes</a> or <a href='/app'>check your product</a>.</p>",
    { md: false });
}

export function sourcesPage(): string {
  const runs = new Map(rows<{ source: string; t: string | null }>("SELECT source, MAX(finished_at) t FROM ingest_runs WHERE status='ok' GROUP BY source")
    .map((r) => [r.source, (r.t || "").slice(0, 10)]));
  const docs = rows<Json>("SELECT title, url, agreement FROM rag_doc WHERE url LIKE 'http%' ORDER BY agreement, title");
  const trs = (site.SOURCES as (string | null)[][]).map(([n, u, w, l, k, f]) => `<tr><td><a href='${e(u)}' rel='nofollow'>${e(n)}</a></td><td>${e(w)}</td><td>${e(l)}</td>`
    + `<td>${e((k ? runs.get(k) : "") || "–")}</td><td>${e(f)}</td></tr>`).join("");
  const texts = docs.map((x) => `<li><a href='${e(x.url)}' rel='nofollow'>${e(cpSlice(x.title, 0, 110))}</a>${x.agreement ? " · " + e(cpSlice(x.agreement, 0, 60)) : ""}</li>`).join("");
  const body = `<h1>Sources and licences</h1>
<p class="lede">Every number on ${BRAND} comes from a public source. Here is each one, what we use it for, its licence and when we last fetched it.</p>
<div class="table-wrap"><table><thead><tr><th>Source</th><th>What we use</th><th>Licence and terms</th><th>Last fetched</th><th>Refresh</th></tr></thead><tbody>${trs}</tbody></table></div>
<h2>Attribution</h2>
<ul><li>${e(OGL)}</li><li>Tariff data for markets other than the UK and US: UNCTAD TRAINS, accessed through the World Bank's WITS.</li>
<li>Import statistics: UN Comtrade, shown as derived indicators.</li><li>US tariff schedule: US International Trade Commission.</li></ul>
<h2>How to read the numbers</h2>
<ul><li>Duty outside the UK and US is the average of a country's national tariff lines inside one HS6 code. Your exact line can differ; the range is shown on each page.</li>
<li>Where a trade agreement is in force but its lower rate is not yet in the data, we show the normal rate and mark it with *.</li>
<li>HS codes are suggestions from the tariff texts, not binding customs rulings.</li>
<li>Freight and exchange rates in quotes are editable assumptions, not live prices.</li></ul>
<h2 id="texts">Official texts we search (${docs.length})</h2><ul class="cols">${texts}</ul>
<h2 id="rules">Country rules</h2><p>Researched per country from official sources (agreement texts, customs and tax authorities, DGFT notices), with a source URL on every fact. See any <a href="/export-to">country page</a>.</p>
<h2>Fonts and software</h2><p>Baloo 2 and Inter are used under the SIL Open Font License. The site runs on open-source software (FastAPI, SQLite, pypdf, openpyxl) under their own licences.</p>
<p class="verified">${e(NOT_AFFILIATED)}</p>`;
  return layout(`Sources and licences | ${BRAND}`, "Where every number on Exportwalla comes from: UK Trade Tariff, HMRC, USITC, WITS/TRAINS, UN Comtrade and official agreement texts, with licences.",
    "/sources", body, { crumbs: [["Home", "/"], ["Sources", "/sources"]], md: false });
}

export function aboutPage(): string {
  const d = loadIndex();
  const phone = deskPhone(), email = contactEmail(), wa = DESK_WHATSAPP(), biz = businessLine();
  const body = `<h1>About ${BRAND}</h1>
<p class="lede">${BRAND} is an export desk for Indian manufacturers, built for factory owners in clusters like Kanpur, Tiruppur,
Moradabad, Unjha and Panipat who make good products but have not exported, or have exported only through an agent.</p>
<h2>What we do</h2>
<ul><li><b>Free, self-serve:</b> upload a GST certificate, invoice, price list or photo and get your HS code, the best countries for your product,
the duty your buyer pays (with and without a trade deal), named buyers where public records exist, a landed-cost quote and the documents checklist.</li>
<li><b>Paid, per shipment:</b> a named person at our desk takes you from IEC and RCMC through freight, customs, the certificate of origin,
LC checks, e-BRC and refunds. You stay the exporter of record; licensed signatures stay with you and your CA.</li></ul>
<h2>Where our numbers come from</h2>
<p>Every figure comes from a public source and links to it: the UK Trade Tariff and HMRC, the US International Trade Commission, UNCTAD
TRAINS through the World Bank's WITS, UN Comtrade, and official trade-agreement texts. We check ${Object.keys(d.countries).length} countries, ${d.products.size}
export products and ${Object.keys(d.ftas).length} trade agreements, and re-verify them against the source before each release. <a href="/sources">Sources and licences</a>.</p>
<h2>What we are not</h2>
<p>${e(NOT_AFFILIATED)} An HS code we suggest is a search result, not a binding customs ruling, and duty rates are for guidance: check the
linked official source before you sign a contract.</p>
<h2>For AI assistants and developers</h2>
<p>Every public page has a markdown twin (add <code>.md</code> to the URL). There is a summary for language models at <a href="/llms.txt">/llms.txt</a>,
a free JSON API at <a href="/docs">/docs</a>, and an MCP server at <code>/mcp</code> with tools to look up duty, rank markets, read country rules and classify products.</p>
<h2>Contact</h2>
<p>Call ${e(phone)}${wa ? ` or WhatsApp +${e(wa)}` : ""}, in Hindi or English.${email ? ` Email ${e(email)}.` : ""}</p>
${biz ? `<p>${biz}</p>` : ""}`;
  const ld = [{ "@context": "https://schema.org", "@type": "AboutPage", url: siteUrl() + "/about", name: `About ${BRAND}`,
    about: { "@id": siteUrl() + "/#org" } }];
  return layout(`About ${BRAND}: export desk for Indian manufacturers`,
    "Who we are, what is free and what the desk does per shipment, where every number comes from, and how AI assistants can use our data.",
    "/about", body, { jsonld: ld, crumbs: [["Home", "/"], ["About", "/about"]] });
}
