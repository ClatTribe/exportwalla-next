// Free tools, pricing, contact and refund pages. Port of export-desk/app/pages.py. The tools' page scripts live in
// src/templates/tools/*.js with __TOKENS__ for the data they need.
import fs from "node:fs";
import path from "node:path";
import pagesJson from "@/content/pages.json";
import site from "@/content/site.json";
import { contactEmail, deskPhone, siteUrl } from "../config";
import { pyJson as pyJsonDumps } from "../py";
import { loadIndex } from "../site";
import {
  BRAND, DESK_WHATSAPP, FX_AS_OF, GRIEVANCE_OFFICER, type Json, PRICE_FROM_INR, askBox, businessLine, clip, e, layout, rep, sortBy,
} from "./common";
import { TOOLS, md, plain } from "./guides";

const TOOL_JS = pagesJson.TOOL_JS, LEAD_FORM = pagesJson.LEAD_FORM;
const script = (name: string, data: Record<string, string>) => {
  let js = fs.readFileSync(path.join(process.cwd(), "src", "templates", "tools", name), "utf8");
  for (const [k, v] of Object.entries(data)) js = rep(js, k, v);
  return js;
};

function countriesOptions(selected = "GBR"): string {
  const cs = sortBy(Object.values(loadIndex().countries) as Json[], (c) => c.name);
  return cs.map((c) => `<option value="${c.iso3}"${c.iso3 === selected ? " selected" : ""}>${e(c.name)}</option>`).join("");
}

const toolLd = (slug: string, name: string, desc: string) => ({ "@context": "https://schema.org", "@type": "WebApplication", name: `${name} (${BRAND})`,
  url: `${siteUrl()}/tools/${slug}`, description: desc, applicationCategory: "BusinessApplication", operatingSystem: "Any", isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "INR" }, provider: { "@id": siteUrl() + "/#org" } });

const faqLdPlain = (faqs: [string, string][]) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity:
  faqs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: plain(a) } })) });

const faqHtml = (faqs: [string, string][]) => faqs.map(([q, a]) => `<details><summary>${e(q)}</summary><p>${md(a)}</p></details>`).join("");

const otherTools = (skip: string) => "<h2>More free tools</h2><p>" + TOOLS.filter(([s]) => s !== skip).map(([s, n]) => `<a href="/tools/${s}">${e(n)}</a>`).join(" · ") + "</p>";

const productSlugs = () => new Map([...loadIndex().products].map(([h, p]) => [h, p.slug]));

export function toolsHub(): string {
  const cards = TOOLS.map(([s, n, x]) => `<a class="gcard" href="/tools/${s}"><b>${e(n)}</b><small>${e(x)}</small><i>Free, no sign-up</i></a>`).join("");
  const body = `<h1>Free export tools for Indian manufacturers</h1>
<p class="lede">Four tools that answer the first questions every exporter has. No sign-up, no payment, and every number links to its
official source.</p>
<div class="gcards">${cards}</div>
<h2>Want all of it in one go?</h2>
<p>The <a href="/app">free workspace</a> reads your GST certificate, invoice or a photo and gives you the HS code, the best countries, the duty,
named buyers where public records exist, a landed-cost quote and your documents checklist in about a minute.</p>`;
  const ld = [{ "@context": "https://schema.org", "@type": "ItemList", name: "Free export tools", itemListElement:
    TOOLS.map(([s, n], i) => ({ "@type": "ListItem", position: i + 1, name: n, url: `${siteUrl()}/tools/${s}` })) }];
  return layout(`Free export tools: HS code, import duty, export price | ${BRAND}`,
    "Free tools for Indian exporters: HS code finder, import duty checker for 66 countries, FOB/CIF export price calculator and an export readiness check.",
    "/tools", body, { jsonld: ld, crumbs: [["Home", "/"], ["Tools", "/tools"]] });
}

export function toolHsFinder(): string {
  const d = loadIndex();
  const popular = ["640391", "420221", "610910", "630260", "741980", "090931", "100630", "030617", "940360", "570110"];
  const pop = popular.filter((h) => d.products.has(h)).map((h) => `<li><a href="/hs-code/${d.products.get(h).slug}">HS ${h}: ${e(d.products.get(h).name)}</a></li>`).join("");
  const faqs: [string, string][] = [["What is an HS code?", "The Harmonized System code is a 6-digit number that classifies a product the same way in about 200 countries. India adds two digits (ITC-HS) for the shipping bill, and the buyer's country adds its own digits for its tariff."],
    ["Is the code from this tool final?", "No. It is a search over the official tariff descriptions, not a customs ruling. Check the description against your product, and if two codes look possible, ask your CHA or our desk. A wrong code means the wrong duty."],
    ["Which code goes on my invoice?", "The 8-digit ITC-HS code on Indian export documents. Its first six digits are the HS code this tool finds. If your old invoices already carry a code, use that."],
    ["Why does the HS code matter so much?", "It decides the duty your buyer pays, whether a trade deal applies, which product rules and tests apply, and which export incentives (RoDTEP, drawback) you can claim. See [HS codes for export](/guide/hs-code-for-export)."]];
  const body = `<h1>HS code finder for Indian exports</h1>
<p class="lede">Describe your product in plain words, in English or common Hindi trade words (jeera, haldi, chawal). You get the most likely
6-digit HS code with its official description, and the next closest codes.</p>
<form class="tool" id="hsForm"><label>What do you make?<input id="q" name="q" required maxlength="200" placeholder="e.g. men's leather Chelsea boots with rubber sole"></label>
<button class="pill go" type="submit">Find my HS code</button></form>
<div id="hsOut" class="toolout" aria-live="polite"></div>
${askBox("Not sure about the code?", "Send us your product and a photo. We confirm the HS code, free.", "hs-code", { label: "Ask the desk" })}
<h2>How to describe your product</h2>
<ul><li><b>Say what it is made of:</b> leather, cotton, brass, stainless steel.</li><li><b>Say what it is for:</b> handbag, bed sheet, kitchen utensil.</li>
<li><b>Add the form it ships in:</b> frozen, dried, ground, knitted, unworked.</li><li>Avoid brand names and sizes; they do not change the code.</li></ul>
<h2>Popular HS codes</h2><ul class="cols">${pop}</ul>
<h2>Questions</h2>${faqHtml(faqs)}
${otherTools("hs-code-finder")}
${TOOL_JS}
${script("hs-code-finder.html", { __PAGES__: pyJsonDumps(productSlugs()) })}`;
  const desc = "Find the HS code for your product in seconds: describe it in plain words and get the 6-digit code, the official description and close alternatives. Free.";
  return layout(`HS code finder for Indian exporters (free) | ${BRAND}`, desc, "/tools/hs-code-finder", body,
    { jsonld: [toolLd("hs-code-finder", "HS code finder", desc), faqLdPlain(faqs)], crumbs: [["Home", "/"], ["Tools", "/tools"], ["HS code finder", "/tools/hs-code-finder"]] });
}

export function toolImportDuty(): string {
  const d = loadIndex();
  const faqs: [string, string][] = [["Whose duty is this?", "Import duty is paid by the buyer (or whoever imports the goods) in the destination country. It still decides whether your price works, so know it before you quote."],
    ["Why are there two rates?", "The normal (MFN) rate applies to goods from any WTO member. A trade deal like India–UK CETA or India–UAE CEPA gives Indian goods a lower rate if you send the right proof of origin. See [certificate of origin](/guide/certificate-of-origin)."],
    ["How exact is the rate?", "For the UK and the US it is the national tariff line. For other countries it is the average of that country's lines inside the 6-digit code, from WTO/UNCTAD data via the World Bank; your exact line can differ. Each result links to its source."],
    ["Is duty the only tax?", "No. Most countries also charge VAT or GST on the value plus duty, which the importer usually reclaims. Use the [export price calculator](/tools/export-price-calculator) for the full landed cost."]];
  const deals = (Object.values(d.ftas) as Json[]).filter((f) => f.status === "in_force" && f.slug !== "gstp").map((f) => `<a href="/fta/${f.slug}">${e(f.label)}</a>`).join(" · ");
  const body = `<h1>Import duty checker: what your buyer pays on Indian goods</h1>
<p class="lede">Pick a country and enter your HS code (or describe the product). See the duty on Indian goods, the normal rate, the trade deal
behind the difference and the official source. 66 countries.</p>
<form class="tool" id="dutyForm">
<label>HS code (6 digits) or product<input id="prod" required maxlength="200" placeholder="e.g. 640391 or leather shoes"></label>
<label>Destination country<select id="cty">${countriesOptions()}</select></label>
<button class="pill go" type="submit">Check duty</button></form>
<div id="dutyOut" class="toolout" aria-live="polite"></div>
${askBox("Want the duty confirmed for your exact line?", "We check the national tariff line, extra duties and the trade-deal rate.", "duty", { label: "Ask the desk" })}
<h2>Countries where trade deals cut duty for India</h2>
<p>${deals}</p>
<h2>Questions</h2>${faqHtml(faqs)}
${otherTools("import-duty")}
${TOOL_JS}
${script("import-duty.html", { __PAGES__: pyJsonDumps(productSlugs()),
    __CSLUG__: pyJsonDumps(Object.fromEntries((Object.values(d.countries) as Json[]).map((c) => [c.iso3, c.slug]))) })}`;
  const desc = "Import duty on Indian goods in 66 countries: the rate for India, the normal rate and the trade deal (CETA, CEPA, ECTA), with the official source. Free.";
  return layout(`Import duty checker for Indian exports, 66 countries | ${BRAND}`, desc, "/tools/import-duty", body,
    { jsonld: [toolLd("import-duty", "Import duty checker", desc), faqLdPlain(faqs)], crumbs: [["Home", "/"], ["Tools", "/tools"], ["Import duty checker", "/tools/import-duty"]] });
}

/** export-desk/config.py QUOTE_DEFAULTS, as Python prints them (floats keep their ".0"). */
const Q = { margin_pct: "15.0", inland_freight_inr: "25000", port_and_cha_inr: "18000", inr_per_usd: "88.0", sea_freight_usd: "1800", insurance_pct: "0.3" };

export function toolPriceCalculator(): string {
  const d = loadIndex();
  const meta = Object.fromEntries((Object.values(d.countries) as Json[]).map((c) => [c.iso3, { freight: c.lane.sea_freight_usd, lane: c.lane.lane,
    vat: c.vat.pct, vatname: c.vat.name, fob: c.fob_basis }]));
  const faqs: [string, string][] = [["What is the difference between FOB and CIF?", "FOB is your price with the goods loaded on the ship at the Indian port; the buyer pays freight and insurance from there. CIF adds sea freight and insurance to the destination port. See [Incoterms for Indian exporters](/guide/incoterms-for-indian-exporters)."],
    ["Should I add GST to my export price?", "No. Exports are zero-rated: with a LUT you export without paying IGST. See [GST on exports](/guide/gst-on-exports-lut-refund)."],
    ["Why does the buyer's landed cost matter to me?", "The buyer compares your landed cost with suppliers from other countries. A lower duty from a trade deal can let you keep a higher FOB price and still win the order."],
    ["Are the freight and exchange rates live?", `No. They are editable assumptions (exchange rate as of ${FX_AS_OF()}; freight is an indicative 20-foot container rate for the lane). Replace them with your forwarder's quote.`]];
  const body = `<h1>Export price calculator: factory cost to FOB, CIF and landed cost</h1>
<p class="lede">Enter your cost per piece and the shipment. Get the FOB price to quote, the CIF price, and what the buyer pays once duty and
import VAT are added. Duty is filled in from official tariffs when you give the HS code.</p>
<form class="tool calc" id="calc">
<fieldset><legend>Your product</legend>
<label>Cost per piece, ex-factory (₹)<input type="number" id="cost" value="300" min="0" step="any"></label>
<label>Packing per piece (₹)<input type="number" id="pack" value="15" min="0" step="any"></label>
<label>Pieces in the shipment<input type="number" id="qty" value="2000" min="1" step="1"></label>
<label>Your margin (%)<input type="number" id="margin" value="${Q.margin_pct}" min="0" step="any"></label></fieldset>
<fieldset><legend>Getting it on the ship</legend>
<label>Factory to port (₹ per shipment)<input type="number" id="inland" value="${Q.inland_freight_inr}" min="0" step="any"></label>
<label>CHA, port and documents (₹)<input type="number" id="port" value="${Q.port_and_cha_inr}" min="0" step="any"></label>
<label>₹ per US$<input type="number" id="fx" value="${Q.inr_per_usd}" min="1" step="any"></label></fieldset>
<fieldset><legend>Destination</legend>
<label>Country<select id="cty">${countriesOptions()}</select></label>
<label>HS code (optional, fills duty)<input id="hs" maxlength="6" placeholder="e.g. 640391"></label>
<label>Sea freight (US$ per shipment)<input type="number" id="freight" value="${Q.sea_freight_usd}" min="0" step="any"></label>
<label>Insurance (% of CIF)<input type="number" id="ins" value="${Q.insurance_pct}" min="0" step="any"></label>
<label>Import duty (%)<input type="number" id="duty" value="0" min="0" step="any"></label>
<label>Import VAT/GST (%)<input type="number" id="vat" value="20" min="0" step="any"></label></fieldset>
</form>
<div id="calcOut" class="toolout" aria-live="polite"></div>
${askBox("Want us to check your quote?", "Send your numbers. We check freight, duty and payment terms before you send the price.", "quote", { label: "Check my quote" })}
<h2>How the price is built</h2>
<ol><li><b>FOB</b> = (cost + packing) × pieces × (1 + margin) + factory-to-port + CHA and port charges.</li>
<li><b>CIF</b> = FOB + sea freight + insurance.</li>
<li><b>Duty</b> = rate × CIF value (the US, Canada, Australia and New Zealand charge it on the FOB value).</li>
<li><b>Landed cost</b> = CIF + duty + import VAT on (CIF + duty). The importer usually reclaims the VAT, so the real cost to the buyer is CIF + duty.</li></ol>
<p>Read the full method in <a href="/guide/export-pricing-fob-cif">export pricing: FOB, CIF and landed cost</a>.</p>
<h2>Questions</h2>${faqHtml(faqs)}
${otherTools("export-price-calculator")}
${TOOL_JS}
${script("export-price-calculator.html", { __META__: pyJsonDumps(meta) })}`;
  const desc = "Free export price calculator: factory cost to FOB and CIF, plus the buyer's landed cost with duty and import VAT for 66 countries.";
  return layout(`Export price calculator: FOB, CIF, landed cost | ${BRAND}`, desc, "/tools/export-price-calculator", body,
    { jsonld: [toolLd("export-price-calculator", "Export price calculator", desc), faqLdPlain(faqs)],
      crumbs: [["Home", "/"], ["Tools", "/tools"], ["Export price calculator", "/tools/export-price-calculator"]] });
}

const READINESS = site.READINESS as [string, string, string[], string, string][];

export function toolReadiness(): string {
  const qs = READINESS.map(([dim, q, opts], i) => `<fieldset class="q"><legend><small>${e(dim)}</small> ${i + 1}. ${e(q)}</legend>
${opts.map((o, j) => `<label class="opt"><input type="radio" name="q${i}" value="${2 - j}" required> ${e(o)}</label>`).join("")}</fieldset>`).join("");
  const faqs: [string, string][] = [["Do I need a company to export?", "No. A proprietorship, partnership, LLP or company can export. You need a PAN, a bank account, GST registration (in most cases) and an IEC."],
    ["How long does it take to get ready?", "The registrations (IEC, LUT, RCMC) take days, not weeks. Product testing and finding a first buyer usually take longer, so start those early."],
    ["Is my data saved?", "No. The check runs in your browser and nothing is sent unless you ask the desk to call you."]];
  const body = `<h1>Export readiness check: are you ready for your first export order?</h1>
<p class="lede">13 questions across paperwork, product, market, money and capacity. Takes about 3 minutes. You get a score and a short,
ordered list of what to fix, each with a guide or a free tool. No sign-up.</p>
<form class="tool quiz" id="quiz">${qs}<button class="pill go" type="submit">See my result</button></form>
<div id="quizOut" class="toolout" aria-live="polite"></div>
<h2>What the five areas mean</h2>
<ul><li><b>Paperwork:</b> IEC, GST with a LUT, and your council's RCMC. Quick to get, and you cannot ship without them.</li>
<li><b>Product:</b> the right HS code, the tests the buyer's country needs, and samples that match the order.</li>
<li><b>Market:</b> a country chosen on demand and duty, and importers who already buy what you make.</li>
<li><b>Money:</b> an FOB price that covers every cost, working capital until payment, and safe payment terms.</li>
<li><b>Capacity:</b> enough production for an export order and someone to handle documents and email.</li></ul>
<h2>Questions</h2>${faqHtml(faqs)}
${otherTools("export-readiness")}
${TOOL_JS}
${script("export-readiness.html", { __Q__: pyJsonDumps(READINESS.map(([dim, , , link, fix]) => ({ dim, fix, link }))) })}`;
  const desc = "Free export readiness check for Indian manufacturers: 13 questions on paperwork, product, market, money and capacity, with a score and a fix-first list.";
  return layout(`Export readiness check: 3-minute self-test | ${BRAND}`, desc, "/tools/export-readiness", body,
    { jsonld: [toolLd("export-readiness", "Export readiness check", desc), faqLdPlain(faqs)], crumbs: [["Home", "/"], ["Tools", "/tools"], ["Export readiness check", "/tools/export-readiness"]] });
}

// ------------------------------------------------------------------ pricing, contact, refunds

export function pricingPage(): string {
  const price = PRICE_FROM_INR();
  const faqs: [string, string][] = [["What does the self-serve plan cost?", "Nothing. The HS code, best countries, duty, buyers, landed-cost quote and documents checklist are free, with no sign-up."],
    ["How is the desk fee charged?", `Per shipment, from ₹${price} plus GST. We tell you the fee for your shipment in writing before we start. There is no subscription and no commission on your order.`],
    ["What is not included in the desk fee?", "Costs paid to others at actuals: government and council fees, certificate-of-origin agency fees, lab tests, freight, insurance, CHA and port charges, and bank charges. We tell you each one before it is incurred."],
    ["Do you take a share of my order or my buyer?", "No. You stay the exporter of record. The buyer, the payment and the refunds are yours; we never take title to your goods."],
    ["Can I use only part of the desk?", "Yes. Many exporters do the self-serve steps themselves and ask the desk only for set-up, documents or the LC check. Call us and we will quote for the part you need."]];
  const body = `<h1>Pricing: free to check, pay only when you ship</h1>
<p class="lede">The tools are free. The export desk is paid per shipment, with no subscription and no commission on your order.</p>
<div class="plans">
<div class="plan"><h2>Self-serve</h2><div class="amt">₹0</div><p>Everything you need to decide where and how to export.</p>
<ul><li>HS code from your documents</li><li>Best countries with the duty on Indian goods</li><li>Named UK importers and official buyer channels</li>
<li>Landed-cost quote and the FOB price to quote</li><li>Proforma, packing list and certificate-of-origin data</li><li>All <a href="/tools">free tools</a> and <a href="/guide">guides</a></li></ul>
<a class="pill go" href="/app">Check my product →</a></div>
<div class="plan desk"><h2>Export desk</h2><div class="amt">from ₹${e(price)} <small>per shipment + GST</small></div><p>A named person takes your shipment from set-up to payment.</p>
<ul><li>IEC, RCMC, AD code and LUT set-up</li><li>Certificate of origin filed on DGFT Trade Connect</li><li>Freight quotes, CHA and shipping-bill checks</li>
<li>LC document check and payment matching</li><li>e-BRC, RoDTEP, drawback and GST refund close-out</li><li>Hindi or English, on phone and WhatsApp</li></ul>
<button type="button" class="pill go" style="border:0;cursor:pointer;font:inherit;font-weight:700" data-ask data-ask-step="desk" data-ask-title="Talk to the export desk">Talk to the desk →</button></div></div>
<h2>Paid to others, at actual cost</h2>
<p>These are not our fee. We tell you each one before it is incurred: government and export council fees, certificate-of-origin agency fees,
lab tests and certifications, freight and insurance, CHA and port charges, and bank charges.</p>
<h2>How it compares</h2>
<div class="table-wrap"><table><thead><tr><th></th><th>${BRAND}</th><th>Typical export agent</th><th>Monthly software</th></tr></thead><tbody>
<tr><td>How you pay</td><td>Free tools; desk per shipment</td><td>Commission on each order</td><td>Monthly or yearly subscription</td></tr>
<tr><td>Who owns the buyer</td><td>You</td><td>Often the agent</td><td>You</td></tr>
<tr><td>Paperwork done with you</td><td>Yes, end to end</td><td>Varies</td><td>No, you do it</td></tr>
<tr><td>Duty and trade-deal data</td><td>Free, with official sources</td><td>Rarely</td><td>Often paid per lookup</td></tr></tbody></table></div>
<h2>Questions</h2>${faqHtml(faqs)}
<p>See also the <a href="/refund-policy">cancellation and refund policy</a>.</p>`;
  const ld = [{ "@context": "https://schema.org", "@type": "Service", name: `${BRAND} export desk`, provider: { "@id": siteUrl() + "/#org" },
    areaServed: "IN", serviceType: "Export documentation, market selection and customs facilitation",
    offers: [{ "@type": "Offer", name: "Self-serve export tools", price: "0", priceCurrency: "INR" },
      { "@type": "Offer", name: "Export desk, per shipment (excluding GST)", priceSpecification: {
        "@type": "UnitPriceSpecification", minPrice: rep(price, ",", ""), priceCurrency: "INR",
        valueAddedTaxIncluded: false, unitText: "shipment" } }] }, faqLdPlain(faqs)];
  return layout(`Pricing: free tools, export desk from ₹${price} per shipment | ${BRAND}`,
    clip(`Exportwalla pricing: free HS code, duty, buyers and quote; export desk from ₹${price} per shipment plus GST. No subscription, no commission.`),
    "/pricing", body, { jsonld: ld, crumbs: [["Home", "/"], ["Pricing", "/pricing"]] });
}

export function contactPage(): string {
  const phone = deskPhone(), email = contactEmail(), wa = DESK_WHATSAPP(), grievance = GRIEVANCE_OFFICER(), biz = businessLine();
  const tel = e(rep(phone, " ", ""));
  const waBtn = wa ? `<a class="pill go" href="https://wa.me/${e(wa)}">WhatsApp the desk</a>` : "";
  const body = `<h1>Contact the ${BRAND} export desk</h1>
<p class="lede">Talk to a person about your product and your first or next shipment, in Hindi or English. We reply within one working day.</p>
<div class="facts"><div><span>Phone</span><b><a href="tel:${tel}">${e(phone)}</a></b></div>
${wa ? `<div><span>WhatsApp</span><b><a href="https://wa.me/${e(wa)}">+${e(wa)}</a></b></div>` : ""}
${email ? `<div><span>Email</span><b><a href="mailto:${e(email)}">${e(email)}</a></b></div>` : ""}
<div><span>Languages</span><b>Hindi, English</b></div></div>
<p><a class="pill go" href="tel:${tel}">Call ${e(phone)}</a> ${waBtn}</p>
<h2>Or ask for a call back</h2>
${rep(LEAD_FORM, '"SOURCE"', '"contact"')}
<h2>Before you call</h2>
<p>It helps to have an invoice or price list for your product. Even better, run it through the <a href="/app">free workspace</a> first: you
will have your HS code, best countries and a quote to talk about.</p>
${grievance ? `<h2>Grievance officer</h2><p>${e(grievance)}</p>` : ""}
${biz ? `<h2>Business details</h2><p>${biz}</p>` : ""}`;
  const ld = [{ "@context": "https://schema.org", "@type": "ContactPage", url: siteUrl() + "/contact", about: { "@id": siteUrl() + "/#org" } }];
  return layout(`Contact the export desk: call, WhatsApp or call back | ${BRAND}`,
    "Talk to Exportwalla's export desk in Hindi or English: phone, WhatsApp or ask for a call back. We reply within one working day.",
    "/contact", body, { jsonld: ld, crumbs: [["Home", "/"], ["Contact", "/contact"]] });
}

export function refundPage(): string {
  const phone = deskPhone(), email = contactEmail(), grievance = GRIEVANCE_OFFICER();
  const body = `<h1>Cancellation and refund policy</h1>
<p class="lede">Plain version: the tools are free; for the desk you pay only for work we do, and anything we have not started is refunded.</p>
<h2>Free tools</h2><p>The workspace, the tools and the guides are free. There is nothing to cancel or refund.</p>
<h2>Export desk fees</h2>
<ul><li>We send you a written quote for each shipment before any work starts. You pay only after you accept it.</li>
<li><b>Cancel before we start:</b> you get the full desk fee back.</li>
<li><b>Cancel after we start:</b> we refund the part of the fee for stages we have not begun, and keep the part for work already done (for example, filings made or documents prepared). We show you the split in writing.</li>
<li><b>If we cannot do what we quoted</b> (for example, a filing we promised is not possible for your product), you get the fee for that part back in full.</li></ul>
<h2>Costs paid to others</h2>
<p>Government and export council fees, certificate-of-origin agency fees, lab tests, freight, insurance, CHA and port charges and bank charges
are paid to those parties. Their own refund rules apply; we help you claim any refund they allow.</p>
<h2>How refunds are paid</h2>
<p>To the account or payment method you paid from, within 7 working days of the cancellation being agreed. GST on the refunded fee is refunded with it.</p>
<h2>How to cancel or ask a question</h2>
<p>Call ${e(phone)}${email ? ` or email ${e(email)}` : ""}. ${grievance ? `Grievance officer: ${e(grievance)}.` : ""}</p>
<p class="verified">This policy is part of our <a href="/terms">terms</a>.</p>`;
  return layout(`Cancellation and refund policy | ${BRAND}`,
    "Exportwalla's cancellation and refund policy: free tools, written quotes per shipment, full refund before work starts and pro-rata after.",
    "/refund-policy", body, { crumbs: [["Home", "/"], ["Refund policy", "/refund-policy"]], md: false });
}
