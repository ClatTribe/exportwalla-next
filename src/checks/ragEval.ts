// Which chunking and retrieval set-up finds the right passage? An ablation on the official trade documents: fixed
// 200-word windows vs structure-aware chunks, with and without contextual headers, BM25 alone vs BM25 + trigram
// TF-IDF fused by reciprocal rank. Questions come from the researched country rules; the gold answer is any passage
// from an official document for that country containing the answer's key phrases (fact cards excluded). Each variant
// re-chunks the cached documents into a scratch database. Metrics: hit@1, hit@3, MRR@5. Port of
// export-desk/evals/rag_eval.py.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../lib/config";
import { rows, switchDatabase } from "../lib/db";
import { rules } from "../lib/engine/markets";
import { search } from "../lib/engine/rag";
import { pyJson, pyRound } from "../lib/py";
import { Conn, init } from "../pipeline/core";
import { rulesDocs } from "../pipeline/rulesDocs";

const TEMPLATES: [string, string, RegExp[]][] = [
  ["proof", "What proof of origin does an Indian exporter need to claim preferential duty in {name}?",
    [/certificate of origin|origin declaration|declaration of origin|statement on origin|proof of origin/i]],
  ["validity", "How long is the proof of origin valid for {name}?", [/valid/i, /\b(months?|year|days)\b/i]],
  ["records", "How many years must the exporter keep records supporting origin for {name}?",
    [/records?|documents?/i, /\b(three|four|five|3|4|5)\b.{0,20}years?|years?/i]],
  ["transport", "What are the direct consignment or transit rules for goods shipped to {name}?",
    [/direct(ly)? (consign|transport|ship)|transit|transhipment|transshipment|non-alteration/i]],
  ["tolerance", "What de minimis tolerance of non-originating materials applies for {name}?", [/tolerance|de minimis/i, /per ?cent|%/i]],
];

function gold(iso: string, patterns: RegExp[]): Set<number> {
  const ids = new Set<number>();
  for (const c of rows<{ id: number; text: string }>(`SELECT c.id, c.text FROM rag_chunk c JOIN rag_doc d ON d.id=c.doc_id
      WHERE (',' || d.country || ',') LIKE ? AND d.url NOT LIKE 'country_rules:%'`, `%,${iso},%`)) {
    if (patterns.every((p) => p.test(c.text))) ids.add(c.id);
  }
  return ids;
}

function evaluate(hybrid: boolean) {
  let n = 0, hit1 = 0, hit3 = 0, mrr = 0;
  for (const [iso, r] of Object.entries(rules())) {
    for (const [, q, pats] of TEMPLATES) {
      const g = gold(iso, pats);
      if (!g.size) continue;
      const hits = search(q.replace("{name}", "name" in r ? r.name : iso), iso, 5, hybrid, 60, true);
      const ranks = hits.map((h, i) => (g.has(h.chunk_id) ? i : -1)).filter((i) => i >= 0);
      n++;
      hit1 += ranks.length && ranks[0] === 0 ? 1 : 0;
      hit3 += ranks.length && ranks[0] < 3 ? 1 : 0;
      mrr += ranks.length ? 1 / (ranks[0] + 1) : 0;
    }
  }
  const d = n || 1;
  return { questions: n, "hit@1": pyRound(hit1 / d, 3), "hit@3": pyRound(hit3 / d, 3), "mrr@5": pyRound(mrr / d, 3) };
}

export async function ragEval(): Promise<number> {
  const out: Record<string, unknown>[] = [];
  for (const strategy of ["fixed", "structured"]) {
    for (const contextual of [false, true]) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ew-rag-")), "variant.db");
      const conn = new Conn(file);
      init(conn);
      await rulesDocs(conn, strategy, contextual);
      const chunks = conn.get<{ n: number }>("SELECT COUNT(*) n FROM rag_chunk")!.n;
      conn.close();
      switchDatabase(file);
      for (const hybrid of [false, true]) {
        const row = { chunking: strategy, context_header: contextual, retrieval: hybrid ? "BM25+trigram RRF" : "BM25", chunks, ...evaluate(hybrid) };
        out.push(row);
        console.log(pyJson(row));
      }
      switchDatabase(null);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }
  const best = out.reduce((a, b) => ((b["mrr@5"] as number) > (a["mrr@5"] as number) || ((b["mrr@5"] === a["mrr@5"]) && (b["hit@1"] as number) > (a["hit@1"] as number)) ? b : a));
  fs.writeFileSync(process.env.RAG_EVAL_OUT ?? path.join(DATA_DIR, "rag_eval.json"), pyJson({ variants: out, best }, { indent: 1 }));
  console.log("best:", pyJson(best));
  return 0;
}
