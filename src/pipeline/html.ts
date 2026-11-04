// Text from an official web page, exactly as the Python pipeline gets it: a port of CPython 3.15's html.unescape and
// of the parts of html.parser.HTMLParser that decide where text, tags, comments and raw-text elements are (attributes
// matter only for finding where a tag ends), plus app/rag.py's _HTMLText and html_to_text on top. Pages are fed once
// and never closed, as there: an unterminated construct at the very end is dropped.
import tables from "./html5-entities.json";
import { S, pyStrip } from "../lib/py";

const HTML5: Record<string, string> = tables.html5;
const INVALID_CHARREFS: Record<string, string> = tables.invalid_charrefs;
const INVALID_CODEPOINTS = new Set<number>(tables.invalid_codepoints);

function replaceCharref(s: string): string {
  if (s[0] === "#") {
    const num = s[1] === "x" || s[1] === "X" ? parseInt(s.slice(2).replace(/;+$/, ""), 16) : parseInt(s.slice(1).replace(/;+$/, ""), 10);
    if (Object.hasOwn(INVALID_CHARREFS, String(num))) return INVALID_CHARREFS[String(num)];
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  if (Object.hasOwn(HTML5, s)) return HTML5[s];
  const cp = Array.from(s); // the longest matching name, as the standard defines it
  for (let x = cp.length - 1; x > 1; x--) {
    const head = cp.slice(0, x).join("");
    if (Object.hasOwn(HTML5, head)) return HTML5[head] + cp.slice(x).join("");
  }
  return "&" + s;
}

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

/** CPython's html.unescape: every HTML5 named reference, numeric references with the standard's replacements. */
export const unescape = (s: string) => (s.includes("&") ? s.replace(CHARREF, (_, ref) => replaceCharref(ref)) : s);

// ---------------------------------------------------------------- the tokenizer (html.parser, convert_charrefs=True)

const STARTTAGOPEN = /<[a-zA-Z]/y;
const ENDTAGOPEN = /<\/[a-zA-Z]/y;
const COMMENTCLOSE = /--!?>/g;
const COMMENTABRUPTCLOSE = /-?>/y;
const TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATETAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const CDATA_CONTENT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA_CONTENT = new Set(["textarea", "title"]);

const at = (re: RegExp, s: string, i: number) => { re.lastIndex = i; return re.exec(s); };

export interface Handler {
  starttag(tag: string): void;
  endtag(tag: string): void;
  data(text: string): void;
}

/** HTMLParser.feed(raw) once, without close(). */
export function parseHtml(raw: string, h: Handler) {
  const n = raw.length;
  let cdataElem: string | null = null, escapable = true, interesting: RegExp | null = null;
  const setCdata = (elem: string, esc: boolean) => {
    cdataElem = elem;
    escapable = esc;
    interesting = elem === "plaintext" ? /$/g : new RegExp(`</${elem}(?=[\\t\\n\\r\\f />])`, "gi");
  };
  const clearCdata = () => { cdataElem = null; escapable = true; interesting = null; };

  const bogusComment = (i: number) => { const pos = raw.indexOf(">", i + 2); return pos === -1 ? -1 : pos + 1; };

  const parseStarttag = (i: number): number => {
    const loc = at(LOCATETAGEND, raw, i + 1)!;
    const endpos = loc.index + loc[0].length;
    if (raw[endpos - 1] !== ">") return -1;
    const m = at(TAGFIND, raw, i + 1)!;
    let k = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    while (k < endpos) {
      const a = at(ATTRFIND, raw, k);
      if (!a || a[0].length === 0 && !a[1]) break;
      k = a.index + a[0].length;
    }
    const end = pyStrip(raw.slice(k, endpos));
    if (end !== ">" && end !== "/>") { h.data(raw.slice(i, endpos)); return endpos; }
    if (end.endsWith("/>")) { h.starttag(tag); h.endtag(tag); return endpos; }
    h.starttag(tag);
    if (CDATA_CONTENT.has(tag) || tag === "plaintext") setCdata(tag, false);
    else if (RCDATA_CONTENT.has(tag)) setCdata(tag, true);
    return endpos;
  };

  const parseEndtag = (i: number): number => {
    if (raw.indexOf(">", i + 2) < 0) return -1;
    if (!at(ENDTAGOPEN, raw, i)) return raw.slice(i + 2, i + 3) === ">" ? i + 3 : bogusComment(i);
    const loc = at(LOCATETAGEND, raw, i + 2)!;
    const j = loc.index + loc[0].length;
    if (raw[j - 1] !== ">") return -1;
    h.endtag(at(TAGFIND, raw, i + 2)![1].toLowerCase());
    clearCdata();
    return j;
  };

  const parseComment = (i: number): number => {
    let m = at(COMMENTABRUPTCLOSE, raw, i + 4);
    if (!m) {
      COMMENTCLOSE.lastIndex = i + 4;
      m = COMMENTCLOSE.exec(raw);
      if (!m) return -1;
    }
    return m.index + m[0].length;
  };

  const parseDeclaration = (i: number): number => {
    if (raw.startsWith("<!--", i)) return parseComment(i);
    if (raw.startsWith("<![CDATA[", i)) { const j = raw.indexOf("]]>", i + 9); return j < 0 ? -1 : j + 3; }
    if (raw.slice(i, i + 9).toLowerCase() === "<!doctype") { const gt = raw.indexOf(">", i + 9); return gt === -1 ? -1 : gt + 1; }
    return bogusComment(i);
  };

  let i = 0;
  while (i < n) {
    let j: number;
    if (!cdataElem) {
      j = raw.indexOf("<", i);
      if (j < 0) {
        const amppos = raw.lastIndexOf("&");
        if (amppos >= Math.max(i, n - 34) && !/[\t\n\r\f ;]/.test(raw.slice(amppos))) break; // a reference cut at the end
        j = n;
      }
    } else {
      interesting!.lastIndex = i;
      const m = interesting!.exec(raw);
      if (!m) break;
      j = m.index;
    }
    if (i < j) h.data(escapable ? unescape(raw.slice(i, j)) : raw.slice(i, j));
    i = j;
    if (i === n) break;
    let k: number;
    if (at(STARTTAGOPEN, raw, i)) k = parseStarttag(i);
    else if (raw.startsWith("</", i)) k = parseEndtag(i);
    else if (raw.startsWith("<!--", i)) k = parseComment(i);
    else if (raw.startsWith("<?", i)) { const g = raw.indexOf(">", i + 2); k = g < 0 ? -1 : g + 1; }
    else if (raw.startsWith("<!", i)) k = parseDeclaration(i);
    else if (i + 1 < n) { h.data("<"); k = i + 1; }
    else break;
    if (k < 0) break; // incomplete, and the page is never closed
    i = k;
  }
}

// ---------------------------------------------------------------- app/rag.py html_to_text

const SKIP = new Set(["script", "style", "nav", "footer", "header", "noscript", "svg", "form", "aside", "button"]);
const BLOCK = new Set(["p", "div", "li", "tr", "br", "section", "article", "table", "ul", "ol", "dd", "dt", "td", "th"]);
const HEADING_TAG = /^h[1-4]$/;

/** Plain text of a page with "@@H<n>" heading markers, and its <title>. */
export function htmlToText(raw: string): [string, string] {
  const out: string[] = [];
  let skip = 0, title = "", inTitle = false;
  parseHtml(raw, {
    starttag(tag) {
      if (SKIP.has(tag)) skip++;
      else if (tag === "title") inTitle = true;
      else if (HEADING_TAG.test(tag)) out.push(`\n\n@@H${tag[1]} `);
      else if (BLOCK.has(tag)) out.push("\n");
    },
    endtag(tag) {
      if (SKIP.has(tag) && skip) skip--;
      else if (tag === "title") inTitle = false;
      else if (HEADING_TAG.test(tag) || BLOCK.has(tag)) out.push("\n");
    },
    data(text) {
      if (inTitle) title += text;
      else if (!skip) out.push(text);
    },
  });
  let text = unescape(out.join(""));
  text = text.replace(/[ \t ]+/g, " ");
  text = pyStrip(text.replace(new RegExp(`\\n[${S}]*\\n[${S}]*\\n+`, "gu"), "\n\n"));
  return [text, pyStrip(title)];
}
