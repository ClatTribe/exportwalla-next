// Document reading parity: the rule-based reader (fields, products, prices, HS codes), spreadsheets and CSV, the OCR
// call, the whole no-AI extraction and the profile merge must give exactly the Python engine's answer. Corpus:
// tests/fixtures/intake (written by export-desk/evals/intake_corpus.py, plus real documents).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import * as intake from "../src/lib/engine/intake";
import { type Answer, type Call, python } from "./bridge";

const DIR = path.resolve("tests/fixtures/intake");
const TEXTS: [string, string][] = JSON.parse(fs.readFileSync(path.join(DIR, "texts.json"), "utf8"));
const FILES = fs.readdirSync(DIR).filter((f) => f !== "texts.json").sort();
const b64 = (f: string) => fs.readFileSync(path.join(DIR, f)).toString("base64");
const buf = (s: string) => Buffer.from(s, "base64");

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

async function check(name: string, calls: Call[], run: (c: Call) => unknown) {
  const py = await python(calls);
  const diffs: string[] = [];
  for (const [i, c] of calls.entries()) {
    let t: Answer;
    try { const v = await run(c); t = { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; } catch (e) { t = { ok: false, error: String(e) }; }
    const same = t.ok && py[i].ok ? JSON.stringify(sortKeys(t)) === JSON.stringify(sortKeys(py[i])) : t.ok === py[i].ok; // both raised = same
    if (!same) diffs.push(`${c.fn}(${JSON.stringify(c.args).slice(0, 140)})\n  py: ${JSON.stringify(sortKeys(py[i])).slice(0, 700)}\n  ts: ${JSON.stringify(sortKeys(t)).slice(0, 700)}`);
  }
  console.log(`${name}: ${calls.length - diffs.length}/${calls.length} identical`);
  if (diffs.length) console.log(diffs.slice(0, 4).join("\n"));
  expect(diffs.length, `${name}: ${diffs.length} differences`).toBe(0);
}

describe("document reading parity with Python", () => {
  test("reading files: OCR on PDFs and photos, spreadsheets, CSV, text", async () => {
    await check("read_text", FILES.map((f) => ({ fn: "read_text", args: [f, b64(f)] })), (c) => intake.readText(c.args[0] as string, buf(c.args[1] as string)));
  });

  test("rule-based reading: synthetic documents and OCR text of real ones", async () => {
    const ocr = await python(FILES.filter((f) => /\.(pdf|png|jpg)$/.test(f)).map((f) => ({ fn: "read_text", args: [f, b64(f)] })));
    const real = FILES.filter((f) => /\.(pdf|png|jpg)$/.test(f)).map((f, i) => [f, (ocr[i] as { value: [string, string] }).value[0]] as [string, string]);
    const all = [...TEXTS, ...real, ...real.map(([, t]) => ["typed note", t.slice(0, 800)] as [string, string])];
    await check("parse_document", all.map(([n, t]) => ({ fn: "parse_document", args: [n, t] })), (c) => intake.parseDocument(c.args[0] as string, c.args[1] as string));
  });

  test("spreadsheets and CSV: rows as text and products from columns", async () => {
    const sheets = FILES.filter((f) => /\.(xlsx|csv)$/.test(f));
    const csvs = ["", "a", "a,b,\n", ",\n\n", '"x","y"\n"a""b",c', 'a"b,c\n"q"tail,z', '"open quote\nstill,open', "﻿k,v\r\n1,2\r\n", "x,y\r\n\r\n"];
    await check("table_text", sheets.map((f) => ({ fn: "table_text", args: [f, b64(f)] })), (c) => {
      const [name, data] = [c.args[0] as string, buf(c.args[1] as string)];
      return intakeTableText(name, data);
    });
    await check("products_from_table", sheets.map((f) => ({ fn: "products_from_table", args: [f, b64(f)] })), (c) => intake.productsFromTable(c.args[0] as string, buf(c.args[1] as string)));
    await check("csv rows", csvs.map((t) => ({ fn: "csv_rows", args: [t] })), (c) => intake.csvRows(c.args[0] as string));
  });

  test("whole extraction without AI, and the profile merge", async () => {
    const notes = TEXTS.filter(([n]) => n === "typed note").map(([, t]) => t);
    const sets: [string[], string][] = [
      [["invoice_uae.pdf", "price_list.xlsx", "gst_certificate.png"], ""], [["invoice_photo.png"], ""], [["plain.csv"], notes[0]],
      [["latin1.csv", "bom.csv"], ""], [["real_r.pdf", "invoice.txt"], notes[1]], [["long.xlsx", "price_list_varied.xlsx"], notes[2]],
      // the samples in samples/: a GST certificate without colons, a scanned IEC, an invoice photo with HS codes on their
      // own lines, a price list under a title row, a packing list and a Hinglish note
      [FILES.filter((f) => f.startsWith("sample_")), ""],
      ...notes.map((n) => [[], n] as [string[], string]),
    ];
    const calls: Call[] = sets.map(([fs_, typed]) => ({ fn: "extract_without_ai", args: [fs_.map((f) => [f, b64(f)]), typed] }));
    await check("extract_without_ai", calls, (c) => intake.extractWithoutAi((c.args[0] as [string, string][]).map(([n, b]) => [n, buf(b)]), c.args[1] as string));
    const extracted = (await python(calls.slice(0, 8))).map((a) => (a as { value: Record<string, unknown> }).value);
    const merges: Call[] = [
      { fn: "merge", args: [null, extracted[0]] }, { fn: "merge", args: [{}, extracted[1]] },
      { fn: "merge", args: [{ company: { name: "Kept", gstin: "" }, products: [{ name: "boots", id: "p1" }] }, extracted[2]] },
      ...extracted.slice(3).map((e) => ({ fn: "merge", args: [{ company: { city: "Agra" }, products: [], notes: ["earlier"] }, e] as unknown[] })),
    ];
    await check("merge", merges, (c) => intake.merge(structuredClone(c.args[0]) as Record<string, unknown> | null, structuredClone(c.args[1]) as Record<string, unknown>));
  });
});

// tableText is internal; reach it through a tiny wrapper the module exports for tests
import { tableTextForTests as intakeTableText } from "../src/lib/engine/intake";
