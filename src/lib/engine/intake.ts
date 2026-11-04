// Turn whatever the merchant uploads (catalogue PDF, product photo, price list, GST certificate, a typed note) into one
// export profile: company details plus a product list. Port of export-desk/app/intake.py; the rule-based reading must
// give exactly the Python engine's answer (tests/intake.parity.test.ts).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Block, askJson, available } from "../llm";
import { S, W, WB, cpSlice, pyFloat, pySplitlines, pyStrip } from "../py";
import { readXlsx } from "../xlsx";
import { STATE_CODES, checkGstin } from "./gstin";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const execFileP = promisify(execFile);

/** subprocess.run without check=True: a non-zero exit still returns what the tool printed; only a timeout or a
 * failure to start counts as failure. */
async function run(bin: string, args: string[], timeout: number): Promise<string> {
  try {
    return (await execFileP(bin, args, { timeout, maxBuffer: 1 << 26 })).stdout;
  } catch (e) {
    const err = e as { killed?: boolean; code?: unknown; stdout?: string };
    if (err.killed || typeof err.code === "string") throw e;
    return err.stdout ?? "";
  }
}

/** macOS Vision OCR, on-device (the same binary the Python app calls). Absent on Linux and Vercel. */
/** The on-device OCR tool (macOS Vision; source in tools/ocr.swift). Not on Linux hosts: there text PDFs are read directly. */
export const OCR_BIN = process.env.OCR_BIN ?? path.resolve(process.cwd(), "tools/ocr");

export const PROFILE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["company", "products", "notes"],
  properties: {
    company: {
      type: "object", additionalProperties: false,
      required: ["name", "gstin", "iec", "address", "city", "state", "website", "contact_name", "phone", "email", "certifications", "current_export_markets"],
      properties: {
        name: { type: "string" }, gstin: { type: "string" }, iec: { type: "string" },
        address: { type: "string" }, city: { type: "string" }, state: { type: "string" },
        website: { type: "string" }, contact_name: { type: "string" }, phone: { type: "string" }, email: { type: "string" },
        certifications: { type: "array", items: { type: "string" } },
        current_export_markets: { type: "array", items: { type: "string" } },
      },
    },
    products: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "description", "materials", "for_whom", "price_inr", "price_unit", "moq", "monthly_capacity", "unit", "hs_code"],
        properties: {
          name: { type: "string" },
          description: { type: "string", description: "What it is, how it is made, upper/sole/lining materials" },
          materials: { type: "string" },
          for_whom: { type: "string", description: "men, women, children, unisex, or blank" },
          price_inr: { type: ["number", "null"] },
          price_unit: { type: "string", description: "e.g. per pair, per piece, per sq ft" },
          moq: { type: ["number", "null"] },
          monthly_capacity: { type: ["number", "null"] },
          unit: { type: "string", description: "pairs, pieces, sq ft, kg" },
          hs_code: { type: "string", description: "HS/HSN/ITC code printed next to this product on the document, digits only; empty if none" },
        },
      },
    },
    notes: { type: "string", description: "Anything unclear or missing, in one or two sentences" },
  },
};

export const SYSTEM = `You read documents from Indian manufacturers (catalogues, price lists, invoices,
GST certificates, product photos, typed notes) and extract an export profile.
Rules:
- Copy identifiers (GSTIN, IEC, phone, email) exactly as printed. Never invent them; use "" if absent.
- Only list products that actually appear. For a photo, describe what is visible (type, materials if
  identifiable, construction) and say in notes what could not be seen.
- Prices: convert to a plain number in rupees if stated in rupees; null if not stated or another currency
  (mention the currency in notes).
- Keep descriptions factual and specific: they are used for customs classification.`;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic", ".heif": "image/heif",
  ".csv": "text/csv", ".txt": "text/plain", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
/** mimetypes.guess_type(filename)[0], for the types uploads can have. */
export const guessType = (filename: string) => MIME[path.extname(filename).toLowerCase()] ?? "";

const decodeUtf8 = (data: Buffer) => new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data); // errors="replace", BOM kept

/** csv.reader with the default dialect: comma, double quote, doubled quotes inside quotes, lenient with stray quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false, quoted = false, i = 0, started = false;
  const endField = () => { row.push(field); field = ""; quoted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; started = false; };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "" && !quoted) { inQ = true; quoted = true; started = true; i++; continue; }
    if (ch === ",") { endField(); started = true; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      if (started || field !== "" || row.length) endRow(); else rows.push([]);
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch; started = true; i++;
  }
  if (inQ || started || field !== "" || row.length) endRow();
  return rows;
}

function tableText(filename: string, data: Buffer): string {
  const low = filename.toLowerCase();
  if (low.endsWith(".xlsx") || low.endsWith(".xlsm")) {
    const out: string[] = [];
    for (const ws of readXlsx(data).slice(0, 3)) {
      out.push(`# sheet ${ws.title}`);
      for (const [i, row] of ws.rows.entries()) {
        if (i > 300) break;
        if (row.some((c) => c !== null)) out.push(row.map((c) => c ?? "").join(" | "));
      }
    }
    return out.join("\n");
  }
  return csvRows(decodeUtf8(data)).slice(0, 300).map((r) => r.join(" | ")).join("\n");
}

function contentFor(filename: string, data: Buffer): Block[] {
  const mime = guessType(filename);
  if (IMAGE_TYPES.has(mime)) return [{ type: "image", source: { type: "base64", media_type: mime, data: data.toString("base64") } }];
  if (mime === "application/pdf") return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } }];
  const low = filename.toLowerCase();
  if (low.endsWith(".xlsx") || low.endsWith(".xlsm") || low.endsWith(".csv")) return [{ type: "text", text: `Spreadsheet ${filename}:\n${tableText(filename, data)}` }];
  return [{ type: "text", text: `File ${filename}:\n${cpSlice(decodeUtf8(data), 0, 60000)}` }];
}

/** files: [filename, bytes]. Returns the extracted profile. */
export async function extract(files: [string, Buffer][], typedText = ""): Promise<Json> {
  if (!available()) return extractWithoutAi(files, typedText);
  const content: Block[] = [];
  for (const [name, data] of files) content.push({ type: "text", text: `--- ${name} ---` }, ...contentFor(name, data));
  if (pyStrip(typedText)) content.push({ type: "text", text: `--- typed by the owner ---\n${pyStrip(typedText)}` });
  content.push({ type: "text", text: "Extract the export profile from everything above." });
  return askJson(SYSTEM, content, PROFILE_SCHEMA, "low", 16000);
}

/** Text of each PDF page as pypdf would give it, approximately: Node has no pypdf, so this is the server fallback only. */
async function pdfText(data: Buffer): Promise<string> {
  const { extractTextItems } = await import("unpdf");
  const { items } = await extractTextItems(new Uint8Array(data));
  return items.slice(0, 20).map((page) => page.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("").replace(/\n$/, "")).join("\n");
}

/** Plain text from any upload: spreadsheets as rows, PDFs and photos via on-device OCR. Returns [text, kind]. */
export async function readText(filename: string, data: Buffer): Promise<[string, string]> {
  const low = filename.toLowerCase();
  if (low.endsWith(".xlsx") || low.endsWith(".xlsm") || low.endsWith(".csv")) return [tableText(filename, data), "table"];
  const mime = guessType(filename);
  if (IMAGE_TYPES.has(mime) || mime === "application/pdf" || low.endsWith(".heic") || low.endsWith(".tif") || low.endsWith(".tiff")) {
    // the OCR tool is a macOS binary beside the Python app, never deployed: keep it out of file tracing
    if (!fs.existsSync(/*turbopackIgnore: true*/ OCR_BIN)) { // Linux / serverless: no macOS Vision. Text PDFs are still read.
      if (mime === "application/pdf") {
        try {
          const text = await pdfText(data);
          return [text, pyStrip(text) ? "pdf" : "scan-needs-ai"];
        } catch {
          return ["", "pdf-unreadable"];
        }
      }
      return ["", "photo-needs-ai"];
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-ocr-"));
    const tmp = path.join(dir, "upload" + (path.extname(filename) || ".bin"));
    fs.writeFileSync(tmp, data);
    try {
      const text = await run(OCR_BIN, [tmp], 120_000);
      // A text layer that runs a table into very long lines lost its reading order: read the page as an image.
      if (mime === "application/pdf" && Math.max(0, ...pySplitlines(text).map((l) => Array.from(l).length)) > 160) {
        const redo = await run(OCR_BIN, [tmp, "20", "ocr"], 180_000);
        if (Array.from(pyStrip(redo)).length > 0.5 * Array.from(pyStrip(text)).length) return [redo + "\n\f\n@@TEXTLAYER\n" + text, "pdf (re-read as image)"];
      }
      return [text, mime === "application/pdf" ? "pdf" : "image"];
    } catch {
      return ["", "ocr-failed"];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return [cpSlice(decodeUtf8(data), 0, 60000), "text"];
}

// ---------------------------------------------------------------- rule-based reading

const DOC_TYPES: [string, string[]][] = [ // first match wins; checked against upper-cased text
  ["GST registration certificate", ["REG-06", "REGISTRATION CERTIFICATE", "GOODS AND SERVICES TAX"]],
  ["IEC certificate", ["IMPORTER-EXPORTER CODE", "IMPORTER EXPORTER CODE", "IEC CERTIFICATE"]],
  ["Shipping bill", ["SHIPPING BILL", "LEO DATE", "PORT CODE"]],
  ["Export invoice", ["COMMERCIAL INVOICE", "EXPORT INVOICE", "INVOICE NO", "TAX INVOICE", "PROFORMA"]],
  ["Price list", ["PRICE LIST", "RATE LIST", "MRP", "PRICE"]],
  ["Catalogue", ["CATALOGUE", "CATALOG", "COLLECTION", "ARTICLE NO"]],
];
const STATES = ["Uttar Pradesh", "Maharashtra", "Tamil Nadu", "Gujarat", "Karnataka", "Delhi", "Haryana", "Punjab",
  "Rajasthan", "West Bengal", "Kerala", "Telangana", "Andhra Pradesh", "Madhya Pradesh", "Bihar",
  "Uttarakhand", "Odisha", "Assam", "Jammu and Kashmir", "Himachal Pradesh", "Goa", "Jharkhand", "Chhattisgarh"];
const COUNTRY_WORDS = ["United Kingdom", "UK", "United States", "USA", "Germany", "France", "Italy", "Spain", "Netherlands",
  "Belgium", "UAE", "United Arab Emirates", "Saudi Arabia", "Australia", "Canada", "Japan", "Singapore",
  "Bangladesh", "Nepal", "Sri Lanka", "South Africa", "Malaysia", "Poland", "Denmark", "Sweden"];
export const UNIT_WORDS: Record<string, string> = {
  pair: "pairs", pairs: "pairs", pc: "pieces", pcs: "pieces", piece: "pieces", pieces: "pieces",
  kg: "kg", kgs: "kg", mt: "tonnes", ton: "tonnes", dozen: "dozens", sqft: "sq ft",
  "sq ft": "sq ft", set: "sets", metre: "metres", meter: "metres", litre: "litres", prs: "pairs",
};

const sp = `[${S}]`; // Python's \s
const R = (src: string, flags = "") => new RegExp(src, "u" + flags);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// amounts start with a digit, and "Rs"/"INR" start a word: "Partners, ..." once matched "rs" + "," and crashed float()
const PRICE = R(`(?:₹|${WB}(?:rs\\.?|inr))${sp}*(\\d[\\d,]*(?:\\.\\d+)?)(?:${sp}*(?:/|per)${sp}*(sq ?ft|[a-z]+))?`, "i");
const HS = R(`(?<!\\d)(?<!\\d\\.)(\\d{4}[ .]?\\d{2}(?:[ .]?\\d{2})?)(?!\\d|\\.\\d)`, "g");
const GSTIN = R(`${WB}\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]${WB}`, "g");
// a line that is just a company name ("YAMUNA LEATHERCRAFT PRIVATE LIMITED"), not the "For ..." above a signature
const COMPANY_LINE = R(`^(?!for${WB})[A-Za-z0-9&.,'() -]{2,70}?${WB}(?:private limited|pvt\\.? ?ltd\\.?|limited|ltd\\.?|llp|exports|industries|enterprises)${sp}*$`, "i");
// the buyer's block on an invoice: a company line there is not the exporter
const BUYER_LABEL = R(`^${sp}*(?:consignee|buyer|notify|importer(?![- ]exporter)|bill to|ship to|sold to)${WB}`, "i");
// words a label leaves behind when it has no colon ("2. Trade Name, if any X", "Address of Principal Place of Business X")
const LABEL_TAIL = R(`^(?:${sp}*,?${sp}*(?:if any|of|business|number)${WB})+${sp}*`, "i");
// Hinglish filler around a product in a typed note ("Boots ka rate ... hai (factory se)")
const NOTE_FILLER = R(`${WB}(?:ka|ki|ke|hai|hain|ye|yeh|hamara|hamare|hamari|humara|wala|wale|wali|lagbhag)${WB}`, "gi");

/** Value after 'Label:' on the same line, plus continuation lines that are not new labels. Failing that, a `bare`
 *  label that starts its line with the value after it and no colon, as form tables print them ("1. Legal Name X").
 *  Returns [value, line]. */
function labelValue(lines: string[], labels: string[], span = 2, bare: string[] = []): [string, string] {
  const more = (i: number, val: string[]) => {
    for (const nxt of lines.slice(i + 1, i + 1 + span)) {
      if (R(`^${sp}*(\\d+[.:)]|[A-Za-z ]{2,30}:)`).test(nxt) || !pyStrip(nxt)) break;
      val.push(pyStrip(nxt));
    }
    return val;
  };
  for (const [i, line] of lines.entries()) {
    for (const lab of labels) {
      const m = line.match(R(esc(lab) + `[^:]*:${sp}*(.*)`, "i"));
      if (m) return [pyStrip(more(i, pyStrip(m[1]) ? [pyStrip(m[1])] : []).join(" "), " ,"), line];
    }
  }
  for (const [i, line] of lines.entries()) {
    for (const lab of bare) {
      const m = line.match(R(`^${sp}*(?:\\d{1,2}[.)]${sp}*)?` + esc(lab) + `${WB}(.*)`, "i"));
      if (m && pyStrip(m[1])) {
        const val = pyStrip(more(i, [pyStrip(m[1])]).join(" ").replace(LABEL_TAIL, ""), " ,");
        if (val) return [val, line];
      }
    }
  }
  return ["", ""];
}

/** The HS code on a line: 8-digit ITC-HS codes count anywhere; 6-digit only on documents that label HS codes. */
function hsIn(line: string, hasHsLabel: boolean, price: RegExpMatchArray | null): RegExpMatchArray | null {
  for (const h of line.matchAll(HS)) {
    const digits = h[1].replace(/\D/g, "");
    if (Number(digits.slice(0, 2)) >= 1 && Number(digits.slice(0, 2)) <= 97 && (digits.length === 8 || (hasHsLabel && digits.length === 6 && price))) return h;
  }
  return null;
}

const num = (s: string) => pyFloat(s.replaceAll(",", ""));

/** Rule-based reading of one document's text. Returns [doc_type, company, products, evidence]. `free` marks a typed
 *  note or an uploaded .txt: one product per sentence with a price, named by its first clause. */
export function parseDocument(name: string, textIn: string, freeIn = false): [string, Json, Json[], [string, string][]] {
  const free = freeIn || name === "typed note";
  // PDF text layers often run a whole form into one line: break before numbered labels and known labels.
  let text = textIn.replace(R(`${sp}+(?=\\d{1,2}[.)]${sp}+[A-Z][a-z])`, "g"), "\n");
  text = text.replace(R(`${sp}+(?=(?:IEC|HSN|GSTIN|Registration Number|Legal Name|Trade Name|Address)${WB}[^:\\n]{0,40}:)`, "g"), "\n");
  // a table run into one line: start a new line before each 8-digit HS code (with its serial number)
  text = text.replace(R(`${sp}+(?=(?:\\d{1,3}${sp}+)?(?<!\\d)\\d{8}(?!\\d)${sp}+[A-Za-z])`, "g"), "\n");
  const up = text.toUpperCase();
  const docType = DOC_TYPES.find(([, keys]) => keys.some((k) => up.includes(k)))?.[0] ?? "Document";
  const lines = pySplitlines(text);
  const hasHsLabel = R(`${WB}(HSN|HS CODE|HS|ITC|TARIFF)${WB}`).test(up);
  const company: Json = {};
  const evidence: [string, string][] = [];

  const all = [...up.matchAll(GSTIN)].map((m) => m[0]);
  const gstins = all.filter((g) => checkGstin(g)[0]).length ? all.filter((g) => checkGstin(g)[0]) : all;
  if (gstins.length) {
    company.gstin = gstins[0];
    evidence.push(["GSTIN", gstins[0]]);
  }
  const iec = up.match(R(`${WB}(?:IEC|IE CODE|IMPORTER[- ]EXPORTER CODE)(?: NO\\.?| NUMBER)?${sp}*[:\\-]?${sp}*([A-Z0-9]{10})${WB}`));
  if (iec) {
    company.iec = iec[1];
    evidence.push(["IEC", iec[1]]);
  }
  for (const [field, labels, bare] of [
    ["name", ["Legal Name", "Name of the firm", "Exporter", "Company Name", "Name of Business"],
      ["Legal Name", "Name of the firm", "Firm Name", "Company Name", "Name of Business"]],
    ["trade_name", ["Trade Name"], ["Trade Name"]],
    ["address", ["Address of Principal Place", "Address", "Registered Office"], ["Address of Principal Place", "Registered Office"]],
  ] as [string, string[], string[]][]) {
    const [val] = labelValue(lines, labels, field === "address" ? 3 : 1, bare);
    if (val) company[field] = cpSlice(val, 0, 200);
  }
  const nm: string = company.name ?? "";
  const m = nm.match(R(`^([^,]{3,80}?(?:LTD|LIMITED|LLP|PVT|PRIVATE LIMITED|EXPORTS|INDUSTRIES|ENTERPRISES|& CO|CO\\.)?\\.?)${sp}*,${sp}*(.*\\d.*)$`, "i"));
  if (m) { // "NAME PVT LTD, Plot 22, Unjha GIDC, ..." -> name + address
    company.name = pyStrip(m[1]);
    if (!("address" in company)) company.address = pyStrip(m[2]);
  }
  if (!company.name && company.trade_name) company.name = company.trade_name;
  delete company.trade_name;
  if (!company.name) { // no label: a line that is a company name, outside the buyer's block
    const buyer = new Set<number>();
    lines.forEach((l, i) => { if (BUYER_LABEL.test(l)) for (let j = i; j < i + 4; j++) buyer.add(j); });
    const companyLine = lines.map((l, i) => [pyStrip(l), i] as const).find(([l, i]) => !buyer.has(i) && COMPANY_LINE.test(l));
    if (companyLine) company.name = companyLine[0];
  }
  for (const [k, label] of [["name", "Company"], ["address", "Address"]]) if (company[k]) evidence.push([label, cpSlice(company[k], 0, 90)]);
  const addr = ((company.address ?? "") + " " + text).replace(R(`${sp}+`, "g"), " "); // "Uttar\\nPradesh" in a wrapped cell
  const st = STATES.find((s) => addr.toLowerCase().includes(s.toLowerCase())) ?? "";
  if (st) {
    company.state = st;
    const cm = addr.match(R(`([A-Za-z]+)${sp}*,?${sp}*` + esc(st), "i"));
    if (cm && !["of", "in", "the", "director", "partner", "proprietor", "state"].includes(cm[1].toLowerCase())) company.city = cm[1][0].toUpperCase() + cm[1].slice(1).toLowerCase();
  } else if (company.gstin) {
    company.state = STATE_CODES[company.gstin.slice(0, 2)] ?? "";
  }
  const em = text.match(R(`[${W}.+-]+@[${W}-]+\\.[${W}.]+`));
  if (em) company.email = em[0];
  const ph = text.match(R(`(?:\\+91[${S}-]?)?${WB}[6-9]\\d{4}[${S}-]?\\d{5}${WB}`));
  if (ph) company.phone = ph[0];
  const web = text.match(R(`${WB}(?:https?://)?(?:www\\.)[${W}-]+\\.[${W}.]+`, "i"));
  if (web) company.website = web[0];
  const destText = lines.filter((l) => /destination|consignee|buyer|discharge|delivery/iu.test(l)).join(" ");
  const alias: Record<string, string> = { UK: "United Kingdom", USA: "United States", UAE: "United Arab Emirates" };
  const found = COUNTRY_WORDS.filter((c) => R(WB + esc(c) + WB).test(destText));
  const markets = [...new Set([...new Set(found)].map((x) => alias[x] ?? x))].sort();
  if (markets.length && (docType === "Shipping bill" || docType === "Export invoice")) company.current_export_markets = markets;

  const products: Json[] = [];
  const used = new Set<number>();
  for (const [i, full] of lines.entries()) {
    let line = full;
    if (used.has(i)) continue;
    if (free && PRICE.test(line)) { // a note: the sentence that carries the price names the product
      line = line.split(R(`(?<=[.!?])${sp}+(?=[A-Z])`)).find((x) => PRICE.test(x)) ?? line;
    }
    const price = line.match(PRICE);
    const hs = hsIn(line, hasHsLabel, price);
    if (!(price || hs)) continue;
    const spans = [price, hs].filter(Boolean).map((x) => [x!.index!, x!.index! + x![0].length] as [number, number]);
    let desc = line;
    for (const [a, b] of spans.sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]))) desc = desc.slice(0, a) + " " + desc.slice(b);
    desc = desc.replace(R(`^${sp}*\\d{1,3}[.)]?${sp}+`), ""); // leading item number
    const qty = desc.match(R(`${WB}(\\d[\\d,]*(?:\\.\\d+)?)${sp}*(kgs?|pcs|pieces|pairs|sets|mt|units|dozens?)${WB}`, "i"));
    if (qty) desc = desc.replaceAll(qty[0], " ");
    desc = desc.replace(R(`${WB}(HSN|HS code|ITC|Rate|per|Rs\\.?|INR)${WB}[:.]?`, "gi"), " ");
    desc = pyStrip(desc.replace(R(`${sp}{2,}`, "g"), " "), " -:|,.");
    let title = desc;
    if (free) { // free text: keep the first clause as the name
      desc = pyStrip(desc.split(R(`[,.;]${sp}`))[0]);
      desc = desc.replace(R(`^(we|i)${sp}+(make|manufacture|produce|export|sell|supply)${sp}+|^our (product|products) (is|are)${sp}+`, "i"), "");
      desc = desc.replace(R(`${sp}+in${sp}+[A-Z][a-z]+$|${sp}+(?:at|@)$`), ""); // "... in Kanpur", "... at"
      desc = pyStrip(desc.replace(R(`\\([^)]*\\)`, "g"), " ").replace(NOTE_FILLER, " ").replace(R(`${sp}{2,}`, "g"), " "), " -:|,.");
      desc = title = cpSlice(desc, 0, 1).toUpperCase() + cpSlice(desc, 1);
    } else if (hs && !price && desc.replace(/[^A-Za-z]/g, "").length < 3) {
      // "1  64039190" on its own line (a photographed invoice): the goods are described on the lines below it
      const block: string[] = [];
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const nxt = lines[j];
        if (!pyStrip(nxt) || R(`^${sp}*(?:grand |sub ?)?total${WB}`, "i").test(nxt) || hsIn(nxt, hasHsLabel, nxt.match(PRICE))) break;
        block.push(nxt);
        used.add(j);
      }
      let words = block.join(" ").replace(R(`(?<![^${S}])\\d[\\d,]*(?:\\.\\d+)?(?![^${S}])(?!${sp}*(?:mm|cm|inch|gsm|ml)${WB}|${sp}*%)`, "g"), " ");
      words = words.replace(R(`${WB}(?:prs|pairs?|pcs|pieces|kgs?|nos|sets|units|usd|eur|gbp|inr)${WB}`, "gi"), " ");
      desc = pyStrip(words.replace(R(`${sp}{2,}`, "g"), " "), " -:|,.");
      const first = pyStrip(desc.split(",")[0]);
      title = Array.from(first).length >= 3 ? first : desc;
    }
    if (Array.from(desc).length < 3 || ["DESCRIPTION", "TOTAL", "GRAND TOTAL"].includes(desc.toUpperCase())) continue;
    const unitWord = price ? (price[2] ?? "").toLowerCase() : "";
    const unit = UNIT_WORDS[unitWord.replaceAll(" ", "")] ?? UNIT_WORDS[unitWord] ?? "pieces";
    const moq = full.match(R(`${WB}(?:moq|minimum order)\\D{0,12}(\\d[\\d,]*)`, "i"));
    const cap = full.match(R(`(\\d[\\d,]*)${sp}*(?:pairs|pieces|pcs|kg|units|sets)?${sp}*(?:a|per|/)${sp}*month`, "i"))
      ?? full.match(R(`${WB}(?:har mahine|every month|monthly)\\D{0,15}?(\\d[\\d,]*)`, "i"));
    products.push({
      name: cpSlice(title, 0, 80), description: free ? cpSlice(pyStrip(full), 0, 300) : desc, materials: "", for_whom: "",
      price_inr: price ? num(price[1]) : null,
      price_unit: unitWord ? `per ${unitWord}` : "per piece",
      moq: moq ? num(moq[1]) : null,
      monthly_capacity: cap ? num(cap[1]) : null, unit,
      hs_code: hs ? hs[1].replace(/\D/g, "") : "", source: `${name}: ${cpSlice(pyStrip(line), 0, 120)}`,
      last_order_qty: qty ? num(qty[1]) : null,
    });
  }
  return [docType, company, products, evidence];
}

/** On-device path (no API key): OCR for PDFs and photos, rules for fields, columns for spreadsheets. */
export async function extractWithoutAi(files: [string, Buffer][], typedText: string): Promise<Json> {
  const company: Json = Object.fromEntries(PROFILE_SCHEMA.properties.company.required.map((k) => [k, ""]));
  Object.assign(company, { certifications: [], current_export_markets: [] });
  const products: Json[] = [], notes: string[] = [], documents: Json[] = [];
  for (const [name, data] of files) {
    const read = await readText(name, data);
    const kind = read[1];
    let text = read[0];
    if (kind === "table") {
      const rows = productsFromTable(name, data);
      products.push(...rows);
      const packing = R("carton|gross w|net w", "i").test(cpSlice(tableText(name, data), 0, 3000));
      documents.push({ file: name, type: packing ? "Packing list (spreadsheet)" : "Price list (spreadsheet)", read_by: "spreadsheet columns",
        found: rows.map((p) => `product: ${p.name}` + (p.hs_code ? ` (HS ${p.hs_code})` : "")) });
      continue;
    }
    if (!pyStrip(text)) {
      notes.push(`${name}: ` + (kind.endsWith("needs-ai") ? "photos and scanned PDFs need our AI reader, which is switched off here. " +
        "Upload a PDF exported from your billing software, an Excel price list, or type a few lines."
        : "could not read any text. Try a sharper photo or a PDF."));
      documents.push({ file: name, type: "Unreadable", found: [] });
      continue;
    }
    let layer = "";
    if (text.includes("@@TEXTLAYER")) { // jumbled PDF: products from the page image, fields from the text layer
      const at = text.indexOf("\n\f\n@@TEXTLAYER\n");
      if (at < 0) throw new Error("ValueError: not enough values to unpack (expected 2, got 1)");
      [text, layer] = [text.slice(0, at), text.slice(at + "\n\f\n@@TEXTLAYER\n".length)];
    }
    const parsed = parseDocument(name, text, kind === "text");
    const [docType, , prods] = parsed;
    let [, comp, , ev] = parsed;
    if (layer) {
      const [, compLayer, , evLayer] = parseDocument(name, layer);
      comp = { ...comp, ...Object.fromEntries(Object.entries(compLayer).filter(([, v]) => truthy(v))) };
      const seen = new Set(evLayer.map((x) => x[0]));
      ev = [...evLayer, ...ev.filter((e) => !seen.has(e[0]))];
    }
    for (const [k, v] of Object.entries(comp)) if (truthy(v) && !truthy(company[k])) company[k] = v;
    products.push(...prods);
    documents.push({ file: name, type: docType, read_by: kind.startsWith("pdf") || kind.startsWith("image") ? "on-device OCR" : "text",
      found: [...ev.map(([k, v]) => `${k}: ${v}`), ...prods.map((p) => `product: ${p.name}` + (p.hs_code ? ` (HS ${p.hs_code})` : ""))],
      products: prods.length, text_preview: cpSlice(text, 0, 600) });
  }
  if (pyStrip(typedText)) {
    const [, comp, prods] = parseDocument("typed note", typedText);
    for (const [k, v] of Object.entries(comp)) if (truthy(v) && !truthy(company[k])) company[k] = v;
    if (prods.length) products.push(...prods);
    else if (!products.length) {
      products.push({ name: cpSlice(pyStrip(typedText), 0, 60), description: pyStrip(typedText), materials: "",
        for_whom: "", price_inr: firstPrice(typedText), price_unit: "per piece",
        moq: null, monthly_capacity: null, unit: "pieces", hs_code: "" });
    }
  }
  return { company, products, notes: notes.join("; "), documents };
}

const truthy = (v: unknown) => !(v == null || v === "" || v === 0 || v === false || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length));

const NAME_KEYS = ["product", "item", "name", "article"];

export function productsFromTable(name: string, data: Buffer): Json[] {
  const all = pySplitlines(tableText(name, data)).filter((l) => !l.startsWith("#")).map((l) => l.split(" | "));
  const isHeader = (row: string[]) => { // a product column and, in another cell, a price or HS column
    const low = row.map((h) => h.toLowerCase());
    const names = new Set(low.flatMap((h, i) => (NAME_KEYS.some((k) => h.includes(k)) ? [i] : [])));
    return names.size > 0 && low.some((h, i) => !names.has(i) && ["price", "rate", "hsn", "hs code"].some((k) => h.includes(k)));
  };
  const at = all.slice(0, 10).findIndex(isHeader); // a title or company line often sits above the header row
  const lines = all.slice(at < 0 ? 0 : at);
  if (!lines.length) return [];
  const header = lines[0].map((h) => h.toLowerCase());
  const col = (...keys: string[]) => { const i = header.findIndex((h) => keys.some((k) => h.includes(k))); return i < 0 ? null : i; };
  // the product column, not "Item code" or "Article no" beside it
  const own = header.findIndex((h) => NAME_KEYS.some((k) => h.includes(k)) && !R(`${WB}(?:code|no|id|sr)${WB}|#`).test(h));
  const cName = own < 0 ? col(...NAME_KEYS) : own;
  const [cDesc, cPrice] = [col("desc", "material"), col("price", "rate")];
  const [cMoq, cHs, cUnit] = [col("moq", "minimum"), col("hsn", "hs code", "hs", "itc"), col("unit", "uom")];
  const cCap = col("capacity", "per month", "monthly");
  const out: Json[] = [];
  for (const r of lines.slice(1)) {
    const get = (c: number | null) => (c != null && c < r.length ? pyStrip(r[c]) : "");
    if (!get(cName)) continue;
    const price = numberIn(get(cPrice));
    const moq = numberIn(get(cMoq));
    const cap = numberIn(get(cCap));
    out.push({ name: get(cName), description: get(cDesc) || get(cName), materials: "",
      for_whom: "", price_inr: price ? pyFloat(price) : null,
      price_unit: get(cUnit) ? `per ${get(cUnit)}` : "per piece",
      moq: moq ? pyFloat(moq) : null, monthly_capacity: cap ? pyFloat(cap) : null,
      unit: UNIT_WORDS[get(cUnit).toLowerCase()] ?? "pieces", hs_code: get(cHs).replace(/\D/g, ""),
      source: `${name}: row ${get(cName)}` });
  }
  return out;
}

/** The first well-formed number in a spreadsheet cell ("1,450.00" -> "1450.00"; "1.2.3" -> "1.2"), or "". */
const numberIn = (cell: string) => cell.replace(/[^\d.]/g, "").match(/\d+(?:\.\d+)?/)?.[0] ?? "";

function firstPrice(text: string): number | null {
  const m = text.match(R(`(?:₹|${WB}(?:rs\\.?|inr))${sp}*(\\d[\\d,]*(?:\\.\\d+)?)`, "i"));
  return m ? num(m[1]) : null;
}

/** Fill blanks in the existing profile and append new products (by name). */
export function merge(profileIn: Json | null, extracted: Json): Json {
  const profile = profileIn && Object.keys(profileIn).length ? profileIn : { company: {}, products: [] };
  profile.company ??= {};
  const comp = profile.company;
  for (const [k, v] of Object.entries(extracted.company ?? {})) if (truthy(v) && !truthy(comp[k])) comp[k] = v;
  profile.products ??= [];
  const names = new Set(profile.products.map((p: Json) => p.name.toLowerCase()));
  for (const p of extracted.products ?? []) {
    if (p.name && !names.has(p.name.toLowerCase())) {
      p.id = `p${profile.products.length + 1}`;
      profile.products.push(p);
      names.add(p.name.toLowerCase());
    }
  }
  if (extracted.notes) (profile.notes ??= []).push(extracted.notes);
  if (extracted.documents && extracted.documents.length) (profile.documents ??= []).push(...extracted.documents);
  return profile;
}

/** For the parity tests only. */
export const tableTextForTests = (filename: string, data: Buffer) => tableText(filename, data);
