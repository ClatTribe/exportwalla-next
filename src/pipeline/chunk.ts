// Index-time retrieval: clean PDF text, split documents into sections and structure-aware chunks with contextual
// headers, and write them to rag_chunk / rag_fts. Port of the indexing half of export-desk/app/rag.py (the search
// half is src/lib/engine/rag.ts). Python's "\s", "\b", "\d" and "." differ from JavaScript's, so they are spelled out.
import { S, WB, pySplit, pySplitlines, pyStrip, cpSlice } from "../lib/py";
import type { Conn } from "./core";

const TARGET_WORDS = 300, MAX_WORDS = 450, MIN_WORDS = 60, OVERLAP_SENTENCES = 1;
const W = `[${S}]`, D = "\\p{Nd}", DOT = "[^\\n]";
const R = (src: string, flags = "") => new RegExp(src, "u" + flags);

const HEADING = R(`^${W}*(?<kind>PART|Part|CHAPTER|Chapter|SECTION|Section|SUB-SECTION|ARTICLE|Article|ANNEX|Annex|APPENDIX|Appendix|`
  + `RULE|Rule|SCHEDULE|Schedule|ATTACHMENT|Attachment)${W}+(?<num>(?:[0-9IVXLC]+[A-Z]?|[A-Z])(?:[.\\-][0-9A-Z]+)*)${WB}[.:${S}-]*(?<title>${DOT}{0,120})$`);
const LEVEL: Record<string, number> = { part: 1, chapter: 1, annex: 1, appendix: 1, schedule: 1, attachment: 1,
  section: 2, "sub-section": 3, article: 3, rule: 3 };
const ITEM = R(`^(\\(?[a-z0-9ivx]{1,4}\\)|${D}+\\.)${W}`);
const ENDS_STOP = /[.:;]$/u;
const words = (s: string) => pySplit(s).length;

/** Drop running headers/footers and page numbers; re-join lines broken mid-sentence. */
export function cleanPdfText(text: string): string {
  const pages = text.split("\f");
  const counts = new Map<string, number>();
  for (const pg of pages) {
    for (const l of new Set(pySplitlines(pg))) {
      const s = pyStrip(l);
      const n = [...s].length;
      if (n > 0 && n < 90) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  const floor = Math.max(3, Math.floor(pages.length / 3));
  const repeated = new Set([...counts].filter(([, n]) => n >= floor).map(([l]) => l));
  const pageNo = R(`^(?:(page${W}*)?${D}{1,4}(${W}*(of|/)${W}*${D}+)?|[-–]${W}*${D}+${W}*[-–])$`, "i");
  const lines: string[] = [];
  for (const pg of pages) {
    for (const l of pySplitlines(pg)) {
      const s = pyStrip(l);
      lines.push(!s || repeated.has(s) || pageNo.test(s) ? "" : s);
    }
  }
  const out: string[] = [];
  for (const s of lines) {
    const last = out.length ? out[out.length - 1] : null;
    if (last && s && !HEADING.test(s) && !ITEM.test(s) && !ENDS_STOP.test(last) && !HEADING.test(last)) {
      out[out.length - 1] = (last.endsWith("-") ? last.slice(0, -1) : last + " ") + s;
    } else out.push(s);
  }
  return pyStrip(out.join("\n").replace(/\n{3,}/g, "\n\n"));
}

const SENTENCE_SPLIT = R(`(?<=[.;:])${W}+(?=[A-Z(${D}])`);
const sentences = (text: string) => text.split(SENTENCE_SPLIT).filter((s) => pyStrip(s));
const squash = (s: string) => s.replace(R(`${W}+`, "g"), " ");

/** (breadcrumb list, paragraphs) for each lowest-level section; works for PDF text and "@@H" HTML text alike. */
export function sections(text: string): [string[], string[]][] {
  let crumbs = new Map<number, string>();
  const paras: string[] = [], out: [string[], string[]][] = [], cur: string[] = [];
  let pendingTitle: number | null = null;
  const endPara = () => {
    if (cur.length) { paras.push(pyStrip(squash(cur.join(" ")))); cur.length = 0; }
  };
  const flush = () => {
    endPara();
    if (paras.length) {
      out.push([[...crumbs.keys()].sort((a, b) => a - b).map((k) => crumbs.get(k)!), [...paras]]);
      paras.length = 0;
    }
  };
  const H = R(`^@@H(${D})${W}*(${DOT}*)`);
  for (const raw of pySplitlines(text)) {
    const line = pyStrip(raw);
    if (!line) { endPara(); continue; }
    const hm = line.match(H);
    const m = hm ? null : line.match(HEADING);
    if (hm || (m && [...line].length < 140 && !/[.;,]$/u.test(line))) {
      flush();
      const level = hm ? Number(hm[1]) : LEVEL[m!.groups!.kind.toLowerCase()];
      crumbs = new Map([...crumbs].filter(([k]) => k < level));
      crumbs.set(level, cpSlice(squash(hm ? hm[2] : line), 0, 140));
      pendingTitle = level;
      continue;
    }
    // "Article 5" + "Definitions": a short bare line right after a heading is its title
    if (pendingTitle && words(line) <= 12 && !R(`[.;:]$|:${W}|https?://|\\.${W}`).test(line) && !ITEM.test(line)) {
      crumbs.set(pendingTitle, cpSlice(`${crumbs.get(pendingTitle)} ${line}`, 0, 140));
      continue;
    }
    pendingTitle = null;
    if (ITEM.test(line) || (cur.length && ENDS_STOP.test(cur[cur.length - 1]))) endPara();
    cur.push(line);
  }
  flush();
  return out;
}

/** Structure-aware packing: [(heading breadcrumb, chunk text)]. */
export function chunkStructured(text: string): [string, string][] {
  const merged: [string[], string[], number][] = [];
  for (const [crumb, paras] of sections(text)) { // tiny sections merge into the next one
    const n = paras.reduce((s, p) => s + words(p), 0);
    if (merged.length && merged[merged.length - 1][2] < MIN_WORDS) {
      const [pc, pp, pw] = merged.pop()!;
      merged.push([pw > n ? pc : crumb, [...pp, `[${crumb.slice(-1).join(" > ")}]`, ...paras], pw + n]);
    } else merged.push([crumb, paras, n]);
  }
  const chunks: [string, string][] = [];
  for (const [crumb, paras] of merged) {
    const heading = crumb.join(" > ");
    const units = paras.flatMap((p) => (words(p) > MAX_WORDS ? sentences(p) : [p]));
    let cur: string[] = [], n = 0;
    for (const u of units) {
      const w = words(u);
      if (cur.length && n + w > TARGET_WORDS && (n >= TARGET_WORDS * 0.6 || n + w > MAX_WORDS)) {
        chunks.push([heading, cur.join(" ")]);
        const tail = OVERLAP_SENTENCES ? sentences(cur[cur.length - 1]).slice(-OVERLAP_SENTENCES) : [];
        cur = [...tail];
        n = tail.reduce((s, t) => s + words(t), 0);
      }
      cur.push(u);
      n += w;
    }
    if (cur.length) chunks.push([heading, cur.join(" ")]);
  }
  return chunks;
}

/** Baseline for the ablation: fixed word windows, no structure. */
export function chunkFixed(text: string, size = 200, overlap = 40): [string, string][] {
  const ws = pySplit(text.replace(R(`@@H${D}`, "g"), " "));
  const out: [string, string][] = [];
  for (let i = 0; i < Math.max(ws.length - overlap, 1); i += size - overlap) out.push(["", ws.slice(i, i + size).join(" ")]);
  return out;
}

export interface DocMeta { title?: string | null; agreement?: string | null; country_names?: string | null }

export const contextHeader = (doc: DocMeta, heading: string) =>
  [doc.title || "", doc.agreement || "", doc.country_names || "", heading].filter(Boolean).join(" | ");

export function indexDocument(conn: Conn, docId: number, doc: DocMeta, text: string, strategy = "structured", contextual = true): number {
  conn.run("DELETE FROM rag_fts WHERE rowid IN (SELECT id FROM rag_chunk WHERE doc_id=?)", docId);
  conn.run("DELETE FROM rag_chunk WHERE doc_id=?", docId);
  const pieces = strategy === "structured" ? chunkStructured(text) : chunkFixed(text);
  pieces.forEach(([heading, body], i) => {
    const ctx = contextual ? contextHeader(doc, heading) : "";
    const cur = conn.run("INSERT INTO rag_chunk (doc_id, ord, heading, context, text) VALUES (?,?,?,?,?)", docId, i, heading, ctx, body);
    conn.run("INSERT INTO rag_fts (rowid, context, text) VALUES (?,?,?)", cur.lastInsertRowid, ctx, body);
  });
  return pieces.length;
}
