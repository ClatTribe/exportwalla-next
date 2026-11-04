// The no-AI classifier on products described the way merchants describe them: a name plus words about state,
// grade and packing ("Cumin seeds, whole, machine cleaned"). Labelled HS6 codes; both engines must agree on every
// case, and the share right must not fall below what the name-anchored search reached (24 of 30; 16 before it).
import fs from "node:fs";
import { expect, test } from "vitest";
import { classify } from "../src/lib/engine/stages";
import { python } from "./bridge";

const CASES: [string, string, string][] = JSON.parse(fs.readFileSync("tests/fixtures/classify_labelled.json", "utf8"));
const HOOKS = { ukSearch: async () => [] as [string, string][], llmJson: null };

test("merchant-style products: right HS6 for at least 24 of 30, same answer as Python", async () => {
  const py = await python(CASES.map(([name, description]) => ({ fn: "classify", args: [{ name, description }] })));
  let right = 0;
  const misses: string[] = [], differ: string[] = [];
  for (const [i, [name, description, want]] of CASES.entries()) {
    const ts = await classify({ name, description }, HOOKS);
    const pyHs6 = py[i].ok ? (py[i].value as { hs6?: string }).hs6 : `error ${py[i].ok ? "" : py[i].error}`;
    if (ts.hs6 !== pyHs6) differ.push(`${name} | ${description}: ts ${ts.hs6}, python ${pyHs6}`);
    if (ts.hs6 === want) right++;
    else misses.push(`${name} | ${description}: ${ts.hs6} (${ts.hs6_description?.slice(0, 50)}), want ${want}`);
  }
  console.log(`${right}/${CASES.length} right\n  ` + misses.join("\n  "));
  expect(differ).toEqual([]);
  expect(right).toBeGreaterThanOrEqual(24);
}, 300_000);
