// Replay the golden set built by reviewing in the workspace: each reviewed HS code becomes a case (your verdict, or
// your correction), the classifier re-runs on the same text, scored at 4, 6, 8 and 10 digits; other features report
// the share of verdicts that were right. Reviews are in the local database (data/local.db). Port of
// export-desk/evals/run_evals.py.
import fs from "node:fs";
import { LOCAL_DB } from "../lib/config";
import { classify } from "../lib/engine/stages";
import { liveHooks } from "../lib/server/hooks";
import { localDb } from "../lib/server/local";

type Review = { feature: string; item_key: string; input: string | null; output: string | null; verdict: string; correction: string | null };

function expected(r: Review): string | null {
  if (r.verdict === "correct") return r.output ? JSON.parse(r.output) : null;
  return (r.correction || "").replace(/\D/g, "") || null;
}

export async function runEvals(): Promise<number> {
  const reviews: Review[] = fs.existsSync(LOCAL_DB)
    ? localDb().prepare("SELECT * FROM review WHERE verdict IN ('correct','wrong') ORDER BY id").all() as Review[] : [];
  const latest = new Map<string, Review>(); // the last verdict per (feature, item) wins
  for (const r of reviews) latest.set(JSON.stringify([r.feature, r.item_key, r.input]), r);
  const hits = new Map<number, number>(), totals = new Map<number, number>();
  let n = 0;
  for (const r of latest.values()) {
    if (!["uk_code", "hs6"].includes(r.feature) || !r.input) continue;
    const exp = expected(r);
    if (!exp) continue;
    const got = await classify({ name: JSON.parse(r.input), description: "" }, liveHooks());
    if (got.status !== "ok") continue;
    const pred: string = r.feature === "uk_code" ? got.uk.code : got.hs6;
    n++;
    for (const d of [4, 6, 8, 10]) {
      if (exp.length >= d) { totals.set(d, (totals.get(d) ?? 0) + 1); hits.set(d, (hits.get(d) ?? 0) + (pred.slice(0, d) === exp.slice(0, d) ? 1 : 0)); }
    }
  }
  if (n) {
    console.log(`HS classification replay: ${n} golden cases`);
    for (const d of [4, 6, 8, 10]) {
      const t = totals.get(d);
      if (t) console.log(`  top-1 at ${d} digits: ${hits.get(d)}/${t} = ${Math.round(100 * hits.get(d)! / t)}%`);
    }
  } else console.log("HS classification replay: no golden cases yet (review some HS codes in the workspace)");
  const by = new Map<string, [number, number]>();
  for (const r of latest.values()) {
    const v = by.get(r.feature) ?? [0, 0];
    v[r.verdict === "correct" ? 0 : 1]++;
    by.set(r.feature, v);
  }
  console.log("\nReviewer verdicts by feature (latest verdict per item):");
  for (const [feature, [ok, bad]] of [...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    console.log(`  ${feature.padEnd(22)} ${ok}/${ok + bad} right (${Math.round(100 * ok / (ok + bad))}%)`);
  }
  return 0;
}
