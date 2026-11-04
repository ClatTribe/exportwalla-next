// Stage engine parity: classification, readiness, families, country choice, buyers, outreach, quote and documents
// must give exactly the Python engine's answer. Python runs without AI and without the live UK tariff search; the
// TypeScript side gets the same switches through hooks. Cited passages in the documents are real on both sides.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DATA_DIR } from "../src/lib/config";
import { rows } from "../src/lib/db";
import { checkGstin } from "../src/lib/engine/gstin";
import { pseudoClass } from "../src/lib/engine/markets";
import * as st from "../src/lib/engine/stages";
import { type Answer, type Call, python } from "./bridge";

const HOOKS: st.Hooks = { ukSearch: async () => [], llmJson: null };
const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "seo_index.json"), "utf8"));
const PRODUCTS: string[] = Object.keys(index.products);
const COUNTRIES: string[] = Object.keys(index.countries);

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

async function tsAnswer(fn: () => unknown): Promise<Answer> {
  try {
    const v = await fn();
    return { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function check(name: string, calls: Call[], run: (c: Call) => unknown) {
  const py = await python(calls);
  const diffs: string[] = [];
  for (const [i, c] of calls.entries()) {
    if (i % 200 === 0) await new Promise((r) => setImmediate(r));
    const t = await tsAnswer(() => run(c));
    if (JSON.stringify(sortKeys(t)) !== JSON.stringify(sortKeys(py[i]))) {
      diffs.push(`${c.fn}(${JSON.stringify(c.args).slice(0, 200)})\n  py: ${JSON.stringify(sortKeys(py[i])).slice(0, 700)}\n  ts: ${JSON.stringify(sortKeys(t)).slice(0, 700)}`);
    }
  }
  console.log(`${name}: ${calls.length - diffs.length}/${calls.length} identical`);
  if (diffs.length) console.log(diffs.slice(0, 5).join("\n"));
  expect(diffs.length, `${name}: ${diffs.length} differences`).toBe(0);
}

// ---------------------------------------------------------------- inputs

const PHRASES = [
  "Leather Chelsea boots men", "Basmati rice wholly milled", "Cotton T-shirts men knitted", "Terry cotton bath towels",
  "Frozen vannamei shrimp", "Turmeric powder", "Hex bolts of steel", "Handmade woollen carpets", "Stainless steel kitchen utensils",
  "Ladies leather handbag", "Cumin seeds", "Solar panels", "Granite slabs polished",
  "men's leather chelsea boots with rubber sole", "ladies leather sandals with straps", "kids school shoes PU upper TPR sole",
  "kolhapuri chappal handmade leather", "sports sneakers textile upper rubber sole", "leather safety boots with steel toecap",
  "women's leather heels", "house slippers for women", "leather wallet for men", "canvas tote bag", "jute shopping bag",
  "leather belts for men", "leather gloves for motorcycle", "leather jacket women", "laptop bag faux leather", "travel duffel bag",
  "leather saddle and harness", "wet blue buffalo hides", "finished goat leather", "suede leather sq ft",
  "cotton bath towels", "bath salts", "kitchen towels cotton", "cotton bed sheets", "handloom cotton curtains",
  "brass diya", "brass idol statue", "wooden furniture sheesham", "marble handicrafts", "steel kitchen utensils",
  "basmati rice", "frozen shrimp", "cumin seeds", "black pepper", "green cardamom elaichi", "dried red chilli mirch",
  "haldi powder", "kaju cashew nuts", "darjeeling tea", "robusta coffee beans", "fresh mango alphonso", "onion",
  "paracetamol tablets", "smartphone", "electric motor", "centrifugal pump", "ball bearings", "auto spare parts brake pads",
  "gold jewellery necklace", "silver anklets", "cut and polished diamonds", "ceramic floor tiles", "glass bangles",
  "incense sticks agarbatti", "herbal shampoo", "cotton yarn", "denim jeans", "polo shirts", "hoodie", "kurti women",
  "silk saree", "woollen shawl", "plastic household articles", "paper cartons", "LED bulbs", "ceiling fan",
  "a", "", "the of and", "x", "12345", "hs code 640391",
];

function corpus(): string[] {
  const names = PRODUCTS.flatMap((h) => [index.products[h].name, index.products[h].common, index.products[h].technical]);
  const tariff = rows<{ description: string }>("SELECT description FROM hs6 ORDER BY code").map((r) => r.description)
    .filter((_, i) => i % 9 === 0).slice(0, 600);
  return [...new Set([...PHRASES, ...names, ...tariff])];
}

const productOf = (h: string) => ({ id: "p-" + h, name: index.products[h].name, price_inr: 450, moq: 500, unit: "pieces" });
const diagOf = (hs: string[]) => ({ products: hs.map((h) => ({ product_id: "p-" + h, name: index.products[h].name, classification: pseudoClass(h) })), readiness: {} });

const PROFILES = [
  {},
  { company: { name: "Kanpur Leathers", city: "Kanpur", gstin: "09AAACK1234F1ZX", iec: "ABCDE1234F" }, products: [{ name: "Boots", price_inr: 1450, moq: 600, monthly_capacity: 6000, unit: "pairs" }] },
  { company: { gstin: "09ABCDE1234F1Z5", website: "x.in", certifications: ["ISO 9001"], current_export_markets: ["UK"] }, products: [{ name: "Towels" }] },
  { company: { gstin: "27AAPFU0939F1ZV", email: "a@b.in", contact_name: "Ravi", phone: "+91 98" }, products: [{ name: "Rice", price_inr: 80.5, moq: 1000.0 }, { name: "Cumin", price_inr: 210 }] },
  { company: { gstin: "bad", iec: "abc" }, products: [] },
  { company: { gstin: "33AABCT1332L1ZZ", iec: "0312345678", certifications: [] }, products: [{ name: "Shirts", monthly_capacity: 0, moq: 0 }] },
];

describe("stage engine parity with Python", () => {
  const texts = corpus();

  test("gate and facts", async () => {
    await check("gate+facts", texts.flatMap((t) => [{ fn: "gate", args: [t] }, { fn: "facts", args: [t] }]),
      (c) => c.fn === "gate" ? st.gate(c.args[0] as string) : st.facts(c.args[0] as string));
  });

  test("tariff tree search", async () => {
    await check("tree_candidates", texts.map((t) => ({ fn: "tree_candidates", args: [t] })), (c) => st.treeCandidates(c.args[0] as string));
  });

  test("chapter rules ranking", async () => {
    const chaptered = texts.filter((t) => st.gate(t));
    await check("candidates", chaptered.map((t) => ({ fn: "candidates", args: [t] })), (c) => st.candidates(c.args[0] as string));
  });

  test("classify: descriptions, and HS codes printed on documents", async () => {
    const calls: Call[] = texts.map((t) => ({ fn: "classify", args: [{ name: t }] }));
    calls.push(...PHRASES.slice(0, 30).map((t, i) => ({ fn: "classify", args: [{ name: t, description: "made in India", hs_code: [PRODUCTS[i * 7 % PRODUCTS.length], "6403.91.10", "999999", "64039", "0909 31 00", ""][i % 6] }] })));
    calls.push(...PRODUCTS.slice(0, 60).map((h) => ({ fn: "classify", args: [{ name: index.products[h].common, hs_code: h + "00" }] })));
    await check("classify", calls, (c) => st.classify(c.args[0] as Record<string, unknown>, HOOKS));
  });

  test("GSTIN, readiness and families", async () => {
    const gst = ["", "09AAACK1234F1ZX", "09ABCDE1234F1Z5", "27AAPFU0939F1ZV", "33AABCT1332L1ZZ", " 07aaacr5055k1z5 ", "bad", "99ZZZZZ9999Z9Z9"];
    const diags = [diagOf(PRODUCTS.slice(0, 8)), diagOf(["640391", "420221", "090931"]), diagOf([])];
    const calls: Call[] = [...gst.map((g) => ({ fn: "check_gstin", args: [g] })), ...PROFILES.map((p) => ({ fn: "readiness", args: [p] })),
      ...diags.map((d) => ({ fn: "families", args: [d] }))];
    await check("gstin+readiness+families", calls, (c) => c.fn === "check_gstin" ? checkGstin(c.args[0] as string)
      : c.fn === "readiness" ? st.readiness(c.args[0] as Record<string, unknown>) : st.families(c.args[0] as Record<string, unknown>));
  });

  test("choose country: every product, and mixed baskets", async () => {
    const calls: Call[] = [{ fn: "destinations", args: [] }, ...PRODUCTS.map((h) => ({ fn: "choose_country", args: [diagOf([h])] }))];
    for (let i = 0; i + 2 < PRODUCTS.length; i += 23) calls.push({ fn: "choose_country", args: [diagOf(PRODUCTS.slice(i, i + 3))] });
    calls.push({ fn: "choose_country", args: [diagOf([])] });
    await check("choose_country", calls, (c) => c.fn === "destinations" ? st.destinations() : st.chooseCountry(c.args[0] as Record<string, unknown>));
  });

  test("buyers and outreach", async () => {
    const sample = PRODUCTS.filter((_, i) => i % 6 === 0);
    const calls: Call[] = [
      ...sample.map((h, i) => ({ fn: "find_buyers", args: [diagOf([h]), "GBR", PROFILES[i % PROFILES.length]] })),
      ...sample.slice(0, 20).map((h, i) => ({ fn: "find_buyers", args: [diagOf([h]), COUNTRIES[i % COUNTRIES.length], PROFILES[(i + 1) % PROFILES.length]] })),
      ...sample.slice(0, 30).map((h, i) => ({ fn: "outreach_template", args: [PROFILES[i % PROFILES.length], diagOf([h]), COUNTRIES[(i * 5) % COUNTRIES.length]] })),
    ];
    await check("buyers+outreach", calls, (c) => c.fn === "find_buyers"
      ? st.findBuyers(c.args[0] as Record<string, unknown>, c.args[1] as string, c.args[2] as Record<string, unknown>, 25, HOOKS)
      : st.outreachTemplate(c.args[0] as Record<string, unknown>, c.args[1] as Record<string, unknown>, c.args[2] as string, HOOKS));
  });

  test("quote: products x countries x settings", async () => {
    const calls: Call[] = [];
    const overrides = [null, { margin_pct: 20 }, { inr_per_usd: 86.5, insurance_pct: 0.5 }, { sea_freight_usd: 2500, inland_freight_inr: 30000 }, { margin_pct: 0, port_and_cha_inr: 0 }];
    PRODUCTS.filter((_, i) => i % 12 === 0).forEach((h, i) => {
      for (const iso of COUNTRIES) calls.push({ fn: "quote", args: [productOf(h), pseudoClass(h), iso, [null, 250, 1200][i % 3], overrides[(i + iso.length) % overrides.length]] });
    });
    calls.push({ fn: "quote", args: [{ name: "x" }, pseudoClass("640391"), "XXX", null, null] });
    await check("quote", calls, (c) => st.quote(c.args[0] as Record<string, unknown>, c.args[1] as Record<string, unknown>, c.args[2] as string,
      c.args[3] as number | null, (c.args[4] ?? {}) as Record<string, unknown>));
  });

  test("documents: CETA, REX statement, preferential, non-preferential", async () => {
    const calls: Call[] = [];
    const countries = ["GBR", "DEU", "ARE", "USA", "JPN", "AUS", "NOR", "BGD", "SAU", "CHE"];
    PRODUCTS.filter((_, i) => i % 40 === 0).forEach((h, i) => {
      for (const iso of countries) {
        const diag = diagOf([h, PRODUCTS[(i * 13 + 5) % PRODUCTS.length]]);
        const quotes = Object.fromEntries(diag.products.map((p) => [p.product_id, { qty: 500 + i, unit: "pieces", suggested_fob_usd_per_unit: 4.27 + i }]));
        const profile = { ...PROFILES[i % PROFILES.length], products: diag.products.map((p) => ({ id: p.product_id, name: p.name })) };
        const buyer = i % 2 ? { name: "Acme Imports Ltd", address: "1 High St", postcode: "M1 1AA" } : null;
        calls.push({ fn: "documents", args: [profile, diag, quotes, buyer, iso] });
      }
    });
    await check("documents", calls, (c) => st.documents(c.args[0] as Record<string, unknown>, c.args[1] as Record<string, unknown>,
      c.args[2] as Record<string, unknown>, c.args[3] as Record<string, unknown> | null, c.args[4] as string, HOOKS));
  });
});
