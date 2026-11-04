// Retrieval over the official trade documents, at question time: BM25 (SQLite FTS5) over structure-aware chunks with
// contextual headers, own-country texts first, and the country's fact card. Port of export-desk/app/rag.py (the
// extraction and chunking half moves with the data pipeline in phase 9). Outputs must match the Python engine
// exactly (tests/rag.parity.test.ts).
import { rows } from "../db";
import { pyRound, pySum, uniq } from "../py";
import { type CitedDoc, LLMError, askCited, available, providerLabel } from "../llm";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SYNONYMS: Record<string, string[]> = {
  coo: ["certificate", "origin"], certificate: ["certificate", "certification", "proof"],
  proof: ["proof", "certificate", "declaration", "statement"],
  declaration: ["declaration", "statement"], self: ["self", "exporter", "declaration"],
  valid: ["valid", "validity", "period"], validity: ["valid", "validity", "months"],
  keep: ["records", "retain", "keep", "years"], records: ["records", "retain", "keep"],
  psr: ["product", "specific", "rules"], tolerance: ["tolerance", "minimis", "percent"],
  minimis: ["tolerance", "minimis"], transport: ["direct", "transport", "consignment", "transit"],
  transit: ["direct", "transport", "consignment", "transit", "transshipment"],
  cumulation: ["cumulation", "cumulate", "accumulation"], verify: ["verification", "verify", "request"],
  refund: ["refund", "retrospective", "subsequent"], rex: ["registered", "exporter", "rex", "statement"],
  issue: ["issued", "issuing", "authority", "agency"], who: ["authority", "agency", "issuing"],
  duty: ["duty", "tariff", "customs"], vat: ["vat", "tax", "value", "added"],
};
const STOP = new Set(("a an and or of the to in on for by is are be what which who how does do i we my our it with from at as " +
  "this that under need needs required require india indian exporter exporters export exports goods").split(" "));

export function terms(q: string): string[] {
  const toks = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t) && t.length > 1);
  return uniq(toks.flatMap((t) => SYNONYMS[t] ?? [t]));
}

/** Character trigram counts (for the optional hybrid reranker, off by default). */
function trigrams(s: string): Map<string, number> {
  const t = " " + s.toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 2; i++) m.set(t.slice(i, i + 3), (m.get(t.slice(i, i + 3)) ?? 0) + 1);
  return m;
}

function cos(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  const w = (g: string) => idf.get(g) ?? 1.0;
  const num = pySum([...a].filter(([g]) => b.has(g)).map(([g, v]) => v * b.get(g)! * w(g) ** 2));
  const na = Math.sqrt(pySum([...a].map(([g, v]) => (v * w(g)) ** 2)));
  const nb = Math.sqrt(pySum([...b].map(([g, v]) => (v * w(g)) ** 2)));
  return na && nb ? num / (na * nb) : 0.0;
}

const SEARCH_SQL = `SELECT c.id chunk_id, c.doc_id, c.heading, c.context, c.text, d.title, d.url, d.country, d.agreement,
               bm25(rag_fts, 1.5, 1.0) bm
        FROM rag_fts JOIN rag_chunk c ON c.id = rag_fts.rowid JOIN rag_doc d ON d.id = c.doc_id`;

const inCountry = (c: Json, country: string | null) => Boolean(country) && (c.country ?? "").split(",").includes(country);

/** Top-k chunks: [{chunk_id, doc_id, title, url, heading, text, agreement, country, score}]. */
export function search(query: string, country: string | null = null, k = 5, hybrid = false, pool = 60, officialOnly = false): Json[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const match = ts.map((t) => `"${t}"`).join(" OR ");
  const off = officialOnly ? 1 : 0;
  const cand = rows<Json>(`${SEARCH_SQL}
        WHERE rag_fts MATCH ? AND (? = 0 OR d.url NOT LIKE 'country_rules:%') ORDER BY bm LIMIT ?`, match, off, pool);
  if (country) { // make sure the asked country's documents are in the pool even if BM25 ranked them low
    const seen = new Set(cand.map((c) => c.chunk_id));
    const extra = rows<Json>(`${SEARCH_SQL}
            WHERE rag_fts MATCH ? AND ((',' || d.country || ',') LIKE ? OR d.country = 'ALL') AND (? = 0 OR d.url NOT LIKE 'country_rules:%')
            ORDER BY bm LIMIT ?`, match, `%,${country},%`, off, Math.floor(pool / 2));
    cand.push(...extra.filter((e) => !seen.has(e.chunk_id)));
  }
  if (!cand.length) return [];
  const ranks = new Map<unknown, number[]>(cand.map((c) => [c.chunk_id, []]));
  [...cand].sort((a, b) => a.bm - b.bm).forEach((c, r) => ranks.get(c.chunk_id)!.push(r));
  if (hybrid) {
    const qg = trigrams(ts.join(" "));
    const grams = new Map(cand.map((c) => [c.chunk_id, trigrams(c.context + " " + c.text)]));
    const df = new Map<string, number>();
    for (const gs of grams.values()) for (const g of gs.keys()) df.set(g, (df.get(g) ?? 0) + 1);
    const idf = new Map([...df].map(([g, n]) => [g, Math.log((1 + cand.length) / (1 + n)) + 1]));
    const cs = new Map(cand.map((c) => [c.chunk_id, cos(qg, grams.get(c.chunk_id)!, idf)]));
    [...cand].sort((a, b) => cs.get(b.chunk_id)! - cs.get(a.chunk_id)!).forEach((c, r) => ranks.get(c.chunk_id)!.push(r));
  }
  for (const c of cand) {
    let rrf = pySum(ranks.get(c.chunk_id)!.map((r) => 1 / (60 + r)));
    if (inCountry(c, country)) rrf *= 1.5;
    else if (c.country === "ALL") rrf *= 1.2; // DGFT rules apply to every destination
    c.score = pyRound(rrf, 5);
  }
  // A country-scoped question is answered by that country's texts (and DGFT rules for all countries) first.
  const own = (c: Json) => Boolean(country) && (inCountry(c, country) || c.country === "ALL");
  cand.sort((a, b) => (Number(!own(a)) - Number(!own(b))) || (b.score - a.score));
  const out: Json[] = [];
  const perDoc = new Map<unknown, number>();
  for (const c of cand) { // at most 3 passages per document keeps answers diverse
    if ((perDoc.get(c.doc_id) ?? 0) >= 3) continue;
    perDoc.set(c.doc_id, (perDoc.get(c.doc_id) ?? 0) + 1);
    out.push(Object.fromEntries(["chunk_id", "doc_id", "title", "url", "heading", "text", "agreement", "country", "score"].map((key) => [key, c[key]])));
    if (out.length === k) break;
  }
  return out;
}

/** The densest window of query terms, for showing a citation. Indexes by code point, as Python does. */
export function snippet(text: string, query: string, width = 320): string {
  const ts = terms(query);
  const cp = Array.from(text);
  const low = Array.from(text.toLowerCase());
  const sub = (a: string[], i: number, j: number) => a.slice(i, j).join("");
  const count = (s: string, t: string) => (t ? s.split(t).length - 1 : 0);
  let best = -1, bestI = 0;
  for (let i = 0; i < Math.max(cp.length - width, 1); i += 40) {
    const w = sub(low, i, i + width);
    const score = ts.reduce((s, t) => s + count(w, t), 0);
    if (score > best) [best, bestI] = [score, i];
  }
  if (bestI) { // start and end on word boundaries
    const sp = cp.indexOf(" ", bestI);
    bestI = 0 <= sp && sp < bestI + 30 ? sp + 1 : bestI;
  }
  let end = bestI + width;
  const sp = cp.lastIndexOf(" ", Math.min(end, cp.length) - 1);
  const spIn = sp >= bestI ? sp : -1;
  end = spIn > bestI + Math.floor(width / 2) && end < cp.length ? spIn : end;
  return (bestI ? "…" : "") + sub(cp, bestI, end) + (end < cp.length ? "…" : "");
}

/** Passages for a written answer: the best k hits, plus the country's researched fact card when search did not
 * already surface it. Agreement texts can describe superseded forms; the fact card says what applies today. */
export function contextPassages(query: string, country: string | null = null, k = 6): Json[] {
  let hits = search(query, country, k);
  if (country && !hits.some((h) => (h.url || "").startsWith("country_rules:"))) {
    const t = terms(query).map((x) => `"${x}"`).join(" OR ") || '"origin"';
    let card = rows<Json>(`SELECT c.id chunk_id, c.doc_id, c.heading, c.text, d.title, d.url, d.country, d.agreement
            FROM rag_fts JOIN rag_chunk c ON c.id = rag_fts.rowid JOIN rag_doc d ON d.id = c.doc_id
            WHERE rag_fts MATCH ? AND d.url = ? ORDER BY bm25(rag_fts, 1.5, 1.0) LIMIT 1`, t, `country_rules:${country}`);
    if (!card.length) {
      card = rows<Json>(`SELECT c.id chunk_id, c.doc_id, c.heading, c.text, d.title, d.url, d.country, d.agreement
                FROM rag_chunk c JOIN rag_doc d ON d.id = c.doc_id WHERE d.url = ? ORDER BY c.ord LIMIT 1`, `country_rules:${country}`);
    }
    if (card.length) hits = [...card, ...hits.slice(0, k - 1)];
  }
  return hits;
}

/** Two official passages behind a document section (stages.documents). Retrieval only, no AI call. */
export function citePassages(query: string, country: string): Json[] {
  try {
    return contextPassages(query, country, 6).slice(0, 2)
      .filter((h) => (h.country || "").split(",").includes(country))
      .map((h) => ({ title: h.title, url: h.url, heading: h.heading, snippet: snippet(h.text, query) }));
  } catch {
    return [];
  }
}

export const CITED_SYSTEM = `You answer an Indian exporter's question about importing into one country, using ONLY the documents
given: official trade-agreement texts and a researched fact card. Answer in 2-5 plain sentences a factory owner
understands. Cite the passage for every fact. If the documents do not answer it, say so and suggest asking the
export desk. Never guess a rate, a date or a form name.`;
export const MAX_CONTEXT_CHARS = 450_000; // about 110k tokens: every official text for one country fits

const pyLen = (s: string) => { let n = 0; for (const _ of s) n++; return n; }; // eslint-disable-line @typescript-eslint/no-unused-vars

/** Every indexed document for the country, rebuilt in reading order from its chunks. */
export function countryDocuments(country: string): (CitedDoc & { url: string })[] {
  const docs = rows<Json>("SELECT id, title, url FROM rag_doc WHERE (',' || country || ',') LIKE ? ORDER BY url LIKE 'country_rules:%' DESC, chars",
    `%,${country},%`);
  const out: (CitedDoc & { url: string })[] = [];
  let total = 0;
  for (const d of docs) {
    const parts: string[] = [];
    let last: string | null = null;
    for (const c of rows<Json>("SELECT heading, text FROM rag_chunk WHERE doc_id=? ORDER BY ord", d.id)) {
      parts.push((c.heading !== last ? `\n\n[${c.heading}]\n` : " ") + c.text);
      last = c.heading;
    }
    const text = parts.join("").trim();
    const n = pyLen(text);
    if (total + n > MAX_CONTEXT_CHARS) break;
    total += n;
    out.push({ title: d.title, url: d.url, text, context: `Source: ${d.url}` });
  }
  return out;
}

export async function answer(query: string, country: string | null = null, k = 4): Promise<Json> {
  const hits = contextPassages(query, country, 6);
  for (const h of hits) h.snippet = snippet(h.text, query);
  const out: Json = { query, country, passages: hits, method: "BM25 over structure-aware chunks with contextual headers" };
  if (country && available()) {
    const docs = countryDocuments(country);
    if (docs.length) {
      try {
        const res = await askCited(CITED_SYSTEM, docs, query);
        for (const c of res.citations) c.url = c.document_index != null ? docs[c.document_index].url : "";
        Object.assign(out, { answer: res.answer, citations: res.citations,
          method: `${providerLabel()} read all ${docs.length} documents for ${country} (whole texts, API citations)` });
      } catch (e) {
        if (!(e instanceof LLMError)) throw e;
        out.answer_error = e.message;
      }
    }
    out.passages = hits.slice(0, k);
    return out;
  }
  out.passages = hits.slice(0, k);
  return out;
}
