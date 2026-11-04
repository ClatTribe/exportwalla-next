// The five self-serve stages: diagnose (1), choose country (2), find buyers (5), quote (6) and documents (8).
// Port of export-desk/app/stages.py; outputs must match it exactly (tests/stages.parity.test.ts).
// Numbers come from data and formulas; an LLM (when configured) only picks among candidates or drafts text.
import { SCOPE_HS4 } from "../config";
import { one, rows } from "../db";
import { S, fmtFixed, fmtG, fmtPct, pyFloatStr, pyRound, pySplit, pySum, uniq, WB } from "../py";
import * as markets from "./markets";
import { checkGstin } from "./gstin";
import { citePassages } from "./rag";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const FX_AS_OF = process.env.FX_AS_OF ?? "2 Nov 2026";
export const QUOTE_DEFAULTS: Json = {
  inr_per_usd: 88.0, inr_per_gbp: 117.0, inland_freight_inr: 25000, port_and_cha_inr: 18000,
  sea_freight_usd: 1800, insurance_pct: 0.3, uk_vat_pct: 20.0, margin_pct: 15.0,
};

/** Hooks for the parts that reach outside the database: the UK tariff search, an LLM, and cited passages. */
export interface Hooks {
  ukSearch?: (text: string) => Promise<[string, string][]>;
  llmJson?: ((system: string, content: string, schema: Json, effort?: string, maxTokens?: number) => Promise<Json>) | null;
  cite?: (query: string, country: string) => Json[];
}

// ---------------------------------------------------------------- Stage 1: diagnose

const SYNONYMS: Record<string, string> = {
  shoe: "footwear", shoes: "footwear", boot: "footwear ankle", boots: "footwear ankle",
  chelsea: "footwear ankle", sandal: "footwear sandals", sandals: "footwear sandals",
  chappal: "footwear sandals", kolhapuri: "footwear sandals", slipper: "footwear slippers indoor",
  slippers: "footwear slippers indoor", loafer: "footwear", loafers: "footwear",
  sneaker: "footwear sports", sneakers: "footwear sports", oxford: "footwear", brogue: "footwear",
  jutti: "footwear", mojari: "footwear", upper: "uppers", sole: "soles",
  handbag: "handbags", bag: "handbags bags", bags: "handbags bags", tote: "handbags",
  purse: "handbags wallets purses", wallet: "wallets purses pocket", backpack: "rucksacks bags",
  briefcase: "briefcases", laptop: "cases", suitcase: "suitcases trunks", belt: "belts",
  belts: "belts", glove: "gloves", gloves: "gloves", jacket: "apparel clothing",
  jackets: "apparel clothing", coat: "apparel clothing", saddle: "saddlery harness",
  hide: "hides leather", hides: "hides leather", cowhide: "bovine leather", buffalo: "bovine",
  goat: "goat kid", sheep: "sheep lamb", nubuck: "leather", suede: "leather",
  men: "men", mens: "men", women: "women", womens: "women", ladies: "women", kids: "children",
  rubber: "rubber", pu: "plastics", tpr: "rubber plastics", pvc: "plastics",
};
const STOP = new Set("a an and or of the with for in on to by other than not more less which its their be as at is".split(" "));

function tokens(text: string | null): string[] {
  const out: string[] = [];
  for (const w of (text ?? "").toLowerCase().match(/[a-z]+/g) ?? []) {
    if (STOP.has(w) || w.length < 2) continue;
    out.push(w, ...pySplit(SYNONYMS[w] ?? ""));
  }
  return out;
}

export const stem = (w: string) => (w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w);

/** Whole words, plurals included: "boots" is footwear, "coated" is not a coat, "skincare" is not a skin. */
const has = (text: string, ...words: string[]) => words.some((w) => new RegExp(`${WB}${w}(?:s|es)?${WB}`, "u").test(text));

// "pumps" and "belts" are shoes and leather goods only when nothing says machine
const MACHINE_WORDS = ["centrifugal", "submersible", "monoblock", "borewell", "water", "motor", "electric", "hp", "kw", "pumping",
  "hydraulic", "conveyor", "transmission", "v-belt", "timing", "fan", "industrial"];

const FOOTWEAR_WORDS = ["shoe", "boot", "chelsea", "sandal", "chappal", "kolhapuri", "slipper", "loafer", "sneaker", "trainer",
  "oxford", "brogue", "derby", "moccasin", "jutti", "mojari", "footwear", "clog", "mule", "pump", "heel"];
const ARTICLE_WORDS = ["bag", "handbag", "wallet", "purse", "belt", "glove", "jacket", "coat", "garment", "apparel", "case",
  "briefcase", "backpack", "rucksack", "satchel", "pouch", "card holder", "tote", "saddle", "harness", "luggage", "suitcase"];

/** Which chapter the product belongs to, from its type. Footwear and leather goods decide first. `context` (the whole
 * name and description) decides whether "pumps" and "belts" are machine parts. */
export function gate(text: string, context: string | null = null): string | null {
  const t = text.toLowerCase();
  const machine = has((context || text).toLowerCase(), ...MACHINE_WORDS);
  if (has(t, ...FOOTWEAR_WORDS.filter((w) => !(machine && w === "pump")))) return "64";
  if (has(t, ...ARTICLE_WORDS.filter((w) => !(machine && w === "belt")))) return "42";
  if (has(t, "hide", "skin", "crust", "wet blue", "tanned", "finished leather", "sq ?ft", "nubuck", "suede leather")) return "41";
  return null;
}

/** Deciding facts we can read from the description, and the ones that are missing. */
export function facts(text: string): Json {
  const t = text.toLowerCase();
  const re = (p: string) => new RegExp(p, "u").test(t);
  const f: Json = {
    upper: re("(leather|suede|nubuck)[^,.;]*upper|upper[^,.;]*(leather|suede|nubuck)") ? "leather"
      : re("(textile|canvas|fabric|mesh|knit)[^,.;]*upper|upper[^,.;]*(textile|canvas|fabric|mesh)") ? "textile"
      : re("(pu|pvc|plastic|synthetic|rubber)[^,.;]*upper|upper[^,.;]*(pu|pvc|plastic|synthetic)") ? "plastic"
      : has(t, "leather", "suede", "nubuck") && !has(t, "pu leather", "faux", "synthetic leather", "vegan") ? "leather"
      : null,
    sole: re("leather[^,.;]*sole|sole[^,.;]*leather") ? "leather"
      : has(t, "rubber", "tpr", "pu sole", "pvc", "eva", "plastic", "composition", "synthetic sole") ? "rubber" : null,
    ankle: has(t, "boot", "ankle", "chelsea", "chukka", "desert"),
    straps: has(t, "sandal", "strap", "chappal", "kolhapuri", "thong", "cut-out", "cut out"),
    slipper: has(t, "slipper", "indoor", "house shoe"),
    sports: has(t, "sneaker", "trainer", "sports", "running", "gym", "tennis"),
    gender: has(t, "men", "gents", "boys", "male") && !has(t, "women") ? "men"
      : has(t, "women", "ladies", "girls", "female") ? "women"
      : has(t, "kid", "child", "infant", "baby") ? "kids" : null,
    handmade: has(t, "hand-made", "handmade", "hand made", "handcrafted", "hand-stitched"),
    outer: has(t, "pu ", "faux", "synthetic", "vegan", "pvc", "plastic") ? "plastic"
      : has(t, "canvas", "jute", "cotton", "textile", "fabric") ? "textile"
      : has(t, "leather", "suede", "nubuck") ? "leather" : null,
    kind: has(t, "handbag", "hand bag", "clutch", "shoulder bag", "sling") ? "handbag"
      : has(t, "wallet", "purse", "card holder", "cardholder", "pouch", "key case", "coin") ? "pocket"
      : has(t, "briefcase", "laptop", "satchel", "executive", "portfolio") ? "briefcase"
      : has(t, "suitcase", "trolley", "trunk", "luggage", "vanity case") ? "trunk"
      : has(t, "backpack", "rucksack", "travel", "duffel", "duffle", "gym bag", "toilet bag") ? "travel"
      : has(t, "belt") ? "belt"
      : has(t, "glove", "mitt") ? "glove"
      : has(t, "jacket", "coat", "garment", "apparel", "trouser", "vest", "skirt") ? "apparel"
      : has(t, "tote", "bag", "shopper") ? "otherbag" : null,
  };
  const missing: string[] = [];
  if (gate(text) === "64") {
    if (!f.upper) missing.push("material of the upper");
    if (!f.sole) missing.push("material of the outer sole");
    if (!f.gender) missing.push("men's, women's or children's");
  }
  if (gate(text) === "42" && !f.outer) missing.push("material of the outer surface");
  f.missing = missing;
  return f;
}

/** Points for each deciding fact the tariff line agrees with; penalties for special cases not mentioned. */
export function ruleScore(path: string, code: string, f: Json, chapter: string | null): number {
  const p = (" > " + path.split(" > ").slice(1).join(" > ")).toLowerCase();
  let s = 0.0;
  if (chapter === "64") {
    const want = ({ leather: "6403", textile: "6404", plastic: "6402" } as Json)[f.upper || "leather"];
    s += code.startsWith(want) ? 4 : -4;
    if (f.sole === "leather") s += p.includes("outer soles of leather") ? 2 : -2;
    else if (f.sole === "rubber") s += (p.includes("> other footwear >") || p.includes("rubber")) && !p.includes("outer soles of leather") ? 2 : -2;
    s += p.includes("covering the ankle") === f.ankle ? 2 : -2;
    s += p.includes("vamp made of straps") === f.straps ? 2 : -1;
    s += p.includes("slippers") === f.slipper ? 2 : -2;
    s += (p.includes("sports footwear") || p.includes("tennis shoes")) === f.sports ? 2 : -2;
    if (f.gender === "men" || f.gender === "women") {
      s += p.includes(`for ${f.gender}`) ? 2 : (p.includes("for men") || p.includes("for women") ? -1 : 0);
      s -= p.includes("less than 24 cm") ? 2 : 0;
      s -= p.includes("cannot be identified") ? 1 : 0;
    } else if (f.gender === "kids") {
      s += p.includes("less than 24 cm") ? 2 : -1;
    }
    for (const special of ["wood", "ski", "snowboard", "toecap", "height of more than 3 cm"]) {
      if (p.includes(special) && !(f._text_has ?? {})[special]) s -= 3;
    }
  } else if (chapter === "42") {
    const kindPhrase = ({ handbag: "handbags", pocket: "carried in the pocket", briefcase: "executive-cases",
      trunk: "trunks, suitcases", travel: "travelling-bags", belt: "belts", glove: "gloves",
      apparel: "articles of apparel", otherbag: "> other >" } as Json)[f.kind];
    if (kindPhrase) s += p.includes(kindPhrase) ? 4 : -1;
    if (f.kind === "briefcase" && !p.includes("executive-cases")) s -= 2;
    if (f.kind === "otherbag" && (p.includes("travelling-bags") || p.includes("executive-cases"))) s -= 2;
    if (f.outer === "leather") s += p.includes("outer surface of leather") ? 2 : -2;
    else if (f.outer === "plastic") s += p.includes("of sheeting of plastics") || p.includes("> of plastics") ? 2 : -2;
    else if (f.outer === "textile") {
      const textileLine = p.includes("> of textile materials") || (p.includes("textile") && !p.includes("of sheeting of plastics")
        && !p.includes("moulded") && !p.includes("leather"));
      s += textileLine ? 2 : -2;
    }
    if (p.includes("musical instrument") || p.includes("aluminium") || p.includes("moulded plastic")) s -= 3;
    if (f.kind === "glove" && p.includes("sports") && !f.sports) s -= 2;
  }
  if (p.includes("hand-made")) s += f.handmade ? 1 : -0.5;
  return s;
}

/** Rank UK 10-digit leaves: chapter gate first, then deciding-fact rules, then word overlap. */
export function candidates(text: string, k = 12): Json[] {
  const chapter = gate(text);
  const f = facts(text);
  const t = text.toLowerCase();
  f._text_has = Object.fromEntries(([["wood", ["wood", "clog"]], ["ski", ["ski "]], ["snowboard", ["snowboard"]],
    ["toecap", ["toecap", "safety"]], ["height of more than 3 cm", ["heel"]]] as [string, string[]][])
    .map(([sp, trig]) => [sp, trig.some((w) => t.includes(w))]));
  let docs = rows<Json>("SELECT code, hs6, path, mfn_rate, india_rate FROM uk_commodity");
  if (chapter) {
    const inChapter = docs.filter((d) => d.code.startsWith(chapter));
    if (inChapter.length) docs = inChapter;
  }
  const df = new Map<string, number>();
  const toks = new Map<string, Set<string>>();
  for (const d of docs) {
    const tail = d.path.split(" > ").slice(1).join(" ") || d.path;
    const tset = new Set(tokens(tail).map(stem));
    toks.set(d.code, tset);
    for (const w of tset) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const q = new Set(tokens(text).map(stem));
  const n = docs.length || 1;
  const scored: [number, Json][] = docs.map((d) => {
    const tset = toks.get(d.code)!;
    const common = [...q].filter((w) => tset.has(w)).sort();
    const overlap = pySum(common.map((w) => Math.log(n / df.get(w)!) + 0.1));
    return [ruleScore(d.path, d.code, f, chapter) + 0.3 * overlap, d];
  });
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([s, d]) => ({ ...d, score: pyRound(s, 2), chapter_gate: chapter, missing: f.missing }));
}

// Everyday words Indian exporters use -> the words the tariff uses. Used by the general tree search.
const TRADE_WORDS: Record<string, string> = {
  basmati: "rice", chawal: "rice", jeera: "cumin", cumin: "cumin seeds", haldi: "turmeric curcuma",
  turmeric: "turmeric curcuma", chilli: "capsicum pimenta dried", chili: "capsicum pimenta dried",
  mirch: "capsicum pimenta", cardamom: "cardamoms", elaichi: "cardamoms", pepper: "pepper piper",
  tea: "tea", chai: "tea", coffee: "coffee", cashew: "cashew nuts", kaju: "cashew nuts",
  shrimp: "shrimps prawns crustaceans", prawn: "shrimps prawns crustaceans", prawns: "shrimps prawns",
  fish: "fish", buffalo: "bovine", meat: "meat", onion: "onions", grapes: "grapes", mango: "mangoes",
  sugar: "cane sugar", jaggery: "cane sugar", guar: "guar gum mucilages", sesame: "sesamum seeds",
  tshirt: "t-shirts singlets vests", tshirts: "t-shirts singlets vests", "t-shirt": "t-shirts singlets vests",
  "t-shirts": "t-shirts singlets vests", tee: "t-shirts singlets vests", tees: "t-shirts singlets vests",
  polo: "shirts knitted", hoodie: "sweatshirts pullovers", sweatshirt: "sweatshirts pullovers", kurta: "shirts blouses",
  kurti: "blouses shirts women", saree: "women garments woven", sari: "women garments woven",
  jeans: "trousers denim", denim: "denim", trouser: "trousers", dress: "dresses", shirt: "shirts",
  towel: "toilet linen terry towelling", towels: "toilet linen terry towelling", bedsheet: "bed linen",
  bedsheets: "bed linen", bedspread: "bedspreads", curtain: "curtains", cushion: "cushion covers",
  yarn: "yarn", fabric: "woven fabrics", carpet: "carpets", rug: "carpets rugs", durrie: "carpets woven",
  medicine: "medicaments retail", tablet: "medicaments retail doses", tablets: "medicaments retail doses",
  capsule: "medicaments retail doses", medicines: "medicaments retail", api: "pharmaceutical", generic: "medicaments",
  smartphone: "telephones cellular networks", mobile: "telephones cellular networks", phone: "telephones",
  bolt: "bolts screws", bolts: "bolts screws", nut: "nuts screws", nuts: "nuts screws", screw: "screws",
  fastener: "screws bolts", fasteners: "screws bolts", valve: "valves taps cocks", pump: "pumps",
  bearing: "bearings", gear: "gears gearing", casting: "castings", forging: "forged",
  pipe: "tubes pipes", pipes: "tubes pipes", tube: "tubes pipes", wire: "wire", cable: "insulated wire cables",
  transformer: "transformers", motor: "electric motors", tyre: "tyres pneumatic", tire: "tyres pneumatic",
  auto: "motor vehicles parts", spare: "parts", brake: "brakes", jewellery: "jewellery",
  jewelry: "jewellery", gold: "gold", silver: "silver", diamond: "diamonds",
  diamonds: "diamonds", kitchenware: "table kitchen household articles", utensil: "table kitchen household articles",
  steel: "iron steel", stainless: "stainless steel", brass: "copper zinc", aluminium: "aluminium",
  furniture: "furniture", chair: "seats", table: "tables furniture", lamp: "lamps lighting",
  toy: "toys", toys: "toys", incense: "agarbatti odoriferous", agarbatti: "agarbatti odoriferous",
  soap: "soap", shampoo: "shampoos", cosmetic: "beauty make-up preparations", perfume: "perfumes",
  essential: "essential oils", plastic: "plastics", granite: "granite", marble: "marble",
  tile: "ceramic tiles flags", tiles: "ceramic tiles flags", ceramic: "ceramic", glass: "glass",
  paper: "paper paperboard", carton: "cartons boxes", basket: "basketwork", handicraft: "articles",
  paracetamol: "medicaments", ibuprofen: "medicaments", antibiotic: "medicaments antibiotics",
  woollen: "wool", woolen: "wool", handmade: "knotted hand", "hand-knotted": "knotted",
  necklace: "jewellery", necklaces: "jewellery", ring: "jewellery", bangle: "jewellery",
  vannamei: "shrimps prawns", frozen: "frozen", fresh: "fresh chilled", dried: "dried",
  powder: "ground crushed", ground: "ground crushed", polished: "worked", slabs: "slabs",
  seeds: "seeds neither crushed", readymade: "garments", garment: "garments apparel",
  solar: "photosensitive semiconductor photovoltaic", led: "light-emitting diode", fan: "fans",
};

/** A tariff line without the word that says what the product is drops this far. */
const NAME_MISS = 15.0;

/** The tariff's words for a trade word, plurals included ("chillies" -> "chilli"). */
function tradeWords(w: string): string {
  for (const k of [w, w.endsWith("s") ? w.slice(0, -1) : null, w.endsWith("es") ? w.slice(0, -2) : null]) {
    if (k && Object.hasOwn(TRADE_WORDS, k)) return TRADE_WORDS[k];
  }
  return "";
}

const NEGATED = new RegExp(String.raw`${WB}(?:not|non|without|no)[${S}-]+[a-z-]+`, "gu");

// A use word next to the product noun only describes it: "bath towels" are towels, not bath preparations.
const USE_WORDS: Record<string, string[]> = {
  bath: ["towel", "towels", "mat", "mats", "robe", "robes", "linen"], kitchen: ["towel", "towels", "linen", "knife", "knives"],
  beach: ["towel", "towels", "bag", "bags"], table: ["linen", "cloth", "napkins", "napkin", "lamp", "lamps"],
  floor: ["mat", "mats", "rug", "rugs", "tiles"], door: ["mat", "mats"],
};

const NOT_PAREN = new RegExp(String.raw`\((?:not|excluding|other than)[^)]*\)`, "gu");
const EXCLUDING = new RegExp(WB + String.raw`(?:excluding|except)` + WB + String.raw`[^;)]*`, "gu"); // lists run past commas
const NOT_WORD = new RegExp(WB + String.raw`(?:not|other than)` + WB + String.raw`[^,;)]*`, "gu");
// words after "not"/"excluding"/"other than" describe what the line is NOT
const positive = (t: string) => t.toLowerCase().replace(NOT_PAREN, " ").replace(EXCLUDING, " ").replace(NOT_WORD, " ");
const afterFirst = (s: string, sep: string) => { const i = s.indexOf(sep); return i < 0 ? s : s.slice(i + sep.length); };

/** General classifier for any product: BM25 over the tariff tree, ranked by how many of the merchant's words each
 * line covers (rarer words weigh more), then BM25. `name` is what the product is; the rest of `text` only describes it,
 * so a line must match the name to rank ("Cumin seeds, whole" is a spice, not a whole hide). */
export function treeCandidates(textIn: string, k = 12, name: string | null = null): Json[] {
  const text = textIn.toLowerCase().replace(NEGATED, " "); // "not roasted" must not pull in roasted coffee
  let words = (text.match(/[a-z][a-z-]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2);
  words = words.filter((w) => !(USE_WORDS[w] ?? []).some((n) => words.includes(n)));
  const concepts = uniq(words).map((w) => [w, ...pySplit(tradeWords(w))]);
  const nameWords = new Set(String(name ?? "").toLowerCase().replace(NEGATED, " ").match(/[a-z][a-z-]+/g) ?? []);
  const inName = concepts.map((c) => nameWords.has(c[0]));
  const terms = uniq(concepts.flat()).filter((t) => !STOP.has(t) && t.length > 2);
  if (!terms.length) return [];
  const q = terms.map((t) => `"${t}"`).join(" OR ");
  const hits = rows<Json>(`SELECT code, context, text, bm25(tree_fts, 0, 1.0, 2.0) bm FROM tree_fts
                            WHERE tree_fts MATCH ? ORDER BY bm LIMIT 250`, q);
  const wordsOf = (s: string) => new Set((s.match(/[a-z]+/g) ?? []).map(stem));
  const texts = new Map<string, [Set<string>, Set<string>]>(hits.map((h) => [h.code,
    [wordsOf(positive(afterFirst(h.context, " > ") + " " + h.text)), wordsOf(positive(h.text))]]));
  const stems = concepts.map((c) => c.filter((t) => t.length > 2).map(stem));
  // chapter titles list everything in the chapter, so only the heading and the line count as coverage
  const weight = stems.map((st) => 1 + Math.log((1 + hits.length) / (1 + [...texts.values()].filter(([b]) => st.some((t) => b.has(t))).length)));
  const bms = hits.map((h) => h.bm as number);
  const [best, worst] = hits.length ? [Math.min(...bms), Math.max(...bms)] : [0, 0];
  // the anchor: the word of the name that the fewest tariff lines contain ("cumin", not "seeds"; "brass" for a
  // "brass diya", since no line says diya). Counted on the merchant's own word when the tariff uses it, else on its
  // tariff synonyms ("jeera" -> cumin), leaving out synonyms that are the merchant's other words ("dried")
  const heads = new Set(concepts.filter((_, i) => inName[i]).map((c) => stem(c[0])));
  const bodies = [...texts.values()].map(([b]) => b);
  let anchor: [number, number, string[]] | null = null;
  concepts.forEach((c, i) => {
    if (!inName[i]) return;
    const own = stem(c[0]);
    const terms = bodies.some((b) => b.has(own)) ? [own] : stems[i].filter((t) => !heads.has(t) || t === own);
    const n = bodies.filter((b) => terms.some((t) => b.has(t))).length;
    if (n && (!anchor || n < anchor[0])) anchor = [n, i, terms]; // ties: the earlier word, as min() over (n, i) does
  });
  const anchorTerms: string[] = anchor ? (anchor as [number, number, string[]])[2] : [];
  // word forms count: "cast" articles for "castings", "pack" for "packing"
  const hasAnchor = (ws: Set<string>) => anchorTerms.some((t) => ws.has(t) || [...ws].some((w) => w.length >= 4 && (t.startsWith(w) || w.startsWith(t))));
  // penalise only when the tariff's lines use the word at all, judged on each line's own words ("Spices; ginger"
  // lists turmeric only in its heading)
  const anchorInLines = [...texts.values()].some(([, ln]) => hasAnchor(ln));
  const said = text;
  const out = hits.map((h) => {
    const [body, line] = texts.get(h.code)!;
    const cover = pySum(weight.filter((_, i) => stems[i].some((t) => body.has(t))));
    const coverLine = pySum(weight.filter((_, i) => stems[i].some((t) => line.has(t))));
    const bmNorm = best !== worst ? (h.bm - worst) / (best - worst) : 1.0;
    let score = 3 * cover + 1.5 * coverLine + 2 * bmNorm + (h.code.length === 10 ? 0.5 : 0);
    if (anchorInLines && !hasAnchor(line)) score -= NAME_MISS; // the line misses the word that says what the product is
    // processing state is decisive (whole vs ground spices, rough vs worked stone)
    if (h.text.toLowerCase().includes("crushed or ground") && !/powder|ground|crushed|pisi/u.test(said)) score -= 4;
    if (/merely cut|roughly trimmed/u.test(h.text.toLowerCase()) && /polish|worked|finished/u.test(said)) score -= 8; // polished stone is worked
    return { code: h.code, hs6: h.code.slice(0, 6), path: `${h.context} > ${h.text}`, score: pyRound(score, 2), chapter_gate: null, missing: [] };
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

/** The UK government's own tariff search (open API): an independent cross-check, not a ruling. It matches all
 * words, so the query is relaxed until it answers. Returns [[10-digit code, path]]. */
export async function ukSearch(text: string): Promise<[string, string][]> {
  const words = (text.match(/[A-Za-z][A-Za-z-]+/g) ?? []).filter((w) => !STOP.has(w.toLowerCase()) && w.length > 2);
  const tries = [words.join(" "), words.slice(-2).join(" "), words.slice(0, 2).join(" "),
    ...[...words].sort((a, b) => b.length - a.length).slice(0, 3)];
  for (const q of uniq(tries.filter(Boolean))) {
    let body: Json;
    try {
      const r = await fetch("https://www.trade-tariff.service.gov.uk/api/v2/search?q=" + encodeURIComponent(q.slice(0, 120)),
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      body = await r.json();
    } catch {
      return [];
    }
    const attrs = ((body ?? {}).data ?? {}).attributes ?? {};
    if (attrs.type === "exact_search") {
      const code = String((attrs.entry ?? {}).id ?? "");
      if (/^\d+$/.test(code)) return [[code.padEnd(10, "0"), q]];
      continue;
    }
    const out: [string, string][] = [];
    for (const match of ["goods_nomenclature_match", "reference_match"]) {
      const m = attrs[match] ?? {};
      for (const kind of ["commodities", "headings"]) {
        for (const h of m[kind] ?? []) {
          const src = h._source ?? {};
          const code = src.goods_nomenclature_item_id ?? "";
          if (code && !code.endsWith("00000000")) out.push([code, (src.ancestor_descriptions ?? [src.description ?? ""]).join(" > ")]);
        }
      }
    }
    if (out.length) return out.slice(0, 5);
  }
  return [];
}

export const HS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["uk_code", "us_code", "confidence", "rationale", "alternative_uk_code", "what_would_change_it"],
  properties: {
    uk_code: { type: "string" }, us_code: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    rationale: { type: "string", description: "2-3 sentences citing the GRI and the deciding fact" },
    alternative_uk_code: { type: "string", description: "next most likely code or empty" },
    what_would_change_it: { type: "string", description: "the fact that would move it to the alternative" },
  },
};
export const HS_SYSTEM = `You are a customs classification assistant for Indian exporters.
Choose the UK 10-digit commodity code and the US HTS 10-digit statistical line for the product,
ONLY from the candidate lists given. Apply the General Rules of Interpretation: material of the
upper and outer sole decide footwear headings; composition and use decide leather goods.
If the description lacks a deciding fact (e.g. sole material, gender, ankle coverage, value per pair),
pick the most likely line, set confidence to medium or low, and name the missing fact.`;

const pyStr = (v: unknown) => (v == null || v === "" || v === 0 || v === false ? "" : String(v)); // str(v or "")

export async function classify(product: Json, hooks: Hooks = {}): Promise<Json> {
  const text = ["name", "description", "materials", "for_whom"].map((k) => pyStr(product[k])).join(" ");
  const docCode = pyStr(product.hs_code).replace(/\D/g, "");
  let docHs6 = docCode.length >= 6 ? docCode.slice(0, 6) : "";
  if (docHs6 && !one("SELECT 1 x FROM tree_fts WHERE code=?", docHs6) && !one("SELECT 1 x FROM uk_commodity WHERE hs6=?", docHs6)) {
    docHs6 = ""; // not a current HS code: ignore it and say so below
  }
  const chapter = gate(String(product.name || text).split(/[,;(]/)[0] + " ", text);
  let cands: Json[];
  let source: string;
  if (docHs6) {
    cands = rows<Json>("SELECT code, hs6, path, mfn_rate, india_rate FROM uk_commodity WHERE hs6=? ORDER BY code", docHs6)
      .map((c) => ({ ...c, score: 0.0, chapter_gate: docHs6.slice(0, 2), missing: [] }));
    if (chapter && cands.length) { // rank leaves inside the document's HS6 with the chapter rules
      const ranked = new Map(candidates(text, 400).map((c) => [c.code, c.score]));
      for (const c of cands) c.score = ranked.get(c.code) ?? -99;
      cands.sort((a, b) => b.score - a.score);
    }
    if (!cands.length) {
      const row = one<Json>("SELECT code, context, text FROM tree_fts WHERE code=?", docHs6)!;
      cands = [{ code: docHs6, hs6: docHs6, path: `${row.context} > ${row.text}`, score: 0.0, chapter_gate: docHs6.slice(0, 2), missing: [] }];
    }
    source = "document";
  } else if (chapter) {
    [cands, source] = [candidates(text), "rules"];
  } else {
    [cands, source] = [treeCandidates(text, 12, product.name ?? null), "tree search"];
  }
  if (!cands.length) {
    return { status: "no_match", text, candidates: [],
      message: "We could not match this to a tariff line. Add what it is made of and what it is for." };
  }
  const hs6s = uniq(cands.map((c) => c.hs6)).slice(0, 3);
  const us = rows<Json>(`SELECT code, hs6, path, general_rate FROM us_hts WHERE is_leaf=1 AND hs6 IN (${hs6s.map(() => "?").join(",")})`, ...hs6s).slice(0, 40);

  let pick: Json | null = null;
  let method = ({ document: "HS code printed on your document", rules: "rules", "tree search": "tariff search" } as Json)[source];
  if (hooks.llmJson && source !== "document") {
    let listing = "Candidates:\n" + cands.map((c) => `${c.code}: ${c.path}`).join("\n");
    listing += "\n\nUS candidates:\n" + us.map((u) => `${u.code}: ${u.path}`).join("\n");
    try {
      pick = await hooks.llmJson(HS_SYSTEM, `Product: ${text}\n\n${listing}`, HS_SCHEMA, "medium");
      method = "claude";
    } catch (e) {
      pick = null;
      method = `${method} (AI failed: ${(e as Error).message})`;
    }
  }
  const ukCodes = new Set(cands.map((c) => c.code));
  const usCodes = new Set(us.map((u) => u.code));
  if (pick && !ukCodes.has(pick.uk_code)) { // verifier: never accept a code outside the data
    method += "; AI code rejected (not in tariff)";
    pick = null;
  }
  if (!pick) {
    const top = cands[0], second = cands.length > 1 ? cands[1] : null;
    const margin = top.score - (second ? second.score : 0);
    const missing: string[] = top.missing || [];
    let conf: string, why: string;
    if (source === "document") {
      conf = new Set(cands.map((c) => c.hs6)).size === 1 && (cands.length === 1 || margin >= 2) ? "high" : "medium";
      why = `Your document gives HS ${docCode}. We kept every tariff line under ${docHs6}` +
        (cands.length > 1 ? ` and ranked the ${cands.length} national lines with the chapter rules.` : ".");
    } else if (source === "rules") {
      conf = missing.length || margin < 2 ? "medium" : "high";
      why = `Rules for chapter ${top.chapter_gate ?? "None"}: matched the deciding facts in your description against ` +
        `the UK tariff tree (score ${pyFloatStr(top.score)}, next ${second ? pyFloatStr(second.score) : "–"}).`;
    } else {
      conf = margin < 1.5 || pySplit(text).length < 4 ? "low" : "medium";
      why = `Tariff search: your words matched '${top.path.slice(-90)}' best (score ${pyFloatStr(top.score)}, next ` +
        `${second ? pyFloatStr(second.score) : "–"}). Upload an invoice or shipping bill with the HS code to confirm.`;
    }
    pick = { uk_code: top.code, us_code: "", confidence: conf, rationale: why,
      alternative_uk_code: second ? second.code : "",
      what_would_change_it: missing.length ? "Missing: " + missing.join(", ") : "" };
  }
  const hs6Code: string = pick.uk_code.slice(0, 6);
  if (!usCodes.has(pick.us_code)) {
    const same = us.filter((u) => u.hs6 === hs6Code);
    const f = facts(text);
    const usScore = (u: Json) => {
      const p = u.path.toLowerCase();
      let s = 0;
      if (f.gender === "men") s += new RegExp(WB + "men" + WB + "|for men", "u").test(p) ? 2 : 0;
      if (f.gender === "women") s += p.includes("women") ? 2 : 0;
      if (f.slipper) s += p.includes("house slippers") ? 3 : 0;
      else s -= p.includes("house slippers") ? 2 : 0;
      s -= ["pigskin", "work footwear", "valued not over"].some((w) => p.includes(w)) ? 2 : 0;
      s += f.sports && p.includes("tennis") ? 1 : (p.includes("tennis") ? -2 : 0);
      s += p.endsWith("other") ? 1 : 0;
      return s;
    };
    same.sort((a, b) => usScore(b) - usScore(a));
    pick.us_code = same.length ? same[0].code : "";
    if (pick.confidence === "high" && method === "claude") pick.confidence = "medium";
  }

  const ref = source === "document" ? null : await (hooks.ukSearch ?? ukSearch)(text);
  let refAgree: boolean | null = null;
  if (ref && ref.length) {
    refAgree = ref[0][0].slice(0, 4) === hs6Code.slice(0, 4);
    if (!refAgree && source === "tree search" && pick.confidence !== "low") pick.confidence = pick.confidence === "high" ? "medium" : "low";
  }
  const uk = one<Json>("SELECT * FROM uk_commodity WHERE code=?", pick.uk_code);
  const usRow = pick.us_code ? one<Json>("SELECT * FROM us_hts WHERE code=?", pick.us_code) : null;
  const hs6 = one<Json>("SELECT description FROM hs6 WHERE code=?", hs6Code);
  let note = "";
  if (product.hs_code && !docHs6) note = `The HS code on your document (${product.hs_code}) is not a current HS code, so we classified from the description.`;
  else if (docHs6 && docHs6 !== hs6Code) note = `Your document says ${docCode}; we picked ${hs6Code}. Check with our desk.`;
  return {
    status: "ok", method, text, source,
    hs6: hs6Code, hs6_description: (hs6 ?? {}).description ?? "",
    uk: uk && { code: uk.code, path: uk.path, mfn: uk.mfn_rate, mfn_pct: uk.mfn_pct, india: uk.india_rate, india_pct: uk.india_pct, fetched_at: uk.fetched_at },
    us: usRow && { code: usRow.code, path: usRow.path, general: usRow.general_rate, general_pct: usRow.general_pct, fetched_at: usRow.fetched_at },
    india_8digit: docCode.length >= 8 ? docCode.slice(0, 8) : "", confidence: pick.confidence,
    rationale: pick.rationale, note,
    alternative_uk_code: pick.alternative_uk_code ?? "",
    what_would_change_it: pick.what_would_change_it ?? "",
    candidates: cands.slice(0, 6).map((c) => ({ code: c.code, path: c.path.slice(-140) })),
    reference: ref && ref.length ? {
      source: "UK Trade Tariff search (official, open API)", top_code: ref[0][0], top_path: ref[0][1].slice(-160),
      agrees_hs4: refAgree, url: `https://www.trade-tariff.service.gov.uk/commodities/${ref[0][0]}`,
    } : null,
  };
}

export function readiness(profile: Json): Json {
  const c = profile.company ?? {};
  const prods: Json[] = profile.products ?? [];
  const [okGst, gstMsg, state] = checkGstin(c.gstin);
  const checks: [string, unknown, string, number][] = [
    ["GSTIN", okGst, `GSTIN ${gstMsg}` + (state ? ` (${state})` : ""), 3],
    ["IEC (import-export code)", /^[A-Z0-9]{10}$/.test((c.iec || "").toUpperCase()),
      c.iec ? "10-character IEC" : "No IEC found. Our desk can file it (stage 3).", 3],
    ["Prices per unit", prods.every((p) => p.price_inr) && prods.length > 0, "Needed for quotes and the proforma invoice.", 6],
    ["Monthly capacity", prods.some((p) => p.monthly_capacity), "Buyers ask this first.", 5],
    ["Minimum order (MOQ)", prods.some((p) => p.moq), "Needed in the first buyer email.", 5],
    ["Certifications or test reports", Boolean(c.certifications && c.certifications.length),
      "UK buyers ask for REACH/chrome VI tests; our desk plans lab tests (stage 4).", 4],
    ["Website or email for buyers", Boolean(c.website || c.email), "Buyers check you online.", 5],
    ["Export experience", Boolean(c.current_export_markets && c.current_export_markets.length), "First-time exporters get the full desk set-up.", 3],
  ];
  const items = checks.map(([n, ok, d, s]) => ({ check: n, ok: Boolean(ok), detail: d, stage: s }));
  const unknown = ["RCMC (export council membership)", "AD code at the port", "LUT for zero-rated exports"]
    .map((n) => ({ check: n, ok: null, detail: "We cannot see this from documents. Our desk confirms it.", stage: 3 }));
  const score = pyRound(100 * items.filter((i) => i.ok).length / items.length);
  return { score, items: [...items, ...unknown] };
}

let _hsRef: Map<string, string> | null = null;
const hsRef = () => (_hsRef ??= new Map(rows<{ code: string; text: string }>("SELECT code, text FROM hs_ref").map((r) => [r.code, r.text])));

/** Products grouped by HS chapter: spices and brass lamps sell to different countries, so they are planned separately. */
export function families(diag: Json): Json[] {
  const fam = new Map<string, Json>();
  for (const p of diag.products) {
    const c = p.classification;
    if (c.status !== "ok") continue;
    const ch = c.hs6.slice(0, 2);
    if (!fam.has(ch)) fam.set(ch, { code: ch, name: (hsRef().get(ch) ?? `Chapter ${ch}`).split(";")[0].slice(0, 60), products: [] });
    fam.get(ch)!.products.push(p.name);
  }
  return [...fam.values()];
}

/** The diagnosis restricted to one product family (HS chapter). */
export const focus = (diag: Json, family: string | null): Json => ({
  ...diag, products: diag.products.filter((p: Json) => p.classification.status === "ok" && (family == null || p.classification.hs6.slice(0, 2) === family)),
});

export async function diagnose(profile: Json, hooks: Hooks = {}): Promise<Json> {
  const products: Json[] = [];
  for (const p of profile.products ?? []) products.push({ product_id: p.id ?? null, name: p.name ?? null, classification: await classify(p, hooks) });
  return { products, readiness: readiness(profile) };
}

// ---------------------------------------------------------------- Stage 2: choose country

export const WEIGHTS = { demand: 0.35, growth: 0.15, foothold: 0.15, duty: 0.35 };
export const METHOD = "Score = 35% market size (latest imports, log-ranked) + 15% growth (latest year vs the year before) + " +
  "15% India's foothold (share of imports already from India, capped at 10%) + " +
  "35% duty for Indian goods (half: how low the duty on Indian goods is, 0% best, 25%+ worst; " +
  "half: India's edge over the normal rate, 10 points = full marks). " +
  "Markets: India's top 40 export destinations plus every EU and EFTA member (66 countries). " +
  "Markets under US$5m of imports are left out. Sources: UN Comtrade (imports reported by each country), " +
  "WITS/TRAINS and the UK and US tariffs (duty), country_rules.json (trade agreements).";

const EU27 = "AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE".split(" ");
const EFTA = ["CHE", "NOR", "ISL", "LIE"];
const ALWAYS = ["NZL", "MUS"];

/** India's top 40 export destinations plus every EU and EFTA member (port of scope.destinations). */
export function destinations(): string[] {
  const top = rows<{ iso3: string }>(`SELECT c.iso3, c.name, e.value_usd FROM india_export e JOIN countries c ON c.m49=e.partner_m49
      WHERE e.level='TOTAL' AND e.year=2024 AND c.is_group=0 AND c.iso3 NOT LIKE '\\_%' ESCAPE '\\' AND e.partner_m49<>0
      ORDER BY e.value_usd DESC`).slice(0, 40).map((r) => r.iso3);
  return uniq([...top, ...EU27, ...EFTA, ...ALWAYS]);
}

const EXCLUDED_CHAPTERS = ["27", "88", "89", "93", "26", "97", "99"]; // fuel, aircraft, ships, arms, ores, art, misc

/** The HS6 lines India exports most (top 300, less what SMEs do not ship) plus the leather and footwear wedge (port of
 * scope.products). */
export function scopeProducts(): string[] {
  const top = rows<{ hs: string }>(`SELECT hs, value_usd FROM india_export WHERE level='6' AND year=2024 AND partner_m49=0
      AND substr(hs,1,2) NOT IN (${EXCLUDED_CHAPTERS.map(() => "?").join(",")}) ORDER BY value_usd DESC LIMIT ?`,
  ...EXCLUDED_CHAPTERS, 300).map((r) => r.hs);
  const leather = rows<{ code: string }>(`SELECT code FROM hs6 WHERE hs4 IN (${SCOPE_HS4.map(() => "?").join(",")})`, ...SCOPE_HS4)
    .map((r) => r.code);
  return uniq([...top, ...leather]);
}

function pctRank(values: number[]): (v: number) => number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return (v) => (n > 1 ? s.indexOf(v) / (n - 1) : 1.0);
}

const oksOf = (diag: Json): Json[] => diag.products.map((p: Json) => p.classification).filter((c: Json) => c.status === "ok");

export function chooseCountry(diag: Json, fetchMissing?: (hs6s: string[], universe: string[]) => void): Json {
  const oks = oksOf(diag);
  const hs6s = uniq<string>(oks.map((c) => c.hs6)).sort();
  if (!hs6s.length) return { status: "no_products", markets: [] };
  const universe = new Set(destinations());
  const marks = hs6s.map(() => "?").join(",");
  const have = new Set(rows<{ hs6: string }>(`SELECT DISTINCT hs6 FROM trade_flow WHERE hs6 IN (${marks}) AND partner_m49=0`, ...hs6s).map((r) => r.hs6));
  const missing = hs6s.filter((h) => !have.has(h));
  if (missing.length && fetchMissing) {
    try { fetchMissing(missing, [...universe].sort()); } catch (e) { console.log("on-demand Comtrade fetch failed:", e); }
  }
  const years = rows<{ year: number }>(`SELECT DISTINCT year FROM trade_flow WHERE hs6 IN (${marks}) ORDER BY year DESC`, ...hs6s).map((r) => r.year);
  if (years.length < 2) {
    return { status: "no_trade_data", markets: [], method: METHOD,
      message: "UN Comtrade did not answer for this product just now (it limits free use). Try again in a minute, or call our desk." };
  }
  const [y1, y0] = years;
  const flows = rows<Json>(`
        SELECT t.reporter_m49 m49, c.iso3, c.name, t.year, t.partner_m49, SUM(t.value_usd) v
        FROM trade_flow t JOIN countries c ON c.m49=t.reporter_m49
        WHERE t.hs6 IN (${marks}) AND t.year IN (?,?) AND c.is_group=0 AND t.reporter_m49 NOT IN (699, 0)
        GROUP BY t.reporter_m49, t.year, t.partner_m49
        ORDER BY t.reporter_m49, t.year, t.partner_m49`, ...hs6s, y1, y0);
  const agg = new Map<string, Json>();
  for (const f of flows) {
    if (!universe.has(f.iso3)) continue;
    if (!agg.has(f.iso3)) agg.set(f.iso3, { imp: new Map<number, number>(), ind: new Map<number, number>() });
    const a = agg.get(f.iso3)!;
    Object.assign(a, { iso3: f.iso3, name: f.name });
    if (f.partner_m49 === 0) a.imp.set(f.year, (a.imp.get(f.year) ?? 0) + (f.v || 0));
    else if (f.partner_m49 === 699) a.ind.set(f.year, (a.ind.get(f.year) ?? 0) + (f.v || 0));
  }
  const markets_: Json[] = [];
  const noData = [...universe].filter((u) => !agg.has(u)).sort();
  for (const [iso, a] of agg) {
    const yr = a.imp.get(y1) ? y1 : y0; // some countries have not reported the latest year yet
    const imp1 = a.imp.get(yr) ?? 0, imp0 = a.imp.get(yr - 1) ?? 0;
    if (imp1 < 5e6) continue;
    markets_.push({ iso3: iso, name: a.name, year: yr, imp1, imp0, ind1: a.ind.get(yr) ?? 0 });
  }
  if (!markets_.length) return { status: "no_trade_data", markets: [], method: METHOD, message: "No importing country above US$5m." };
  for (const m of markets_) {
    m.growth = m.imp0 ? m.imp1 / m.imp0 - 1 : 0;
    m.india_share = m.imp1 ? m.ind1 / m.imp1 : 0;
    const duties = oks.map((c) => markets.tariff(m.iso3, c.hs6, c));
    const known = duties.filter((d) => d.india_pct != null && d.mfn_pct != null);
    const sum = (k: "india_pct" | "mfn_pct") => pySum(known.map((d) => d[k] as number));
    m.india_duty_pct = known.length ? pyRound(sum("india_pct") / known.length, 2) : null;
    m.mfn_duty_pct = known.length ? pyRound(sum("mfn_pct") / known.length, 2) : null;
    m.duty_edge_pts = known.length ? pyRound(m.mfn_duty_pct - m.india_duty_pct, 2) : null;
    m.duty_source = known.length ? known[0].source : "no tariff data";
    m.duty_note = markets.agreementNote(m.iso3);
    m.deal = markets.dealShort(m.iso3);
  }
  const clampG = (g: number) => Math.max(-0.5, Math.min(1.0, g));
  const rankDemand = pctRank(markets_.map((m) => Math.log(m.imp1)));
  const rankGrowth = pctRank(markets_.map((m) => clampG(m.growth)));
  for (const m of markets_) {
    const duty = m.india_duty_pct == null ? 0.5
      : 0.5 * (1 - Math.min(m.india_duty_pct / 25.0, 1.0)) + 0.5 * Math.min(Math.max(m.duty_edge_pts, 0) / 10.0, 1.0);
    const parts: Json = { demand: rankDemand(Math.log(m.imp1)), growth: rankGrowth(clampG(m.growth)),
      foothold: Math.min(m.india_share / 0.10, 1.0), duty };
    m.parts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, pyRound(v as number, 2)]));
    m.score = pyRound(100 * pySum(Object.entries(parts).map(([k, v]) => (WEIGHTS as Json)[k] * (v as number))));
    m.buyer_data = m.iso3 === "GBR" ? "HMRC importer list (free)" : "Our desk sources buyers";
    const dutyTxt = m.india_duty_pct != null
      ? `duty on Indian goods ${fmtG(m.india_duty_pct)}%` + (m.duty_edge_pts ? ` vs ${fmtG(m.mfn_duty_pct)}% normal` : "")
      : "duty not loaded";
    m.why = `Imports US$${fmtFixed(m.imp1 / 1e6, 0, { comma: true })}m in ${m.year} (${fmtPct(m.growth, 0, true)} vs ${m.year - 1}); ` +
      `${fmtPct(m.india_share, 1)} already from India; ${dutyTxt}; ${m.duty_note}.`;
  }
  markets_.sort((a, b) => b.score - a.score);
  const slim = markets_.map((m) => Object.fromEntries(["iso3", "name", "score", "imp1", "growth", "india_share", "india_duty_pct", "duty_note", "deal"].map((k) => [k, m[k]])));
  return { status: "ok", years: [y1, y0], hs6: hs6s, method: METHOD, weights: WEIGHTS,
    markets: markets_.slice(0, 5), all: slim, recommended: markets_[0].iso3, considered: markets_.length,
    universe: universe.size, no_data: noData };
}

// ---------------------------------------------------------------- Stage 5: find buyers

export const OUTREACH_SCHEMA = {
  type: "object", additionalProperties: false, required: ["subject", "body"],
  properties: { subject: { type: "string" },
    body: { type: "string", description: "Plain text email. Use {buyer_name} where the company name goes." } },
};
export const OUTREACH_SYSTEM = `You write a first B2B email from an Indian manufacturer to an importer abroad.
120-170 words, plain and specific, no hype, no attachments promised that don't exist.
Lead with the product and one concrete reason to talk now (for example a duty preference for Indian
goods under a trade agreement, if the facts give one). Include capacity/MOQ/price basis only if given.
End with one easy ask (send catalogue and FOB price list, or a 15-minute call).
Include a one-line opt-out ("If this isn't relevant, reply 'no' and I won't write again").`;

/** Where buyers for this market are found when no free importer register exists. All official sources. */
export function buyerChannels(country: string, oks: Json[]): Json[] {
  const od = markets.originDocument(country);
  const ch: Json[] = [];
  const epcs = new Map<string, { name: string; url: string }>();
  for (const c of oks) { const e = markets.epcFor(c.hs6); if (e) epcs.set(e.name, e); }
  for (const epc of epcs.values()) ch.push({ name: epc.name, url: epc.url, what: "Member buyer enquiries, buyer-seller meets and India pavilions at trade fairs" });
  if (od.mission_url) ch.push({ name: "Indian mission, commerce wing", url: od.mission_url, what: "Trade enquiries from local importers; can share importer lists on request" });
  ch.push({ name: "DGFT Trade Connect", url: "https://trade.gov.in", what: "Government portal: trade leads and the mission/EPC network in one place" });
  return ch;
}

export async function findBuyers(diag: Json, country: string, profile: Json, limit = 25, hooks: Hooks = {}): Promise<Json> {
  const oks = oksOf(diag);
  if (country !== "GBR") {
    return { status: "desk", country, buyers: [], channels: buyerChannels(country, oks),
      outreach: await outreachTemplate(profile, diag, country, hooks),
      message: "No free, official register of importers exists for this market (the UK publishes one; " +
        "most countries do not). We do not show scraped or guessed names. Our desk sources " +
        "verified importers from customs shipment records for you, and these official channels work in parallel." };
  }
  const cn8s = uniq([...oks.filter((c) => c.uk).map((c) => c.uk.code.slice(0, 8)), ...oks.filter((c) => !c.uk).map((c) => c.hs6)]).sort();
  const hs6s = uniq<string>(oks.map((c) => c.hs6)).sort();
  if (!cn8s.length) return { status: "no_products", buyers: [] };
  const loaded = one<{ n: number }>("SELECT COUNT(*) n FROM uk_trader_commodity")!.n;
  if (!loaded) return { status: "no_buyer_data", buyers: [], message: "UK importer data is still loading. Re-run in a few minutes." };
  const like = hs6s.map(() => "tc.cn8 LIKE ?").join(" OR ");
  const recs = rows<Json>(`SELECT t.trader_id, t.name, t.address, t.postcode, tc.cn8, tc.year, tc.import_months
        FROM uk_trader_commodity tc JOIN uk_trader t ON t.trader_id=tc.trader_id
        WHERE (${like}) AND tc.import_months <> ''`, ...hs6s.map((h) => h + "%"));
  const by = new Map<unknown, Json>();
  for (const r of recs) {
    if (!by.has(r.trader_id)) by.set(r.trader_id, { trader_id: r.trader_id, name: r.name, address: r.address, postcode: r.postcode, evidence: [], exact: 0, months: 0 });
    const b = by.get(r.trader_id)!;
    const months = (r.import_months || "").split(",").filter((m: string) => m.trim()).length;
    b.evidence.push({ cn8: r.cn8, year: r.year, months });
    if (cn8s.includes(r.cn8) || cn8s.includes(r.cn8.slice(0, 6))) b.exact += 1;
    if (r.year === Math.max(...b.evidence.map((e: Json) => e.year))) b.months = Math.max(b.months, months);
  }
  const buyers = [...by.values()].sort((a, b) => (b.exact - a.exact) || (b.months - a.months) || (b.evidence.length - a.evidence.length)).slice(0, limit);
  for (const b of buyers) {
    b.evidence.sort((x: Json, y: Json) => (y.year - x.year) || (x.cn8 < y.cn8 ? -1 : x.cn8 > y.cn8 ? 1 : 0));
    b.evidence_text = b.evidence.slice(0, 3).map((e: Json) => `HMRC: imported ${e.cn8} in ${e.year} (${e.months} months)`).join("; ");
  }
  return { status: "ok", country: "GBR", cn8: cn8s, total_importers: by.size, buyers,
    outreach: await outreachTemplate(profile, diag, "GBR", hooks), source: "HMRC uktradeinfo, importers by 8-digit commodity code",
    channels: buyerChannels("GBR", oks) };
}

const numText = (v: unknown) => (v || "?"); // Python: _n(v) or '?'

export async function outreachTemplate(profile: Json, diag: Json, country = "GBR", hooks: Hooks = {}): Promise<Json> {
  const c = profile.company ?? {};
  const prodsAll: Json[] = profile.products ?? [];
  const names = prodsAll.slice(0, 3).map((p) => p.name).join(", ");
  const oks = oksOf(diag);
  let duty = "";
  if (oks.length) {
    const t = markets.tariff(country, oks[0].hs6, oks[0]);
    if (t.mfn_pct && t.india_pct != null && t.india_pct < t.mfn_pct) {
      duty = `Import duty on this product is ${fmtG(t.mfn_pct)}% normally and ${fmtG(t.india_pct)}% from India ` +
        `(${markets.agreementNote(country)}).`;
    }
  }
  const factsText = `Company: ${c.name || "[company]"}, ${c.city || ""} India. Products: ${names}. ` +
    `${duty} Capacity/MOQ/prices: ` +
    prodsAll.slice(0, 3).map((p) => `${p.name}: ${numText(p.monthly_capacity)} ${p.unit || ""}/month, MOQ ${numText(p.moq)}, ` +
      `₹${numText(p.price_inr)} ${p.price_unit || ""}`).join("; ") +
    `. Sender: ${c.contact_name || "[name]"}, ${c.email || "[email]"}, ${c.phone || ""}.`;
  let note: string;
  if (hooks.llmJson) {
    try {
      const out = await hooks.llmJson(OUTREACH_SYSTEM, factsText, OUTREACH_SCHEMA, "low", 2000);
      return { ...out, method: "claude", facts_used: factsText };
    } catch (e) {
      note = (e as Error).message;
    }
  } else {
    note = "no API key";
  }
  const body = `Dear {buyer_name} team,\n\nWe are ${c.name || "[company]"}, a manufacturer in ` +
    `${c.city || "[city]"}, India, making ${names}. ${duty}\n\n` +
    "Would it help if I sent our catalogue and FOB price list? A 15-minute call also works.\n\n" +
    `Regards,\n${c.contact_name || "[name]"}\n${c.email || ""} ${c.phone || ""}\n\n` +
    "If this isn't relevant, reply 'no' and I won't write again.";
  const subj = (prodsAll.length ? prodsAll[0].name : "Products") + (prodsAll.length > 1 ? ` and ${prodsAll.length - 1} more` : "");
  return { subject: `Supplier from India: ${subj}` + (duty ? " (lower duty for Indian origin)" : ""), body,
    method: note ? `template (${note})` : "template", facts_used: factsText };
}

// ---------------------------------------------------------------- Stage 6: quote

export function quote(product: Json, classification: Json, country = "GBR", qtyIn: number | null = null, overrides: Json = {}): Json {
  const lane = markets.lane(country);
  const p: Json = { ...QUOTE_DEFAULTS, sea_freight_usd: lane.sea_freight_usd,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)) };
  const qty = qtyIn || product.moq || product.last_order_qty || 1000;
  const price = product.price_inr || 0;
  const exworks = price * qty;
  const margin = exworks * p.margin_pct / 100;
  const fobInr = exworks + margin + p.inland_freight_inr + p.port_and_cha_inr; // the price you quote
  const fobUsd = fobInr / p.inr_per_usd;
  const freightUsd = p.sea_freight_usd;
  const insuranceUsd = (fobUsd + freightUsd) * p.insurance_pct / 100;
  const cifUsd = fobUsd + freightUsd + insuranceUsd;
  const t = markets.tariff(country, classification.hs6 ?? null, classification);
  const [vatDefault, vatName, vatUrl] = markets.vat(country);
  let vatPct = vatDefault;
  if (country === "GBR") vatPct = p.uk_vat_pct ?? (vatPct || 20.0);
  const lines: [string, number | null, string, string][] = [
    ["Ex-works value", exworks, "₹", "your price × quantity"],
    [`Your export margin (${fmtG(p.margin_pct)}%)`, margin, "₹", "editable"],
    ["Inland freight to port", p.inland_freight_inr, "₹", "assumption, editable"],
    ["Port, CHA and documents", p.port_and_cha_inr, "₹", "assumption, editable"],
    ["FOB value", fobInr, "₹", "what you quote on FOB terms (incl. margin)"],
    ["FOB value", fobUsd, "US$", `at ₹${p.inr_per_usd}/US$ (assumed rate, set ${FX_AS_OF}; edit it)`],
    ["Sea freight", freightUsd, "US$", `indicative, ${lane.lane}; editable`],
    ["Insurance", insuranceUsd, "US$", `${p.insurance_pct}% of FOB + freight`],
    ["CIF value", cifUsd, "US$", "cost, insurance and freight to the destination port"],
  ];
  const res: Json = { qty, unit: product.unit || "pieces", assumptions: p, country, tariff: t, lane: lane.lane, vat_source: vatUrl };
  let cur: string, value: number, fx = 1;
  if (country === "GBR") {
    fx = p.inr_per_usd / p.inr_per_gbp;
    [cur, value] = ["£", cifUsd * fx];
    lines.push(["CIF value", value, "£", `at ₹${p.inr_per_gbp}/£`]);
  } else {
    [cur, value] = ["US$", t.basis === "FOB" ? fobUsd : cifUsd];
  }
  const basisNote = `duty charged on ${t.basis} value`;
  if (t.india_pct == null) {
    lines.push([`Import duty in ${country}`, null, cur, "tariff not loaded for this market: our desk confirms the rate"]);
    Object.assign(res, { landed_total: t.basis === "CIF" ? value : cifUsd * (cur === "US$" ? 1 : fx),
      currency: cur, duty_saved: 0, landed_note: "before destination duty" });
  } else {
    const duty = value * t.india_pct / 100;
    const dutyMfn = value * (t.mfn_pct || 0) / 100;
    const label = t.india_pct < (t.mfn_pct || 0) ? "with origin claim" : "for Indian goods";
    lines.push([`Import duty ${label} (${fmtG(t.india_pct)}%)`, duty, cur, `${t.source}; ${basisNote}`]);
    if (t.india_pct < (t.mfn_pct || 0)) {
      lines.push([`Import duty without origin proof (${fmtG(t.mfn_pct as number)}%)`, dutyMfn, cur, "what the buyer pays if origin is not proved"]);
    }
    if (country === "USA") lines.push(["Extra US tariffs on Indian goods", null, cur, t.note.slice(0, 160)]);
    const landedCif = cifUsd * (cur === "£" ? fx : 1);
    if (vatPct) {
      const vatAmt = (landedCif + duty) * vatPct / 100;
      lines.push([`Import ${vatName} (${fmtG(vatPct)}%, buyer usually reclaims)`, vatAmt, cur, `${fmtG(vatPct)}% of CIF + duty`]);
    }
    Object.assign(res, { landed_total: landedCif + duty, currency: cur, duty_saved: dutyMfn - duty,
      landed_note: t.precision === "national line" ? "" : `duty is the ${t.precision}: our desk confirms the exact line` });
  }
  res.landed_per_unit = res.landed_total / qty;
  Object.assign(res, {
    lines: lines.map(([a, b, c, d]) => ({ label: a, amount: b == null ? null : pyRound(b, 2), currency: c, note: d })),
    suggested_fob_usd_per_unit: pyRound(fobUsd / qty, 2),
    note: ("You set the final price. " + (t.note || "")).trim(),
  });
  return res;
}

// ---------------------------------------------------------------- Stage 8: documents

function originSection(country: string, c: Json, seller: Json, buyerD: Json, items: Json[], invNo: string, today: string, cite: Hooks["cite"]): Json {
  const citations = (q: string) => (cite ? cite(q, country) : []);
  if (country === "GBR") {
    return { title: "Origin declaration draft: India–UK CETA (Annex 3B template)", kind: "ceta",
      template_url: "https://assets.publishing.service.gov.uk/media/687e5e56791bb4d8c309a068/uk_india_ceta_annex3b_origin_declaration_template.pdf",
      fields: [
        { n: 1, field: "Signatory (exporter or producer): name, title, email, phone", value: `${c.contact_name || "[name]"}, ${c.email || "[email]"}, ${c.phone || "[phone]"}` },
        { n: 2, field: "Exporter", value: `${seller.name}, ${seller.address}` },
        { n: 3, field: "Producer (if different)", value: "Same as exporter" },
        { n: 4, field: "Importer", value: `${buyerD.name}, ${buyerD.address}` },
        { n: 5, field: "Signatory's reference number (IEC for Indian signatories)", value: seller.iec },
        { n: 6, field: "HS 6-digit, description, invoice number and date", value: items.map((i) => `${i.hs6} ${i.description}`).join("; ") + `; ${invNo} dated ${today}` },
        { n: 7, field: "Origin criterion (WO / PE / PSR + rule from Annex 3A)", value: "REVIEWER TO CONFIRM from the bill of materials (our desk)" },
        { n: 8, field: "Non-alteration (transit through a non-party)", value: "Direct shipment India → UK (confirm)" },
        { n: 9, field: "Roll-up / absorption used", value: "No (confirm)" },
        { n: 10, field: "Single shipment or multiple identical shipments (max 12 months)", value: "Single shipment" },
        { n: 11, field: "Declaration, signature, record-keeping undertaking", value: "Signed by the exporter with DSC on DGFT Trade Connect" },
      ],
      warning: "Draft only. The exporter signs and carries liability for 5 years. Our desk reviews the origin working before you sign.",
      citations: citations("origin declaration exporter statement content") };
  }
  const od = markets.originDocument(country);
  const pref: string | null = od.preferential;
  const qtyTxt = items.filter((i) => i.qty).map((i) => `${fmtG(i.qty)} ${i.unit}`).join("; ");
  if (pref && /statement on origin|\bREX\b/i.test(pref)) {
    // EU / Norway / Swiss / Turkish GSP: the registered exporter writes a statement on the invoice; no certificate
    const statement = `The exporter ${seller.name} (Number of Registered Exporter: IN[REX number]) of the products covered ` +
      "by this document declares that, except where otherwise clearly indicated, these products are of " +
      "India preferential origin according to rules of origin of the Generalised System of Preferences of " +
      "the European Union and that the origin criterion met is [P or W + heading].\n\n" +
      `[Place: ${c.city || "[city]"}], [Date: ${today}]`;
    return { title: `Proof of origin: ${pref.split(";")[0]}`, kind: "statement", agreement: markets.dealShort(country),
      issued_by: "You, as a registered exporter (REX)", how: od.how, source_url: od.source_url, statement,
      fields: [
        { n: 1, field: "REX number (register once with DGFT / the issuing authority)", value: "IN + your REX number, e.g. IN" + (seller.iec !== "[IEC]" ? seller.iec : "[IEC]") + "…" },
        { n: 2, field: "Where it goes", value: `On the commercial invoice ${invNo} or another commercial document` },
        { n: 3, field: "Origin criterion per product", value: "P (wholly obtained, e.g. spices grown in India) or W + HS heading (sufficiently worked); our desk confirms" },
        { n: 4, field: "When a REX number is needed", value: "When the consignment's originating value exceeds EUR 6,000; below that any exporter can make it out" },
      ],
      non_preferential: od.non_preferential, import_notes: od.import_notes,
      warning: "Wording from Annex 22-07 of the EU customs rules (UCC-IA). Check it against the official text before use; our desk confirms GSP eligibility for your product.",
      citations: citations("statement on origin registered exporter REX text") };
  }
  const fields = [
    { n: 1, field: "Exporter (name, address, IEC)", value: `${seller.name}, ${seller.address}, IEC ${seller.iec}` },
    { n: 2, field: "Consignee", value: `${buyerD.name}, ${buyerD.address}` },
    { n: 3, field: "Means of transport and route", value: "Sea, Nhava Sheva (INNSA1) → destination port (confirm)" },
    { n: 4, field: "HS code and description of goods", value: items.map((i) => `${i.hs6} ${i.description}`).join("; ") },
    { n: 5, field: "Quantity and invoice number/date", value: `${qtyTxt}; ${invNo} dated ${today}` },
    { n: 6, field: "Origin criterion", value: "Our desk confirms from your bill of materials" },
    { n: 7, field: "Declaration by the exporter", value: "Signed with your DSC when you apply on DGFT Trade Connect (trade.gov.in)" },
  ];
  const nonPref = od.non_preferential;
  return { title: pref ? `Proof of origin: ${pref}` : "Certificate of origin (non-preferential)",
    kind: pref ? "preferential" : "non_preferential", agreement: markets.dealShort(country),
    issued_by: od.issued_by || (nonPref ?? {}).issued_by || null,
    how: od.how, source_url: od.source_url, fields: pref || (nonPref && Object.keys(nonPref).length) ? fields : [],
    non_preferential: nonPref, import_notes: od.import_notes,
    warning: "Draft data for the application. The issuing agency checks and issues it; our desk files it with you.",
    citations: citations(`proof of origin certificate ${pref || "certificate of origin"}`) };
}

/** Today's date as Python's date.today().isoformat() gives it (local time). */
export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function documents(profile: Json, diag: Json, quotes: Json, buyer: Json | null = null, country = "GBR", hooks: Hooks = {}, today = todayIso()): Json {
  const c = profile.company ?? {};
  const invNo = `PI-${today.replaceAll("-", "")}-001`;
  const items: Json[] = [];
  for (const p of diag.products) {
    const cls = p.classification;
    const prod = (profile.products ?? []).find((x: Json) => (x.id ?? null) === p.product_id) ?? {};
    const q = quotes[p.product_id] ?? {};
    if (cls.status !== "ok") continue;
    const unitUsd = q.suggested_fob_usd_per_unit ?? null;
    const national = country === "GBR" && cls.uk ? cls.uk.code : country === "USA" && cls.us ? cls.us.code : cls.hs6;
    items.push({ description: prod.name ?? null, hs6: cls.hs6, uk_code: (cls.uk ?? {}).code ?? null,
      national_code: national, itc_hs: cls.india_8digit || "",
      qty: q.qty ?? null, unit: q.unit ?? null, unit_price_usd: unitUsd,
      amount_usd: pyRound((unitUsd || 0) * (q.qty || 0), 2) });
  }
  const seller = { name: c.name || "[company]", address: [c.address, c.city, c.state].filter(Boolean).join(", ") || "[address]",
    gstin: c.gstin || "[GSTIN]", iec: c.iec || "[IEC]", email: c.email ?? null, phone: c.phone ?? null };
  const b = buyer ?? {};
  const buyerD = { name: b.name || "[buyer]", address: [b.address, b.postcode].filter(Boolean).join(", ") || "[address]" };
  const total = pySum(items.map((i) => i.amount_usd));
  const proforma = { title: "Proforma invoice", number: invNo, date: today, seller, buyer: buyerD,
    incoterm: "FOB Nhava Sheva (JNPT), Incoterms 2020", currency: "US$", items, total: pyRound(total, 2),
    payment_terms: "30% advance by TT, 70% against copy of bill of lading (edit as agreed)",
    validity: "30 days", origin: "India", destination: country, bank: "[bank name, account, SWIFT, AD code]" };
  const packing = { title: "Packing list", number: invNo.replace("PI", "PL"), date: today, seller, buyer: buyerD,
    rows: items.map((i) => ({ description: i.description, hs6: i.hs6, qty: i.qty, unit: i.unit, per_carton: 12,
      cartons: Math.ceil((i.qty || 0) / 12), net_kg: "[fill]", gross_kg: "[fill]", cbm: "[fill]" })),
    marks: `${"name" in b ? b.name : "[buyer]"} / ${invNo} / Made in India / C/No. 1-up` };
  const origin = originSection(country, c, seller, buyerD, items, invNo, today, hooks.cite ?? citePassages);
  return { country, proforma, packing_list: packing, origin_declaration: origin };
}
