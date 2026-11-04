// Reference pages built from the verified data: countries, HS codes, product x country, trade agreements and India's
// export mix. Port of export-desk/app/seo.py; byte-for-byte equal output (tests/pages.parity.test.ts).
import { siteUrl } from "../config";
import { rows } from "../db";
import { cpSlice, fmtFixed, pyFloatStr, pyStrip, pySum } from "../py";
import { loadIndex } from "../site";
import {
  BRAND, type Json, askBox, clip, e, faqLd, fit, flag, ftaLinks, ftasFor, guideLink, guidesForHs, hasDeal, layout, money,
  pct, rep, relatedCountries, shortDoc, sortBy, src, usIndiaRate, verified,
} from "./common";

const lowerFirst = (s: string) => cpSlice(s, 0, 1).toLowerCase() + cpSlice(s, 1);
const dealName = (c: Json) => c.deal.split(" · ")[0];
const faqDetails = (faqs: [string, string][], open = true) =>
  faqs.map(([q, a]) => `<details${open ? " open" : ""}><summary>${e(q)}</summary><p>${e(a)}</p></details>`).join("");

// ------------------------------------------------------------------ country pages

export function countryHub(): string {
  const d = loadIndex();
  const cs = sortBy(Object.values(d.countries) as Json[], (c) => c.name);
  const deal = cs.filter(hasDeal);
  const tiles = cs.map((c) => `<a class="ctile ${hasDeal(c) ? "deal" : ""}" href="/export-to/${c.slug}"><span>${flag(c.iso2)}</span>`
    + `<b>${e(c.name)}</b><small>${e(c.deal)}</small></a>`).join("");
  const body = `<h1>Export from India: duty, trade deals and documents for ${cs.length} countries</h1>
<p class="lede">India has a trade agreement in force with ${deal.length} of these ${cs.length} markets, which together buy about 90% of India's exports.
Pick a country to see the duty your buyer pays on Indian goods, the certificate of origin you need, import VAT and the best products to send.</p>
<div class="ctiles">${tiles}</div>${verified(d)}`;
  return layout(`Export from India by country: duty, FTAs and documents (${cs.length} countries) | ${BRAND}`,
    `Duty on Indian goods, trade agreements (CETA, CEPA, ECTA, AIFTA), certificate of origin and import VAT for ${cs.length} countries, from official sources.`,
    "/export-to", body, { crumbs: [["Home", "/"], ["Countries", "/export-to"]], md: false });
}

function country(slug: string): [Json, Json | null] {
  const d = loadIndex();
  const iso = Object.hasOwn(d.by_country_slug, slug) ? d.by_country_slug[slug] : null;
  return [d, iso ? d.countries[iso] : null];
}

export function countryPage(slug: string): string | null {
  const [d, c] = country(slug);
  if (!c) return null;
  const n: string = c.name, prods = d.products, origin = c.origin, pref = origin.preferential, vat = c.vat;
  const top: Json[] = c.top_products.slice(0, 15);
  const deal = dealName(c);
  let first: string;
  if (hasDeal(c)) first = `The ${deal} is in force, so many Indian goods pay less duty in ${n} than goods from elsewhere.`;
  else if (c.deal.startsWith("No trade deal")) first = `India has no trade agreement in force with ${n}, so Indian goods pay the normal duty.`;
  else first = rep(c.deal, " · ", "; ") + ".";
  let vatS: string;
  if (vat.pct) vatS = `Import ${vat.name} in ${n} is ${pct(vat.pct)}.`;
  else if ((vat.name || "").toLowerCase().startsWith("no")) vatS = `${vat.name} in ${n}.`;
  else vatS = vat.pct === 0 ? `${n} charges no import VAT at the border.` : "";
  const answer = `${first} `
    + `${pref ? "To claim the lower duty you need a " + shortDoc(pref) + "." : "There is no preferential origin document; buyers may still ask for a non-preferential certificate of origin."} `
    + `${vatS} Duty is charged on the ${c.fob_basis ? "FOB" : "CIF"} value.`;
  const trs = top.filter((t) => prods.has(t.hs6)).map((t) => { const p = prods.get(t.hs6); return `<tr><td><a href="/hs-code/${p.slug}">${e(p.name)}</a><br><small>HS ${t.hs6}</small></td>
<td>${fmtFixed(t.india_share * 100, 0)}% <small>(${t.share_band})</small></td><td><b>${pct(t.india_pct)}${t.pref_pending ? "*" : ""}</b></td><td>${pct(t.mfn_pct)}</td>
<td>${t.has_page ? `<a href="/export/${p.slug}/${c.slug}">Duty, documents, buyers →</a>` : ""}</td></tr>`; }).join("");
  const agr = c.agreements.map((a: Json) => `<li><b>${e(a.name ?? "")}</b>: ${e(rep(a.status ?? "", "_", " "))}`
    + `${a.in_force_date ? " since " + e(a.in_force_date) : ""}${src(a.source_url)}</li>`).join("") || "<li>No trade agreement with India.</li>";
  const notes = c.import_notes.map((x: Json) => `<li>${e(x.text ?? "")}${src(x.source_url)}</li>`).join("");
  const np = c.non_preferential && Object.keys(c.non_preferential).length ? c.non_preferential : {};
  const faqs: [string, string][] = [
    [`Does India have a trade agreement with ${n}?`, c.agreement + "."],
    [`Which certificate of origin do I need to export to ${n}?`,
      pref ? `${pref}. Issued by ${origin.issued_by || "the designated agency"}.`
        : `No preferential certificate applies. A non-preferential certificate of origin is needed ${np.needed || "when the buyer asks"}; Indian chambers and export councils issue it on DGFT Trade Connect.`],
    [`What is the import VAT or GST in ${n}?`,
      vat.pct !== null && vat.pct !== undefined ? `${vat.name} ${pct(vat.pct)} on the customs value plus duty; the importer usually reclaims it.` : "Not researched yet; our desk confirms."],
    [`How do I find buyers in ${n}?`,
      c.iso3 === "GBR" ? "Named UK importers come from HMRC's public import records. "
        : `${n} does not publish an importer register. Use the Indian mission's commerce wing, your export promotion council's buyer-seller meets, and our desk's verified importer search.`],
  ];
  const ftas = ftasFor(d, c.iso3);
  const body = `<h1>Export to ${e(n)} from India: duty, ${e(hasDeal(c) ? deal : "trade rules")} and documents</h1>
<div class="answer"><b>In short:</b> ${e(answer)}</div>
<div class="facts"><div><span>Trade deal</span><b>${e(c.deal)}</b></div><div><span>Proof of origin</span><b>${e(cpSlice((pref || "Non-preferential CoO").split("(")[0], 0, 60))}</b></div>
<div><span>Import ${e(vat.name || "VAT")}</span><b>${pct(vat.pct)}</b></div><div><span>Typical sea freight (20ft)</span><b>${money(c.lane.sea_freight_usd)}</b><small>${e(c.lane.lane)}, indicative</small></div></div>
<h2>Best products to export from India to ${e(n)}</h2>
<p>Products India already sells well in ${e(n)}, by India's share of ${e(n)}'s imports, with the duty your buyer pays on Indian goods versus the normal rate.</p>
<div class="table-wrap"><table><thead><tr><th>Product</th><th>India's share of imports</th><th>Duty on Indian goods</th><th>Normal duty</th><th></th></tr></thead><tbody>${trs}</tbody></table></div>
${top.some((x) => x.pref_pending) ? `<p class="src">* Normal rate shown: the ${e(deal)} is in force, but its lower rate for these lines is not in the World Bank data yet. Check the official schedule, or ask our desk to confirm.</p>` : ""}
<p class="src">Market shares: derived from UN Comtrade. Duty: ${c.iso3 === "GBR" ? "UK Trade Tariff" : "World Bank WITS/TRAINS"} and the national tariff.</p>
<h2>Trade agreement and duty for Indian goods</h2><ul>${agr}</ul>
${c.gsp.india_beneficiary ? `<p>${e(c.gsp.notes || "")}</p>` : ""}
${ftas.length ? `<p>${ftaLinks(d, c.iso3)}</p>` : ""}
<h2>Certificate of origin and documents</h2>
<ul><li><b>Proof of origin:</b> ${e(pref || "none for preferences; non-preferential certificate of origin if the buyer asks")}${origin.source_url ? ` (<a href="${e(origin.source_url)}" rel="nofollow">official source</a>)` : ""}</li>
<li><b>Issued by:</b> ${e(origin.issued_by || "designated agencies on DGFT Trade Connect")}</li>
<li>Also: commercial invoice, packing list, shipping bill (ICEGATE), bill of lading, and any product certificate your goods need.</li></ul>
${notes ? `<h2>Before you ship to ${e(n)}</h2><ul>${notes}</ul>` : ""}
<h2>Finding buyers in ${e(n)}</h2>
<p>${c.iso3 === "GBR" ? "Named UK importers of each product are listed on the product pages, from HMRC public import records." : "No free official register of importers exists here, so we do not list scraped names."}
${c.mission_url ? `The Indian mission commerce wing takes trade enquiries: <a href="${e(c.mission_url)}" rel="nofollow">mission page</a>.` : ""}
${c.customs_url ? `Customs authority: <a href="${e(c.customs_url)}" rel="nofollow">${e(c.customs_url)}</a>.` : ""}</p>
${askBox(`Planning to export to ${n}?`, "Tell us your product. We check the duty, the rules and the buyers for you, free.", "market", { country: n })}
<h2>Questions exporters ask about ${e(n)}</h2>${faqDetails(faqs)}
<h2>Related</h2><p>${relatedCountries(d, c)}</p>
<p><a href="/fta">All of India's trade agreements</a> · <a href="/india-exports">Where India exports</a> · <a href="/tools/hs-code-finder">Find your HS code</a> · <a href="/tools/import-duty">Import duty checker</a></p>
<p>Guides: ${guideLink("certificate-of-origin", "Certificate of origin")} · ${guideLink("how-to-find-export-buyers", "Finding export buyers")} · ${guideLink("export-shipping-and-customs-clearance", "Shipping and customs")}</p>${verified(d)}`;
  const ld = [faqLd(faqs), { "@context": "https://schema.org", "@type": "Dataset", name: `Import duty on Indian goods in ${n}`,
    description: `Duty for Indian goods vs the normal rate in ${n}, by HS6 product, with trade-agreement status.`,
    dateModified: d.verified || d.built, creator: { "@type": "Organization", name: BRAND },
    isBasedOn: ["https://wits.worldbank.org/", "https://www.trade-tariff.service.gov.uk/"],
    distribution: { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${siteUrl()}/api/public/country/${c.iso3}` } }];
  const title = `Export to ${n} from India: duty, ${hasDeal(c) ? deal : "rules"}, documents (2026) | ${BRAND}`;
  const desc = `Duty on Indian goods in ${n}, ${c.deal}, certificate of origin, import VAT ${pct(vat.pct)} and the best products to export. Verified from official sources.`;
  return layout([...title].length > 95 ? fit(rep(title, ` | ${BRAND}`, ""), "", 95) : title, clip(desc), `/export-to/${c.slug}`, body,
    { jsonld: ld, crumbs: [["Home", "/"], ["Countries", "/export-to"], [n, `/export-to/${c.slug}`]] });
}

// ------------------------------------------------------------------ product pages

let hsRef: Map<string, string> | null = null;
const hsReference = () => (hsRef ??= new Map(rows<{ code: string; text: string }>("SELECT code, text FROM hs_ref").map((r) => [r.code, r.text])));

export function productHub(): string {
  const d = loadIndex();
  const ref = hsReference();
  const byCh = new Map<string, Json[]>();
  for (const p of d.products.values()) {
    if (!byCh.has(p.chapter)) byCh.set(p.chapter, []);
    byCh.get(p.chapter)!.push(p);
  }
  const blocks = sortBy([...byCh], ([ch]) => ch).map(([ch, ps]) => `<h2>Chapter ${ch}: ${e(cpSlice((ref.get(ch) ?? "").split(";")[0], 0, 70))}</h2><ul class='cols'>`
    + sortBy(ps, (x) => x.hs6).map((p) => `<li><a href="/hs-code/${p.slug}">${e(p.name)}</a> <small>${p.hs6}</small></li>`).join("") + "</ul>").join("");
  const body = `<h1>HS codes for India's top export products, with duty in every market</h1>
<p class="lede">${d.products.size} products that make up most of India's exports. Each page gives the HS code, the UK and US national lines,
the duty your buyer pays in up to 66 countries, and the best markets. Not sure of your code? <a href="/app">Upload an invoice or photo</a> and we find it.</p>${blocks}${verified(d)}`;
  return layout(`HS code finder for Indian exporters: ${d.products.size} products with duty by country | ${BRAND}`,
    "Find the HS code for your product, the UK and US tariff lines, and the import duty on Indian goods in 66 countries. Free, with official sources.",
    "/hs-code", body, { crumbs: [["Home", "/"], ["HS codes", "/hs-code"]], md: false });
}

function product(slug: string): [Json, Json | null] {
  const d = loadIndex();
  const h = Object.hasOwn(d.by_product_slug, slug) ? d.by_product_slug[slug] : null;
  return [d, h ? d.products.get(h) : null];
}

export function productPage(slug: string): string | null {
  const [d, p] = product(slug);
  if (!p) return null;
  const C = d.countries, top: Json[] = p.markets.slice(0, 12), best = top[0] ?? null;
  const hs = `${p.hs6.slice(0, 4)}.${p.hs6.slice(4)}`;
  const uk = p.uk_lines.map((x: Json) => `<tr><td>${x.code}</td><td>${e(cpSlice(x.description, 0, 110))}</td><td>${e(x.mfn_rate || "–")}</td><td><b>${e(x.india_rate || x.mfn_rate || "–")}</b></td></tr>`).join("");
  const us = p.us_lines.map((x: Json) => `<tr><td>${x.code}</td><td>${e(cpSlice(x.description, 0, 110))}</td><td>${e(x.general_rate || "–")}</td><td><b>${usIndiaRate(x, p.hs6)}</b></td></tr>`).join("");
  const mk = top.filter((m) => m.iso3 in C).map((m) => `<tr><td>${m.rank}</td><td>${flag(C[m.iso3]?.iso2 ?? "")} <a href="/export-to/${C[m.iso3].slug}">${e(C[m.iso3].name)}</a></td>
<td><b>${pct(m.india_pct)}${m.pref_pending ? "*" : ""}</b> <small>vs ${pct(m.mfn_pct)}</small></td><td>${fmtFixed(m.india_share * 100, 0)}%</td><td>${m.growth >= 0 ? "▲" : "▼"} ${fmtFixed(Math.abs(m.growth) * 100, 0)}%</td>
<td><small>${e(m.deal)}</small></td><td>${`${p.hs6}|${m.iso3}` in d.pairs ? `<a href="/export/${p.slug}/${C[m.iso3].slug}">Details →</a>` : ""}</td></tr>`).join("");
  const epc = p.epc;
  const answer = `The HS code for ${lowerFirst(p.name)} is ${hs} (HS ${p.hs6}). `
    + (best && best.iso3 in C ? `The best market by our score is ${C[best.iso3].name}, where Indian goods pay ${pct(best.india_pct)} duty`
      + `${(best.mfn_pct || 0) > (best.india_pct || 0) ? " (others pay " + pct(best.mfn_pct) + ")" : ""}. ` : "")
    + "On your shipping bill you use India's 8-digit ITC-HS code, which starts with these 6 digits. "
    + "This is a guide, not a binding customs ruling.";
  const faqs: [string, string][] = [
    [`What is the HS code for ${p.name.toLowerCase()}?`, `HS ${p.hs6}: ${p.description}. Indian shipping bills use the 8-digit ITC-HS code that starts with ${p.hs6}.`],
    [`Which country is best to export ${p.name.toLowerCase()} to from India?`,
      top.slice(0, 5).filter((m) => m.iso3 in C).map((m) => `${C[m.iso3].name} (duty ${pct(m.india_pct)})`).join(", ") + " are the top markets by demand, growth, India's share and duty."],
    ["Which export promotion council handles this product?", epc ? `${epc.name} (${epc.url}). Its RCMC is needed for export incentives.` : "Ask our desk which council applies."],
  ];
  const cn: string = "common" in p ? p.common : p.name;
  const guides = guidesForHs(p.hs6);
  const body = `<h1>HS code for ${e(cn)}: ${hs}. Export from India, duty by country</h1>
<p class="muted">HS ${p.hs6}: ${e(p.name)}</p>
<div class="answer"><b>In short:</b> ${e(answer)}</div>
<p class="muted">Official description: ${e(p.description)}</p>
<h2>Best countries to export ${e(p.name.toLowerCase())} from India</h2>
<div class="table-wrap"><table><thead><tr><th>#</th><th>Country</th><th>Duty on Indian goods</th><th>India's share</th><th>Growth</th><th>Trade deal</th><th></th></tr></thead><tbody>${mk}</tbody></table></div>
${top.some((m) => m.pref_pending) ? '<p class="src">* Normal rate shown: a trade deal with India is in force there, but its lower rate for this line is not in the World Bank data yet. Our desk confirms it.</p>' : ""}
<p class="src">Ranking: 35% market size, 15% growth, 15% India's share, 35% duty. Market data derived from UN Comtrade; duty from national tariffs and WITS/TRAINS.</p>
${uk ? `<h2>UK commodity codes and duty (India–UK CETA)</h2><div class="table-wrap"><table><thead><tr><th>UK code</th><th>Description</th><th>Normal duty</th><th>Duty for India</th></tr></thead><tbody>${uk}</tbody></table></div><p class="src">Source: <a href="https://www.trade-tariff.service.gov.uk/" rel="nofollow">UK Trade Tariff</a> (OGL).</p>` : ""}
${us ? `<h2>US HTS lines</h2><div class="table-wrap"><table><thead><tr><th>HTS</th><th>Description</th><th>General rate</th><th>For Indian goods</th></tr></thead><tbody>${us}</tbody></table></div><p class="src">Source: <a href="https://hts.usitc.gov/" rel="nofollow">USITC HTS</a>. "+ 10%" is the US Section 301 duty on goods of India since 24 July 2026 (<a href="https://www.federalregister.gov/documents/2026/07/28/2026-15181/notice-of-actions-in-section-301-investigations-of-acts-policies-and-practices-of-various-economies-related-to-the" rel="nofollow">Federal Register</a>); exempt lines show the general rate. Steel and aluminium articles pay Section 232 duties instead.</p>` : ""}
${epc ? `<h2>Export promotion council</h2><p><a href="${e(epc.url)}" rel="nofollow">${e(epc.name)}</a>: register for an RCMC to claim export incentives and join buyer-seller meets.</p>` : ""}
${askBox("Not sure HS " + p.hs6 + " is your code?", "Send us your product. We confirm the code and the best market for it, free.", "hs-code", { product: p.name })}
<h2>Questions</h2>${faqDetails(faqs)}
${guides ? `<p><b>Guide:</b> ${guides}</p>` : ""}
<p><a href="/tools/import-duty?hs6=${p.hs6}">Check duty for HS ${p.hs6} in any country</a> · <a href="/tools/export-price-calculator">Export price calculator</a> · ${guideLink("hs-code-for-export", "How to get your HS code right")}</p>${verified(d)}`;
  const ld = [faqLd(faqs), { "@context": "https://schema.org", "@type": "Dataset", name: `Import duty on HS ${p.hs6} from India by country`,
    description: `Duty for Indian goods vs normal duty for HS ${p.hs6} (${p.name}) in ${p.markets.length} countries.`,
    dateModified: d.verified || d.built, creator: { "@type": "Organization", name: BRAND },
    distribution: { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${siteUrl()}/api/public/product/${p.hs6}` } }];
  const title = fit(`HS code for {name} (${p.hs6}): export duty in ${p.markets.length} countries`, cn, 72);
  const desc = `HS ${p.hs6} for ${cn}: UK and US tariff lines, duty on Indian goods by country, best markets and documents. Verified ${d.verified || d.built}.`;
  return layout(title, clip(desc), `/hs-code/${p.slug}`, body,
    { jsonld: ld, crumbs: [["Home", "/"], ["HS codes", "/hs-code"], [`HS ${p.hs6}`, `/hs-code/${p.slug}`]] });
}

// ------------------------------------------------------------------ product x country pages

const EXAMPLE_FOB = 25000;

export function landedExample(pair: Json, c: Json): Json {
  const fob = EXAMPLE_FOB, fr = c.lane.sea_freight_usd;
  const ins = (fob + fr) * 0.003, cif = fob + fr + ins;
  const base = c.fob_basis ? fob : cif;
  const duty = base * (pair.india_pct || 0) / 100, dutyN = base * (pair.mfn_pct || 0) / 100;
  const vat = (cif + duty) * (c.vat.pct || 0) / 100;
  return { fob, freight: fr, ins, cif, base: c.fob_basis ? "FOB" : "CIF", duty, duty_normal: dutyN, vat, landed: cif + duty, uplift: (cif + duty) / fob - 1 };
}

export function pairPage(pslug: string, cslug: string): string | null {
  const [d, p] = product(pslug);
  const [, c] = country(cslug);
  if (!p || !c) return null;
  const pr: Json | undefined = d.pairs[`${p.hs6}|${c.iso3}`];
  if (!pr) return null;
  const n: string = c.name, pn: string = p.name, cn: string = "common" in p ? p.common : pn;
  const x = landedExample(pr, c);
  const pref = c.origin.preferential;
  const saved = pr.mfn_pct !== null && pr.india_pct !== null && pr.mfn_pct > pr.india_pct;
  const extra = pr.mfn_pct !== null && pr.india_pct !== null && pr.india_pct > pr.mfn_pct; // US Section 301
  const buyers: Json[] = c.iso3 === "GBR" ? d.uk_buyers.get(p.hs6) ?? [] : [];
  const uk: Json[] = c.iso3 === "GBR" ? [...p.uk_lines] : [];
  const us: Json[] = c.iso3 === "USA" ? [...p.us_lines] : [];
  const deal = dealName(c);
  const nat = uk.length ? `UK commodity codes ${uk.slice(0, 3).map((l) => l.code).join(", ")}`
    : us.length ? `US HTS ${us.slice(0, 3).map((l) => l.code).join(", ")}` : `the ${n} national line under HS ${p.hs6}`;
  const answer = `${pn} ships under HS ${p.hs6} (${nat}). ${n} charges ${pct(pr.india_pct)} import duty on it from India`
    + (pr.pref_pending ? ` at the normal rate; the ${deal} rate is likely lower and our desk confirms it` : "")
    + (saved ? `, against ${pct(pr.mfn_pct)} for other countries, under the ${deal}` : "")
    + (extra ? `: the ${pct(pr.mfn_pct)} normal rate plus the 10% US Section 301 duty on goods of India` : "")
    + `. ${(saved || pr.pref_pending) && pref ? "To claim it you need a " + shortDoc(pref) : "A certificate of origin may still be asked for"}. `
    + `On a ${money(x.fob)} FOB shipment the buyer's landed cost is about ${money(x.landed)}`
    + `${c.vat.pct ? " before import " + c.vat.name : ""} (+${fmtFixed(x.uplift * 100, 0)}%).`;
  const calcRows: [string, number, string][] = [["FOB value (your price at the Indian port)", x.fob, ""], ["Sea freight, 20ft container", x.freight, `indicative, ${c.lane.lane}`],
    ["Insurance (0.3%)", x.ins, ""], ["CIF value", x.cif, ""],
    [`Import duty on Indian goods (${pct(pr.india_pct)} of ${x.base})`, x.duty, cpSlice(pr.duty_source, 0, 90)]];
  if (saved) calcRows.push([`Duty without the origin claim (${pct(pr.mfn_pct)})`, x.duty_normal, "what the buyer pays if origin is not proved"]);
  calcRows.push(["Landed cost before VAT", x.landed, ""]);
  if (c.vat.pct) calcRows.push([`Import ${c.vat.name} (${pct(c.vat.pct)}, usually reclaimed by the buyer)`, x.vat, ""]);
  const calc = calcRows.map(([a, b, s]) => `<tr><td>${e(a)}</td><td class='num'>${money(b)}</td><td><small>${e(s)}</small></td></tr>`).join("");
  const lines = uk.map((l) => `<tr><td>${l.code}</td><td>${e(cpSlice(l.description, 0, 100))}</td><td>${e(l.mfn_rate || "–")}</td><td><b>${e(l.india_rate || l.mfn_rate || "–")}</b></td></tr>`).join("")
    || us.map((l) => `<tr><td>${l.code}</td><td>${e(cpSlice(l.description, 0, 100))}</td><td>${e(l.general_rate || "–")}</td><td><b>${usIndiaRate(l, p.hs6)}</b></td></tr>`).join("");
  const buyerHtml = buyers.length ? "<ol>" + buyers.map((b) => `<li><b>${e(b.name)}</b> <small>${e(b.postcode || "")} · imported in ${b.months} months of ${b.year}</small></li>`).join("") + "</ol>"
    + "<p class='src'>Source: HMRC uktradeinfo, importers by commodity code (Open Government Licence). The workspace drafts a first email for each.</p>"
    : `<p>${n} publishes no register of importers, so we do not list names we cannot verify. Our desk sources verified importers from shipment records, and your export promotion council${p.epc ? " (" + e(p.epc.name) + ")" : ""} runs buyer-seller meets.</p>`;
  const docs = ["Proforma and commercial invoice", "Packing list", "Shipping bill on ICEGATE (filed by your CHA)", "Bill of lading or airway bill",
    pref ? pref + " (for the lower duty)" : "Non-preferential certificate of origin, if the buyer asks",
    p.epc ? `RCMC from ${p.epc.name}` : "RCMC from your export promotion council"];
  const notes: string[] = c.import_notes.map((x2: Json) => x2.text).slice(0, 3);
  const faqs: [string, string][] = [
    [`What is the HS code for exporting ${pn.toLowerCase()} to ${n}?`, `HS ${p.hs6}. ${uk.length ? "UK lines: " + uk.slice(0, 4).map((l) => l.code).join(", ") + "." : ""}`],
    [`What import duty does ${n} charge on ${pn.toLowerCase()} from India?`,
      `${pct(pr.india_pct)} for Indian goods` + (saved ? ` (normal rate ${pct(pr.mfn_pct)})` : "")
      + (extra ? ` (${pct(pr.mfn_pct)} normal rate plus the 10% US Section 301 duty on goods of India)` : "") + `. Source: ${pr.duty_source}.`],
    [`Do I need a certificate of origin to export ${pn.toLowerCase()} to ${n}?`,
      saved && pref ? `Yes, to claim the lower duty: ${pref}.` : "Not for a duty preference; the buyer may still ask for a non-preferential certificate of origin."],
    [`Who imports ${pn.toLowerCase()} in ${n}?`, buyers.length ? `${buyers.length} UK importers are listed above from HMRC records.` : `Ask our desk for verified importers in ${n}.`],
  ];
  const ftas = ftasFor(d, c.iso3), guides = guidesForHs(p.hs6);
  const body = `<h1>Export ${e(cn)} from India to ${e(n)}</h1>
<p class="muted">HS ${p.hs6}: ${e(pn)}</p>
<div class="answer"><b>In short:</b> ${e(answer)}</div>
<div class="facts"><div><span>HS code</span><b>${p.hs6}</b></div><div><span>Duty for Indian goods</span><b>${pct(pr.india_pct)}${pr.pref_pending ? "*" : ""}</b>${pr.pref_pending ? "<small>normal rate; the deal's rate is likely lower</small>" : ""}${saved ? `<small>others pay ${pct(pr.mfn_pct)}</small>` : ""}${extra ? `<small>${pct(pr.mfn_pct)} normal + 10% Section 301</small>` : ""}</div>
<div><span>Trade deal</span><b>${e(c.deal)}</b></div><div><span>India's share of ${e(n)}'s imports</span><b>${fmtFixed(pr.india_share * 100, 0)}%</b><small>market rank #${pr.rank} for this product</small></div></div>
${lines ? `<h2>${e(n)} tariff lines for ${e(pn.toLowerCase())}</h2><div class="table-wrap"><table><thead><tr><th>Code</th><th>Description</th><th>Normal duty</th><th>Duty for India</th></tr></thead><tbody>${lines}</tbody></table></div>` : ""}
<h2>${e(n)} import duty on ${e(pn.toLowerCase())} from India</h2>
<p>${pct(pr.india_pct)} for Indian goods${saved ? `, against ${pct(pr.mfn_pct)} normally` : ""}${extra ? `: ${pct(pr.mfn_pct)} normal rate plus 10% Section 301` : ""}. Source: ${pr.duty_url ? `<a href="${e(pr.duty_url)}" rel="nofollow">${e(pr.duty_source)}</a>` : e(pr.duty_source)}.
${e(pr.duty_note || "")}</p>
${askBox("Check the duty on your exact product", `Your exact tariff line can differ from this one. Send us your product and we confirm the duty in ${n}.`, "duty", { product: pn, country: n })}
<h2>Landed cost: a worked example</h2>
<div class="table-wrap"><table>${calc}</table></div>
<p class="src">Freight is an indicative lane rate and the exchange rate is a set assumption; get a live quote and your own numbers in the <a href="/app">free calculator</a>. India's share and market rank are derived from UN Comtrade import data (latest reported year).</p>
<h2>Documents checklist</h2><ul>${docs.map((x2) => `<li>${e(x2)}</li>`).join("")}</ul>
${askBox("Want us to prepare these documents?", "We draft the invoice, packing list and certificate of origin with you. You sign.", "documents", { product: pn, country: n, label: "Get help with documents" })}
${notes.length ? `<h2>Before you ship</h2><ul>${notes.map((t) => `<li>${e(t)}</li>`).join("")}</ul>` : ""}
<h2>Who buys ${e(pn.toLowerCase())} in ${e(n)}</h2>${buyerHtml}
${askBox(`Find buyers in ${n}`, "We shortlist importers with a shipment record for your product, and draft the first email with you.", "buyers", { product: pn, country: n, label: "Find me buyers" })}
<h2>Questions</h2>${faqDetails(faqs)}
<h2>Related</h2>
${pairRelated(d, p, c)}
<p>More: <a href="/export-to/${c.slug}">all rules for ${e(n)}</a> · <a href="/hs-code/${p.slug}">${e(pn)} in other countries</a>${ftas.length ? " · " + ftaLinks(d, c.iso3) : ""}${guides ? " · " + guides : ""}</p>
<p>Guides: ${guideLink("certificate-of-origin", "Certificate of origin")} · ${guideLink("export-pricing-fob-cif", "Export pricing: FOB and CIF")} · ${guideLink("letter-of-credit-and-payment-terms", "Getting paid safely")}</p>${verified(d)}`;
  const title = fit(`Export {name} from India to ${n}: HS ${p.hs6}, ${pct(pr.india_pct)} duty`, cn, 72);
  const desc = `${n} import duty on ${cn} from India: ${pct(pr.india_pct)}${saved ? " vs " + pct(pr.mfn_pct) : ""}. HS ${p.hs6}, landed-cost example, documents${buyers.length ? ", named importers" : ""}.`;
  return layout(title, clip(desc), `/export/${p.slug}/${c.slug}`, body,
    { jsonld: [faqLd(faqs)], crumbs: [["Home", "/"], ["Countries", "/export-to"], [n, `/export-to/${c.slug}`], [cpSlice(cn, 0, 40), `/export/${p.slug}/${c.slug}`]] });
}

function pairRelated(d: Json, p: Json, c: Json, k = 5): string {
  const P = d.products, C = d.countries, pairs = Object.values(d.pairs) as Json[];
  const sameP = sortBy(pairs.filter((x) => x.hs6 === p.hs6 && x.iso3 !== c.iso3), (x) => x.rank).slice(0, k);
  let sameC = sortBy(pairs.filter((x) => x.iso3 === c.iso3 && x.hs6 !== p.hs6 && x.hs6.slice(0, 2) === p.hs6.slice(0, 2)), (x) => -x.india_share).slice(0, k);
  sameC = sameC.concat(sortBy(pairs.filter((x) => x.iso3 === c.iso3 && x.hs6.slice(0, 2) !== p.hs6.slice(0, 2)), (x) => -x.india_share).slice(0, Math.max(0, k - sameC.length)));
  const label = [...p.common].length < 40 ? p.common : cpSlice(p.name, 0, 40);
  const a = sameP.map((x) => `<li><a href="/export/${p.slug}/${C[x.iso3].slug}">${e(cpSlice(label, 0, 1).toUpperCase() + cpSlice(label, 1))} to ${e(C[x.iso3].name)}</a> <small>${pct(x.india_pct)} duty</small></li>`).join("");
  const b = sameC.map((x) => `<li><a href="/export/${P.get(x.hs6).slug}/${c.slug}">${e(cpSlice(P.get(x.hs6).name, 0, 60))}</a> <small>${pct(x.india_pct)} duty</small></li>`).join("");
  return `<div class="cols2"><div><b>Same product, other countries</b><ul>${a}</ul></div>`
    + `<div><b>Other products to ${e(c.name)}</b><ul>${b}</ul></div></div>`;
}

// ------------------------------------------------------------------ trade agreements and India's export mix

export const FTA_STATUS: Record<string, string> = { in_force: "In force", concluded: "Agreed, not yet in force" };

/** Product x country pages in this deal's partner countries where Indian goods pay less than the normal rate. */
function ftaPairs(d: Json, f: Json): Json[] {
  const out = (Object.values(d.pairs) as Json[]).filter((pr) => f.countries.includes(pr.iso3) && pr.mfn_pct !== null && pr.india_pct !== null && pr.india_pct < pr.mfn_pct);
  return sortBy(out, (pr) => [-(pr.mfn_pct - pr.india_pct), pr.rank]);
}

export function ftaHub(): string {
  const d = loadIndex();
  const fs = sortBy(Object.values(d.ftas) as Json[], (f) => [f.status !== "in_force", -f.countries.length, f.label]);
  const trs = fs.map((f) => `<tr><td><a href="/fta/${f.slug}">${e(f.label)}</a></td><td>${FTA_STATUS[f.status]}</td>
<td>${e(f.since || "–")}</td><td>${f.countries.slice(0, 6).map((i: string) => e(d.countries[i].name)).join(", ")}${f.countries.length > 6 ? " and more" : ""}</td></tr>`).join("");
  const live = fs.filter((f) => f.status === "in_force").length;
  const uk = d.uk_ceta;
  const n = (v: number) => fmtFixed(v, 0, { comma: true });
  const body = `<h1>India's trade agreements: which countries give Indian goods lower duty</h1>
<p class="lede">India has ${live} trade agreements in force with the countries we cover, and one agreed with the EU that is not yet in force.
A deal lowers the duty your buyer pays only when your goods meet its rules of origin and you send the right proof of origin.</p>
<div class="answer"><b>Biggest change in 2026:</b> the India–UK CETA came into force on 15 July 2026. Of the ${n(uk.total)} UK commodity codes we
track for Indian export products, ${n(uk.cut)} dropped to 0% for Indian goods and ${n(uk.already)} were already 0%. <a href="/fta/india-uk-ceta">How to claim it →</a></div>
<h2>All agreements</h2>
<div class="table-wrap"><table><thead><tr><th>Agreement</th><th>Status</th><th>In force since</th><th>Countries</th></tr></thead><tbody>${trs}</tbody></table></div>
<h2>How to use a trade deal</h2>
<ol><li><b>Check your product's rate.</b> Open your <a href="/hs-code">HS code page</a>: each market shows the normal rate and the rate for Indian goods.</li>
<li><b>Check the rule of origin.</b> Your product must be made in India under the deal's product-specific rule (change of tariff heading, value added, or both).</li>
<li><b>Send the proof of origin.</b> A certificate of origin from DGFT's Trade Connect (trade.gov.in) or an origin declaration on the invoice, depending on the deal.</li>
<li><b>Keep records.</b> Customs in the buyer's country can verify origin for years after the shipment.</li></ol>
${verified(d)}`;
  const ld = [{ "@context": "https://schema.org", "@type": "ItemList", name: "India's trade agreements", itemListElement:
    fs.map((f, i) => ({ "@type": "ListItem", position: i + 1, name: f.label, url: `${siteUrl()}/fta/${f.slug}` })) }];
  return layout("India's trade agreements (FTA, CEPA, CETA): duty benefits for exporters",
    clip(`India's ${live} trade agreements in force and what each one means for duty: UK CETA, UAE CEPA, EFTA TEPA, ASEAN, Japan, Korea and more, with how to claim.`),
    "/fta", body, { jsonld: ld, crumbs: [["Home", "/"], ["Trade agreements", "/fta"]] });
}

export function ftaPage(fslug: string): string | null {
  const d = loadIndex();
  const f = (Object.values(d.ftas) as Json[]).find((x) => x.slug === fslug);
  if (!f) return null;
  const C = d.countries, P = d.products;
  const cs: Json[] = f.countries.map((i: string) => C[i]);
  const first = cs[0], status = FTA_STATUS[f.status];
  const since = f.since ? ` since ${f.since}` : "";
  const names = cs.map((c) => c.name).join(", ");
  const pairs = ftaPairs(d, f);
  const allPairs = Object.values(d.pairs) as Json[];
  const pending = allPairs.filter((pr) => f.countries.includes(pr.iso3) && pr.pref_pending).length;
  const tracked = allPairs.filter((pr) => f.countries.includes(pr.iso3)).length;
  const trs = pairs.slice(0, 20).map((pr) => `<tr><td><a href="/export/${P.get(pr.hs6).slug}/${C[pr.iso3].slug}">${e(cpSlice(P.get(pr.hs6).name, 0, 70))}</a> <small>HS ${pr.hs6}</small></td>
<td>${e(C[pr.iso3].name)}</td><td class="num">${pct(pr.mfn_pct)}</td><td class="num"><b>${pct(pr.india_pct)}</b></td></tr>`).join("");
  const o = first.origin;
  let claim: string;
  if (f.status === "in_force") {
    claim = `<p>${e(o.preferential || "A certificate of origin under the agreement.")}</p>`
      + `<ul><li><b>Who issues it:</b> ${e(o.issued_by || "Agencies notified by DGFT, through trade.gov.in")}</li>`
      + `<li><b>How:</b> ${e(o.how || "Apply on DGFT Trade Connect (trade.gov.in), Certificate of Origin service.")}</li></ul>`
      + (o.source_url ? `<p class='src'>${src(o.source_url, "Official rules of origin")}</p>` : "");
  } else {
    const g = first.gsp && Object.keys(first.gsp).length ? first.gsp : {};
    claim = "<p>The agreement is not in force yet, so there is no preference to claim under it. "
      + (g.scheme ? `Until it is, Indian goods can use <b>${e(g.scheme ?? "")}</b> on some products, with ${e(o.preferential || "the proof of origin it requires")}.` : "Goods pay the normal rate.")
      + "</p>";
  }
  const texts = f.texts.map((t: Json) => `<li><a href='${e(t.url)}' rel='nofollow'>${e(t.title)}</a></li>`).join("");
  const more = f.negotiating.map((x: string) => `<li>${e(x)}</li>`).join("");
  const tiles = cs.map((c) => `<a class="ctile deal" href="/export-to/${c.slug}"><span>${flag(c.iso2)}</span><b>${e(c.name)}</b><small>Duty, documents, buyers</small></a>`).join("");
  let saving = tracked ? `Of the ${tracked} product and country pages we publish for ${cs.length > 1 ? "these countries" : first.name}, `
    + `<b>${pairs.length}</b> show a lower rate for Indian goods than the normal rate.` : "";
  if (pending) saving += ` For ${pending} more, the deal's lower rate is not yet in our tariff data, so the page shows the normal rate.`;
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
  const faqs: [string, string][] = [
    [`Is the ${f.label} in force?`, `${status}${since}.` + (f.status === "concluded" ? " It is agreed but cannot be used for duty claims until it enters into force." : "")],
    [`Which countries does the ${f.label} cover?`, names + "."],
    ["How do I claim the lower duty?", cpSlice(pyStrip(stripTags(claim)), 0, 600)],
    ["Does every product get zero duty?", "No. Each tariff line has its own rate and phase-in, and some lines are excluded. Check your HS code's page for the rate on your product." + (saving ? " " + stripTags(saving) : "")],
  ];
  const faq = faqDetails(faqs, false);
  const title = fit(`${f.label}: duty benefits for Indian exporters (${status.toLowerCase()})`, f.label, 70);
  const desc = clip(`${f.label} (${cpSlice(names, 0, 60)}): ${status.toLowerCase()}${since}. Which Indian products pay lower duty, how to claim with the right proof of origin, and the official text.`);
  const body = `<h1>${e(f.label)}: what it means for Indian exporters</h1>
<p class="lede">${e(f.name)}.</p>
<div class="answer"><b>${status}${e(since)}.</b> ${cs.length === 1 ? "Partner" : "Partners"}: ${e(names)}. ${saving}</div>
<div class="facts"><div><span>Status</span><b>${status}</b></div><div><span>In force since</span><b>${e(f.since || "–")}</b></div>
<div><span>Countries</span><b>${cs.length}</b></div><div><span>Lower-duty pages</span><b>${pairs.length}</b><small>of ${tracked} tracked</small></div></div>
<h2>Products where Indian goods pay less</h2>
${trs ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Country</th><th>Normal rate</th><th>Rate for India</th></tr></thead><tbody>${trs}</tbody></table></div>` : '<p>None of the product pages we publish for these countries show a lower rate yet. Check your own HS code in the <a href="/app">workspace</a>.</p>'}
<h2>How to claim the lower duty</h2>${claim}
${askBox(`Claim the ${f.label} rate on your product`, "We check your product against the rule of origin and file the certificate with you.", "origin", { country: cpSlice(names, 0, 80), label: "Ask about this deal" })}
<p>Step by step: ${guideLink("certificate-of-origin", "how to get a certificate of origin")} · ${guideLink("hs-code-for-export", "getting the HS code right")}</p>
${more ? `<h2>Also under negotiation</h2><ul>${more}</ul>` : ""}
<h2>Official texts</h2>${texts ? `<ul>${texts}</ul>` : ""}
${f.source_url ? `<p class='src'>${src(f.source_url, "Agreement status, official source")}</p>` : ""}
<h2>Countries</h2><div class="ctiles">${tiles}</div>
<h2>Questions</h2>${faq}
<p>See <a href="/fta">all of India's trade agreements</a> or <a href="/india-exports">where India exports</a>.</p>
${verified(d)}`;
  return layout(title, desc, `/fta/${f.slug}`, body,
    { jsonld: [faqLd(faqs)], crumbs: [["Home", "/"], ["Trade agreements", "/fta"], [f.label, `/fta/${f.slug}`]] });
}

export function indiaExportsPage(): string {
  const d = loadIndex();
  const x = d.india_exports;
  // shares are Python floats (round(x, 1)): str() prints "9.0", not "9"
  const share = (v: number) => (Number.isInteger(v) ? `${v}.0` : pyFloatStr(v));
  const prow = x.partners.map((p: Json, i: number) => `<tr><td>${i + 1}</td><td>${p.slug ? `<a href="/export-to/${p.slug}">${e(p.name)}</a>` : e(p.name)}</td>
<td class="num">${share(p.share)}%</td><td class="num">${p.growth === null ? "" : `${fmtFixed(p.growth * 100, 0, { sign: true })}%`}</td></tr>`).join("");
  const crow = x.chapters.map((c: Json) => `<tr><td>${c.chapter}</td><td>${e(c.name)}</td><td class='num'>${share(c.share)}%</td></tr>`).join("");
  const top5 = pySum(x.partners.slice(0, 5).map((p: Json) => p.share));
  const lead = x.partners[0];
  const body = `<h1>Where India exports: top markets and products (${x.year})</h1>
<p class="lede">India's goods exports by destination and by product chapter, as shares of the total, so you can see where Indian
products already sell and where the room is.</p>
<div class="answer"><b>${e(lead.name)} is India's largest export market</b>, taking ${share(lead.share)}% of India's goods exports in ${x.year}.
The top five markets take ${fmtFixed(top5, 0)}%. Mineral fuels, electrical machinery, machinery, pharmaceuticals and gems lead by product.</div>
<h2>Top ${x.partners.length} export markets</h2>
<div class="table-wrap"><table><thead><tr><th>#</th><th>Country</th><th>Share of India's exports</th><th>Change vs ${x.year - 1}</th></tr></thead><tbody>${prow}</tbody></table></div>
<h2>Top product chapters</h2>
<div class="table-wrap"><table><thead><tr><th>HS chapter</th><th>Products</th><th>Share</th></tr></thead><tbody>${crow}</tbody></table></div>
${askBox("Which market is right for your product?", "Tell us what you make. We rank the countries for it and explain why, free.", "market", { label: "Ask the desk" })}
<h2>What this means for a small manufacturer</h2>
<ul><li>A big market is not always the best one for your product. Open your <a href="/hs-code">HS code page</a> to see the markets ranked for your product by demand, growth, India's foothold and duty.</li>
<li>Trade deals change the picture: see <a href="/fta">which countries give Indian goods lower duty</a>.</li></ul>
<p class="src">Source: ${e(x.source)}. Shares and changes are calculated by ${BRAND} from India's reported exports. See <a href="/sources">sources and licences</a>.</p>
${verified(d)}`;
  const ld = [{ "@context": "https://schema.org", "@type": "Dataset", name: `India's export markets and product chapters, ${x.year} (shares)`,
    description: "Share of India's merchandise exports by destination country and HS chapter, derived from UN Comtrade.",
    url: siteUrl() + "/india-exports", temporalCoverage: String(x.year), spatialCoverage: "India",
    creator: { "@type": "Organization", name: BRAND }, isBasedOn: "https://comtradeplus.un.org/" }];
  return layout(`Where India exports: top markets and products ${x.year} | ${BRAND}`,
    clip(`India's top export markets and products in ${x.year}: ${lead.name} takes ${share(lead.share)}%. Shares by country and HS chapter, with links to duty and documents.`),
    "/india-exports", body, { jsonld: ld, crumbs: [["Home", "/"], ["India's exports", "/india-exports"]] });
}
