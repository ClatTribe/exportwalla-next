// A small .xlsx reader that returns exactly what the Python app gets from openpyxl in read-only, data-only mode:
// rows padded to the sheet's declared width, cached formula results, date-formatted numbers as datetimes, and every
// value printed as Python's str() would print it. Only what price lists need: no writing, no styles beyond number
// formats. Uses Node's zlib; no dependencies.
import zlib from "node:zlib";
import { pyFloatStr, pyRound } from "./py";

// ---------------------------------------------------------------- zip

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------- xml helpers (machine-written OOXML)

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]);
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};

/** Text.from_tree(node).content: the plain <t> plus every rich-text run's <t>, without phonetic runs. */
function textContent(xml: string): string {
  const noPhonetic = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of noPhonetic.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

// ---------------------------------------------------------------- number formats and dates (openpyxl rules)

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)', 9: "0%", 10: "0.00%", 11: "0.00E+00",
  12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 37: "#,##0_);(#,##0)", 38: "#,##0_);[Red](#,##0)",
  39: "#,##0.00_);(#,##0.00)", 40: "#,##0.00_);[Red](#,##0.00)", 41: String.raw`_(* #,##0_);_(* \(#,##0\);_(* "-"_);_(@_)`,
  42: String.raw`_("$"* #,##0_);_("$"* \(#,##0\);_("$"* "-"_);_(@_)`, 43: String.raw`_(* #,##0.00_);_(* \(#,##0.00\);_(* "-"??_);_(@_)`,
  44: String.raw`_("$"* #,##0.00_)_("$"* \(#,##0.00\)_("$"* "-"??_)_(@_)`, 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0",
  48: "##0.0E+0", 49: "@",
};
const STRIP_RE = /".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g;
const TIMEDELTA_RE = /\[hh?\](:mm(:ss(\.0*)?)?)?|\[mm?\](:ss(\.0*)?)?|\[ss?\](\.0*)?/i;
export const isDateFormat = (fmt: string | null) => fmt != null && /(?<![_\\])[dmhysDMHYS]/.test(fmt.split(";")[0].replace(STRIP_RE, ""));
const isTimedeltaFormat = (fmt: string | null) => fmt != null && TIMEDELTA_RE.test(fmt.split(";")[0]);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const micro = (us: number) => (us ? "." + pad(us, 6) : "");

/** openpyxl.utils.datetime.from_excel, printed as str(datetime | time | timedelta). */
function excelDateStr(value: number, mac1904: boolean, timedelta: boolean): string {
  if (timedelta) {
    let us = pyRound(value * 86400e6);
    if (us % 1e6) us = Math.floor(us / 1e6) * 1e6 + pyRound(us % 1e6, -3);
    const neg = us < 0;
    const days = Math.floor(us / 86400e6);
    const rest = us - days * 86400e6;
    const s = Math.floor(rest / 1e6), u = rest % 1e6;
    const clock = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${micro(u)}`;
    return (days ? `${days} day${Math.abs(days) !== 1 ? "s" : ""}, ` : "") + clock + (neg ? "" : "");
  }
  const day = Math.floor(value), fraction = value - day;
  const ms = pyRound(fraction * 86400 * 1000);
  if (value >= 0 && value < 1 && ms < 86400000) {
    const s = Math.floor(ms / 1000);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${micro((ms % 1000) * 1000)}`;
  }
  const epoch = mac1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + (day + (!mac1904 && value > 0 && value < 60 ? 1 : 0)) * 86400000 + ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${micro(d.getUTCMilliseconds() * 1000)}`;
}

// ---------------------------------------------------------------- workbook

export interface Sheet { title: string; rows: (string | null)[][] }

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
const rowIndex = (ref: string) => Number(ref.replace(/^[A-Za-z]+/, ""));

/** Every sheet's rows as Python would str() them (null for empty cells), in workbook order. */
export function readXlsx(data: Buffer): Sheet[] {
  const files = unzip(data);
  const text = (p: string) => files.get(p)?.toString("utf8") ?? "";
  const wb = text("xl/workbook.xml");
  const mac1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);
  const rels = new Map<string, string>();
  for (const m of text("xl/_rels/workbook.xml.rels").matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const target = attr(m[0], "Target") ?? "";
    rels.set(attr(m[0], "Id") ?? "", target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, ""));
  }
  const shared: string[] = [];
  for (const m of text("xl/sharedStrings.xml").matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\/>/g)) {
    shared.push(textContent(m[1] ?? "").replaceAll("x005F_", ""));
  }
  const styles = text("xl/styles.xml");
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], "numFmtId")), attr(m[0], "formatCode") ?? "");
  const dateStyles = new Set<number>(), tdStyles = new Set<number>();
  const xfs = styles.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] ?? "";
  [...xfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].forEach((m, idx) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const fmt = custom.has(id) ? custom.get(id)! : BUILTIN_FORMATS[id] ?? null;
    if (isDateFormat(fmt)) dateStyles.add(idx);
    if (isTimedeltaFormat(fmt)) tdStyles.add(idx);
  });

  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const rid = attr(m[0], "r:id") ?? [...m[0].matchAll(/\s([\w-]+:id)="([^"]*)"/g)].map((x) => x[2])[0];
    const target = rels.get(rid ?? "") ?? "";
    if (!target.includes("/worksheets/")) continue; // chartsheets and dialogs are not in wb.worksheets
    const xml = text(target);
    const dim = xml.match(/<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/)?.[1];
    let maxCol: number | null = null, maxRow: number | null = null;
    if (dim) {
      const last = dim.split(":").at(-1)!;
      if (/^[A-Za-z]+\d+$/.test(last)) [maxCol, maxRow] = [colIndex(last), rowIndex(last)];
    }
    const rows: (string | null)[][] = [];
    const empty = () => (maxCol != null ? Array<string | null>(maxCol).fill(null) : []);
    let counter = 1, rowCounter = 0;
    for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const r = attr(rm[1], "r");
      const idx = r ? Number(r) : rowCounter + 1;
      rowCounter = idx;
      if (maxRow != null && idx > maxRow) break;
      while (counter < idx) { rows.push(empty()); counter++; }
      const cells: [number, string | null][] = [];
      let colCounter = 0;
      for (const cm of (rm[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attr(cm[1], "r");
        const col = ref ? colIndex(ref) : colCounter + 1;
        colCounter = col;
        const t = attr(cm[1], "t") ?? "n";
        const s = Number(attr(cm[1], "s") ?? 0);
        const body = cm[2] ?? "";
        let v: string | null = t === "inlineStr" ? null : (body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? null);
        if (v !== null) v = unescapeXml(v) || null;
        let out: string | null = null;
        if (v !== null) {
          if (t === "n") {
            const num = Number(v);
            const isFloat = v.includes(".") || /e/i.test(v);
            out = dateStyles.has(s) ? excelDateStr(num, mac1904, tdStyles.has(s)) : isFloat ? pyFloatStr(num) : String(BigInt(v));
          } else if (t === "s") out = shared[Number(v)];
          else if (t === "b") out = Number(v) ? "True" : "False";
          else if (t === "d") out = v.replace("T", " ").replace(/Z$/, "");
          else out = v; // str, e (errors such as #N/A)
        } else if (t === "inlineStr") {
          const is = body.match(/<(?:\w+:)?is>([\s\S]*?)<\/(?:\w+:)?is>/);
          if (is) out = textContent(is[1]);
        }
        cells.push([col, out]);
      }
      if (counter <= idx) {
        const width = maxCol ?? (cells.length ? cells.at(-1)![0] : 0);
        const row = Array<string | null>(width).fill(null);
        for (const [col, val] of cells) if (col >= 1 && col <= width) row[col - 1] = val;
        rows.push(row);
        counter++;
      }
    }
    if (maxRow != null) while (counter <= maxRow) { rows.push(empty()); counter++; }
    sheets.push({ title: attr(m[0], "name") ?? "", rows });
  }
  return sheets;
}
