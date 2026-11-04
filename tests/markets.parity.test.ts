// Duty engine parity: the TypeScript port must give exactly the Python engine's answer for every input the site uses.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DATA_DIR } from "../src/lib/config";
import { rows } from "../src/lib/db";
import * as m from "../src/lib/engine/markets";
import { fmtFixed, fmtG, fmtPct, pyFloatStr, pyRound, pySum } from "../src/lib/py";
import { type Answer, type Call, python, ts } from "./bridge";

const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "seo_index.json"), "utf8"));
const COUNTRIES: string[] = Object.keys(index.countries);
const PRODUCTS: string[] = Object.keys(index.products);
const RULE_ISOS = Object.keys(m.rules());
const ALL_ISOS = [...new Set([...COUNTRIES, ...RULE_ISOS, "XXX"])];

async function compare(calls: Call[], run: (c: Call) => Answer) {
  const py = await python(calls);
  const diffs: string[] = [];
  for (const [i, c] of calls.entries()) {
    if (i % 500 === 0) await new Promise((r) => setImmediate(r)); // let the test runner breathe on long suites
    const t = run(c);
    if (JSON.stringify(sortKeys(t)) !== JSON.stringify(sortKeys(py[i]))) {
      diffs.push(`${c.fn}(${JSON.stringify(c.args)})\n  py: ${JSON.stringify(py[i]).slice(0, 400)}\n  ts: ${JSON.stringify(t).slice(0, 400)}`);
    }
  }
  return { n: calls.length, diffs };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

function report(name: string, r: { n: number; diffs: string[] }) {
  console.log(`${name}: ${r.n - r.diffs.length}/${r.n} identical`);
  if (r.diffs.length) console.log(r.diffs.slice(0, 8).join("\n"));
  expect(r.diffs.length, `${name}: ${r.diffs.length} differences`).toBe(0);
}

describe("duty engine parity with Python", () => {
  test("tariff: every country x product on the site", async () => {
    const calls = COUNTRIES.flatMap((iso) => PRODUCTS.map((h) => ({ fn: "tariff", args: [iso, h] })));
    const cls = new Map<string, unknown>();
    report("tariff", await compare(calls, (c) => {
      const [iso, h] = c.args as [string, string];
      if (!cls.has(h)) cls.set(h, m.pseudoClass(h));
      return ts(() => m.tariff(iso, h, cls.get(h) as Record<string, unknown>));
    }));
  });

  test("pseudo class: the UK and US line each product is priced on", async () => {
    report("pseudo_class", await compare(PRODUCTS.map((h) => ({ fn: "pseudo_class", args: [h] })),
      (c) => ts(() => m.pseudoClass(c.args[0] as string))));
  });

  test("Section 301: every US tariff line and every HS6", async () => {
    const leaves = rows<{ code: string; hs6: string }>("SELECT code, hs6 FROM us_hts WHERE is_leaf=1");
    const hs6s = [...new Set(leaves.map((l) => l.hs6))];
    const calls: Call[] = [
      ...leaves.map((l) => ({ fn: "us_line_add", args: [l.code, l.hs6] })),
      ...hs6s.map((h) => ({ fn: "us_section301", args: [h] })),
      ...leaves.filter((_, i) => i % 7 === 0).map((l) => ({ fn: "us_section301", args: [l.hs6, l.code] })),
    ];
    report("section301", await compare(calls, (c) => c.fn === "us_line_add"
      ? ts(() => m.usLineAdd(c.args[0] as string, c.args[1] as string))
      : ts(() => m.usSection301(c.args[0] as string, (c.args[1] as string) ?? null))));
  });

  test("country facts: deal label, agreement note, VAT, lane, origin document", async () => {
    const fns: Record<string, (iso: string) => unknown> = {
      deal_short: m.dealShort, agreement_note: m.agreementNote, agreements_in_force: m.agreementsInForce,
      vat: m.vat, lane: m.lane, origin_document: m.originDocument, preferential_doc: m.preferentialDoc,
    };
    const calls = ALL_ISOS.flatMap((iso) => Object.keys(fns).map((fn) => ({ fn, args: [iso] })));
    report("country facts", await compare(calls, (c) => ts(() => fns[c.fn](c.args[0] as string))));
  });

  test("council by chapter and agreement labels", async () => {
    const chapters = Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, "0") + "0000");
    const names = [...new Set(Object.values(m.rules()).flatMap((r) => (r.agreements ?? []).map((a: { name: string }) => a.name)))];
    const calls: Call[] = [...chapters.map((h) => ({ fn: "epc_for", args: [h] })), ...names.map((n) => ({ fn: "short", args: [n] }))];
    report("epc + labels", await compare(calls, (c) => c.fn === "epc_for" ? ts(() => m.epcFor(c.args[0] as string)) : ts(() => m.short(c.args[0] as string))));
  });

  test("number helpers: Python round() and :g formatting", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const xs = [0.125, 0.375, 2.675, 1.005, 12, 12.5, 0.1, 100, 1e6, 123456.7, 1234567, 0.0001, 0.00001, -3.335, 7.6666666]
      .concat(Array.from({ length: 5000 }, () => pyRound((rnd() - 0.2) * 10 ** Math.floor(rnd() * 8 - 3), Math.floor(rnd() * 6)) + 0)); // + 0: JSON can't carry -0 to Python
    const calls: Call[] = xs.flatMap((x) => [{ fn: "py_round", args: [x, 2] }, { fn: "py_round", args: [x, 0] }, { fn: "fmt_g", args: [x] }]);
    const lists = Array.from({ length: 2000 }, (_, i) => Array.from({ length: 2 + (i % 9) }, () => (rnd() - 0.3) * 10 ** Math.floor(rnd() * 12 - 4) + 0));
    calls.push(...xs.flatMap((x) => [{ fn: "fmt_comma0", args: [x * 1e5] }, { fn: "fmt_pct0s", args: [x / 50] }, { fn: "fmt_pct1", args: [x / 1000] }, { fn: "float_str", args: [x] }]),
      ...lists.map((l) => ({ fn: "py_sum", args: [l] })));
    const one = (c: Call) => {
      const x = c.args[0] as number;
      switch (c.fn) {
        case "fmt_g": return fmtG(x);
        case "fmt_comma0": return fmtFixed(x, 0, { comma: true });
        case "fmt_pct0s": return fmtPct(x, 0, true);
        case "fmt_pct1": return fmtPct(x, 1);
        case "float_str": return pyFloatStr(x);
        case "py_sum": return pySum(c.args[0] as number[]);
        default: return pyRound(x, c.args[1] as number);
      }
    };
    report("number helpers", await compare(calls, (c) => ts(() => one(c))));
  });
});
