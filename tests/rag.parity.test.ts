// Retrieval parity: search, ranking, snippets, fact cards and whole-country documents must match the Python engine
// for the retrieval eval's questions (5 templates x every country) and free-form questions. AI answers are off on both
// sides here; the AI wrapper is tested separately in tests/llm.test.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DATA_DIR } from "../src/lib/config";
import * as rag from "../src/lib/engine/rag";
import { type Answer, type Call, python } from "./bridge";

const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "seo_index.json"), "utf8"));
const COUNTRIES: [string, string][] = Object.values(index.countries).map((c: any) => [c.iso3, c.name]); // eslint-disable-line @typescript-eslint/no-explicit-any

const TEMPLATES = [
  "What proof of origin does an Indian exporter need to claim preferential duty in {name}?",
  "How long is the proof of origin valid for {name}?",
  "How many years must the exporter keep records supporting origin for {name}?",
  "What are the direct consignment or transit rules for goods shipped to {name}?",
  "What de minimis tolerance of non-originating materials applies for {name}?",
];
const FREE = ["import vat", "certificate of origin", "rules of origin footwear", "proof of origin", "tariff elimination", "cumulation",
  "REX registered exporter statement", "who issues the COO", "duty refund after shipment", "self certification by exporter",
  "verification of origin by customs", "product specific rules for textiles", "how to claim lower duty", "anti-dumping", "", "a the of"];

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

async function check(name: string, calls: Call[], run: (c: Call) => unknown) {
  const py = await python(calls);
  const diffs: string[] = [];
  for (const [i, c] of calls.entries()) {
    if (i % 100 === 0) await new Promise((r) => setImmediate(r));
    let t: Answer;
    try { const v = await run(c); t = { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; } catch (e) { t = { ok: false, error: String(e) }; }
    if (JSON.stringify(sortKeys(t)) !== JSON.stringify(sortKeys(py[i]))) {
      diffs.push(`${c.fn}(${JSON.stringify(c.args).slice(0, 160)})\n  py: ${JSON.stringify(sortKeys(py[i])).slice(0, 600)}\n  ts: ${JSON.stringify(sortKeys(t)).slice(0, 600)}`);
    }
  }
  console.log(`${name}: ${calls.length - diffs.length}/${calls.length} identical`);
  if (diffs.length) console.log(diffs.slice(0, 4).join("\n"));
  expect(diffs.length, `${name}: ${diffs.length} differences`).toBe(0);
}

describe("retrieval parity with Python", () => {
  const questions: [string, string | null][] = [
    ...COUNTRIES.flatMap(([iso, name]) => TEMPLATES.map((t) => [t.replace("{name}", name), iso] as [string, string])),
    ...COUNTRIES.flatMap(([iso], i) => [[FREE[i % FREE.length], iso], [FREE[(i + 5) % FREE.length], null]] as [string, string | null][]),
  ];

  test("query terms", async () => {
    await check("terms", questions.map(([q]) => ({ fn: "rag_terms", args: [q] })), (c) => rag.terms(c.args[0] as string));
  });

  test("search: country-scoped, unscoped, official-only and hybrid", async () => {
    const calls: Call[] = questions.flatMap(([q, iso], i) => [
      { fn: "rag_search", args: [q, iso, 5, false, false] },
      { fn: "rag_search", args: [q, iso, 3, false, true] },
      ...(i % 10 === 0 ? [{ fn: "rag_search", args: [q, iso, 5, true, false] }, { fn: "rag_search", args: [q, null, 8, false, false] }] : []),
    ]);
    await check("search", calls, (c) => rag.search(c.args[0] as string, c.args[1] as string | null, c.args[2] as number, c.args[3] as boolean, 60, c.args[4] as boolean));
  });

  test("passages with the fact card, and snippets", async () => {
    const calls: Call[] = questions.map(([q, iso]) => ({ fn: "rag_context", args: [q, iso, 6] }));
    const py = await python(calls);
    const snips: Call[] = [];
    py.forEach((a, i) => { if (a.ok) for (const h of a.value as { text: string }[]) snips.push({ fn: "rag_snippet", args: [h.text, questions[i][0]] }); });
    snips.push({ fn: "rag_snippet", args: ["short text", "text"] }, { fn: "rag_snippet", args: ["𝕏 emoji 😀 text ".repeat(60), "text emoji"] });
    await check("context passages", calls, (c) => rag.contextPassages(c.args[0] as string, c.args[1] as string | null, c.args[2] as number));
    await check("snippets", snips, (c) => rag.snippet(c.args[0] as string, c.args[1] as string));
  });

  test("whole-country documents for cited answers", async () => {
    const calls: Call[] = COUNTRIES.map(([iso]) => ({ fn: "rag_country_docs", args: [iso] }));
    await check("country documents", calls, (c) => rag.countryDocuments(c.args[0] as string).map((d) => ({
      title: d.title, url: d.url, context: d.context, chars: Array.from(d.text).length,
      sha1: crypto.createHash("sha1").update(d.text).digest("hex") })));
  });

  test("answer without AI", async () => {
    const calls: Call[] = questions.filter((_, i) => i % 3 === 0).map(([q, iso]) => ({ fn: "rag_answer", args: [q, iso] }));
    await check("answer", calls, (c) => rag.answer(c.args[0] as string, c.args[1] as string | null));
  });
});
