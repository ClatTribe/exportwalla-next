// Official rules-of-origin and import-procedure texts listed in data/reference/country_rules*.json (and the official
// mirrors in extra_docs.json): fetched (cached), read (PDFs through the on-device OCR tool, web pages through the
// HTML reader), chunked and indexed, plus one researched "fact card" per country. Port of ingest/rules_docs.py.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFERENCE_DIR } from "../lib/config";
import { OCR_BIN } from "../lib/engine/intake";
import { agreementNote, rules } from "../lib/engine/markets";
import { cpSlice, pyFloatStr } from "../lib/py";
import { type DocMeta, cleanPdfText, indexDocument } from "./chunk";
import { type Conn, type Row, finishRun, getText, now, say, startRun } from "./core";
import { htmlToText } from "./html";

const BLOCKED = /captcha|flagged as potentially automated|access denied|request unsuccessful|enable javascript|are you a robot|403 forbidden/i;

/** Python's str() of a JSON value inside an f-string ("None", "True", "25.5"). */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatStr(v);
  return String(v);
}
/** dict.get(k, default): the default only when the key is missing. */
const get = (o: Row, k: string, d: unknown = null) => (k in o ? o[k] : d);
const truthy = (v: unknown) => !!v && (typeof v !== "object" || Object.keys(v as object).length > 0);

interface Source { countries: Set<string>; agreements: Set<string>; title: string; kind: string; fmt: string }

export function sources(): Map<string, Source> {
  const byUrl = new Map<string, Source>();
  const slot = (url: string) => {
    if (!byUrl.has(url)) byUrl.set(url, { countries: new Set(), agreements: new Set(), title: "", kind: "", fmt: "" });
    return byUrl.get(url)!;
  };
  for (const [iso, r] of Object.entries(rules())) {
    const agr = (r.agreements || []).filter((a: Row) => a.status === "in_force").map((a: Row) => a.name).join(", ") || ((r.gsp || {}).scheme || "");
    for (const d of (r.rules_docs || []) as Row[]) {
      if (!(d.url || "").startsWith("http")) continue;
      const s = slot(d.url);
      Object.assign(s, { title: d.title || d.url, kind: d.covers || "", fmt: d.format || "" });
      s.countries.add(iso);
      if (agr) s.agreements.add(agr);
    }
  }
  const extra = path.join(REFERENCE_DIR, "extra_docs.json");
  if (fs.existsSync(extra)) { // official mirrors found for texts whose primary hosts block scripts
    for (const d of (JSON.parse(fs.readFileSync(extra, "utf8")).docs ?? []) as Row[]) {
      if (!(d.url || "").startsWith("http")) continue;
      const s = slot(d.url);
      Object.assign(s, { title: d.title || d.url, kind: d.covers || "", fmt: d.format || "" });
      for (const c of d.countries || []) s.countries.add(c);
      if (d.agreement) s.agreements.add(d.agreement);
    }
  }
  return byUrl;
}

async function extract(url: string): Promise<[string | null, string | null]> {
  const raw: Buffer | null = await getText("docs", url, false, 5, true);
  if (raw === null) return [null, null];
  if (raw.subarray(0, 5).toString("latin1") === "%PDF-") {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ew-doc-")), "doc.pdf");
    fs.writeFileSync(tmp, raw);
    try {
      const out = spawnSync(OCR_BIN, [tmp, "400"], { encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 30 });
      if (out.error) throw out.error;
      return [cleanPdfText(out.stdout), null];
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  }
  return htmlToText(new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw));
}

export function factCard(iso: string, r: Row): string {
  const lines = [`@@H1 ${pyStr(get(r, "name", iso))}: import rules for Indian exporters`];
  for (const a of (r.agreements || []) as Row[]) {
    lines.push(`Trade agreement: ${pyStr(get(a, "name"))} (${pyStr(get(a, "status"))}`
      + (a.in_force_date ? `, in force since ${pyStr(a.in_force_date)}` : "") + `). Source: ${pyStr(get(a, "source_url"))}`);
  }
  const g: Row = r.gsp || {};
  if (g.scheme) lines.push(`GSP: ${pyStr(g.scheme)}; India beneficiary: ${pyStr(get(g, "india_beneficiary"))}. ${g.notes || ""} Source: ${pyStr(get(g, "source_url"))}`);
  const op: Row = r.origin_proof || {};
  if (truthy(op)) {
    lines.push(`\n@@H2 Proof of origin\nPreferential proof of origin: ${pyStr(get(op, "preferential_document"))}. Issued by: ${pyStr(get(op, "issued_by"))}. `
      + `How: ${pyStr(get(op, "how"))}. Source: ${pyStr(get(op, "source_url"))}`);
  }
  const npc: Row = r.non_preferential_coo || {};
  if (truthy(npc)) lines.push(`Non-preferential certificate of origin: needed ${pyStr(get(npc, "needed"))}; issued by ${pyStr(get(npc, "issued_by"))}. Source: ${pyStr(get(npc, "source_url"))}`);
  const v: Row = r.import_vat || {};
  if (truthy(v)) lines.push(`\n@@H2 Import tax\nImport ${v.name || "VAT"}: ${pyStr(get(v, "rate_pct"))}% standard rate. Source: ${pyStr(get(v, "source_url"))}`);
  if (truthy(r.import_notes)) {
    lines.push("\n@@H2 Import notes");
    for (const n of r.import_notes as Row[]) lines.push(`${pyStr(get(n, "text"))} Source: ${pyStr(get(n, "source_url"))}`);
  }
  lines.push(`\nCustoms authority: ${pyStr(get(r, "customs_url"))}. Indian mission commerce wing: ${pyStr(get(r, "india_mission_commerce_url"))}.`);
  return lines.join("\n");
}

function upsert(conn: Conn, url: string, doc: DocMeta, country: string, kind: string, runId: number, chars: number): number {
  const row = conn.get<{ id: number }>("SELECT id FROM rag_doc WHERE url=?", url);
  if (row) {
    conn.run("UPDATE rag_doc SET title=?, country=?, agreement=?, kind=?, fetched_at=?, chars=?, run_id=? WHERE id=?",
      doc.title, country, doc.agreement, kind, now(), chars, runId, row.id);
    return row.id;
  }
  return Number(conn.run("INSERT INTO rag_doc (url, title, country, agreement, kind, fetched_at, chars, run_id) VALUES (?,?,?,?,?,?,?,?)",
    url, doc.title, country, doc.agreement, kind, now(), chars, runId).lastInsertRowid);
}

export async function rulesDocs(conn: Conn, strategy = "structured", contextual = true, fetch = true): Promise<number> {
  const runId = startRun(conn, "rules_docs", strategy);
  const names = new Map(Object.values(rules()).filter((r) => r.iso3).map((r) => [r.iso3 as string, r.name as string]));
  let nDocs = 0, nChunks = 0;
  const failed: string[] = [];
  for (const [iso, r] of Object.entries(rules())) { // fact cards
    const doc = { title: `${pyStr(get(r, "name", iso))}: researched import rules`, agreement: agreementNote(iso), country_names: get(r, "name", iso) as string };
    const docId = upsert(conn, `country_rules:${iso}`, doc, iso, "fact card", runId, 0);
    nChunks += indexDocument(conn, docId, doc, factCard(iso, r), strategy, contextual);
    nDocs++;
  }
  for (const [url, s] of fetch ? sources() : []) { // official texts
    let text: string | null, htmlTitle: string | null;
    try {
      [text, htmlTitle] = await extract(url);
    } catch (e) { // one bad source must not stop the rest
      failed.push(`${url}: ${(e as Error).message}`);
      continue;
    }
    if (!text || [...text].length < 400) { failed.push(`${url}: no text`); continue; }
    if (BLOCKED.test(cpSlice(text, 0, 3000)) && [...text].length < 5000) { failed.push(`${url}: site returned a bot check / error page (not indexed)`); continue; }
    const countries = [...s.countries].sort();
    const doc = { title: s.title || htmlTitle, agreement: [...s.agreements].sort().join("; "),
      country_names: countries.slice(0, 6).map((c) => names.get(c) ?? c).join(", ") + (countries.length > 6 ? " and others" : "") };
    const docId = upsert(conn, url, doc, countries.join(","), s.kind, runId, [...text].length);
    nChunks += indexDocument(conn, docId, doc, text, strategy, contextual);
    nDocs++;
    conn.commit();
    say(`  doc ${String(nDocs).padStart(3)}: ${String([...text].length).padStart(7)} chars  ${cpSlice(s.title, 0, 70)}`);
  }
  conn.commit();
  finishRun(conn, runId, nChunks, "ok", `${strategy}; ${nDocs} docs, ${failed.length} failed`);
  for (const f of failed) say(`  FAILED ${cpSlice(f, 0, 160)}`);
  return nChunks;
}
