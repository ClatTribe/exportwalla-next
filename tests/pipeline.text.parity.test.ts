// Document reading at index time, against the Python pipeline: web pages to text (CPython's HTMLParser and
// html.unescape semantics), PDF text clean-up and chunking. Real cached pages plus generated edge cases.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DATA_DIR } from "../src/lib/config";
import { chunkFixed, chunkStructured, cleanPdfText } from "../src/pipeline/chunk";
import { htmlToText, unescape } from "../src/pipeline/html";
import { type Answer, python } from "./bridge";

const DOCS = path.join(DATA_DIR, "raw", "docs");

/** Seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FRAGMENTS = [
  "<p>Rules of origin</p>", "<P>Upper</P>", "<br>", "<br/>", "<BR />", "<h1>Article 3</h1>", "<h2 id='x'>Proof of origin</h2>", "<h5>five</h5>",
  "<div class=\"a>b\">quoted gt</div>", "<li>item</li>", "<td>cell</td><th>head</th>", "<tr>", "</tr>", "<table>", "</table>",
  "<script>var a = '</p>'; if (a < b) {}</script>", "<script>x</scr ipt>still script</script>", "<style>p{color:red}</style>", "<SCRIPT>y</SCRIPT>",
  "<nav><a href=/>home</a></nav>", "<footer>foot</footer>", "<header>head</header>", "<aside>side</aside>", "<form><button>go</button></form>",
  "<svg><title>icon</title></svg>", "<noscript>no js</noscript>", "<title>Page &amp; title</title>", "<title>a <b>bold</b> title</title>",
  "<textarea>raw <b>text</b> &lt;</textarea>", "<!-- comment -->", "<!---->", "<!-->", "<!--->", "<!-- a --!> b", "<!-- unclosed",
  "<!DOCTYPE html>", "<!doctype html>", "<?xml version='1.0'?>", "<![CDATA[ data ]]>", "<!bogus>", "</ >", "</>", "</3>", "<3 hearts", "a < b",
  "&amp;", "&amp;lt;", "&lt;p&gt;", "&nbsp;", "&copy", "&copy;", "&notin;", "&notit;", "&AMP", "&#65;", "&#x41;", "&#x80;", "&#0;", "&#xD800;",
  "&#1114112;", "&#xFFFE;", "&#11;", "&unknown;", "& alone", "&#", "&#x", "Tom &amp Jerry", " nbsp ", "\t tab \t", "\r\n", "\n\n\n\n",
  "Article 5\nDefinitions", "plain text", "Ünïcödé — “quotes”", "😀 emoji", "<a href='x'>link</a>", "<img src=x alt='a'>", "<input value=\"&amp;\">",
  "<span\nclass=x>multi-line tag</span>", "<div", "<p>end &am", "<plaintext><p>all text</p>", "<xmp><b>raw</b></xmp>", "<iframe><p>x</p></iframe>",
  "<a b='c' d=\"e\" f=g/>", "<p/>", "<p / >", "<ul><li>one<li>two</ul>", "<dd>d</dd><dt>t</dt>", "<section>s</section><article>a</article>",
];

function cases(): string[] {
  const out: string[] = [...FRAGMENTS];
  const r = rng(20261104);
  for (let i = 0; i < 2500; i++) {
    const n = 1 + Math.floor(r() * 12);
    out.push(Array.from({ length: n }, () => FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]).join(r() < 0.3 ? "\n" : ""));
  }
  return out;
}

async function compare(fn: string, inputs: string[], ts: (x: string) => unknown) {
  const py = await python(inputs.map((x) => ({ fn, args: [x] })));
  let same = 0;
  const diffs: string[] = [];
  inputs.forEach((x, i) => {
    let mine: Answer;
    try { mine = { ok: true, value: JSON.parse(JSON.stringify(ts(x))) }; } catch (e) { mine = { ok: false, error: String(e) }; }
    if (JSON.stringify(py[i].ok ? py[i].value : "error") === JSON.stringify(mine.ok ? mine.value : "error")) same++;
    else if (diffs.length < 6) diffs.push(`${JSON.stringify(x).slice(0, 200)}\n   python ${JSON.stringify(py[i]).slice(0, 300)}\n   ts     ${JSON.stringify(mine).slice(0, 300)}`);
  });
  console.log(`${fn}: ${same}/${inputs.length} identical`);
  if (diffs.length) console.log(diffs.join("\n"));
  expect(same).toBe(inputs.length);
}

describe("document reading at index time, parity with Python", () => {
  test("web pages to text: cached official pages and generated edge cases", async () => {
    const real = fs.existsSync(DOCS) ? fs.readdirSync(DOCS).filter((f) => f.endsWith(".bin")).map((f) => fs.readFileSync(path.join(DOCS, f)))
      .filter((b) => b.subarray(0, 5).toString("latin1") !== "%PDF-").map((b) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b)) : [];
    await compare("html_to_text", [...real, ...cases()], htmlToText);
    await compare("html_unescape", cases(), unescape);
  });

  test("PDF text clean-up and chunking", async () => {
    const texts: string[] = [];
    const r = rng(7);
    const lines = ["ARTICLE 3.20", "Proof of Origin", "1. An originating product shall", "be accompanied by", "(a) a certificate", "Page 3 of 40",
      "- 12 -", "Annex 2A", "Rules of Origin", "SECTION B", "The exporter-", "ing party shall keep records for five years.", "Schedule of", "  ",
      "CHAPTER IV: CUSTOMS", "Rule 7", "Definitions", "(iv) means;", "Article 5", "Short.", "A long sentence: Another one; And more. Then (b) item",
      "@@H2 Import tax", "Import VAT: 20% standard rate. Source: https://example.gov", "RUNNING HEADER 2026"];
    for (let i = 0; i < 400; i++) {
      const pages = 1 + Math.floor(r() * 6);
      texts.push(Array.from({ length: pages }, () => ["RUNNING HEADER 2026", ...Array.from({ length: 3 + Math.floor(r() * 25) },
        () => lines[Math.floor(r() * lines.length)]), String(Math.floor(r() * 99))].join(r() < 0.1 ? "\r\n" : "\n")).join("\f"));
    }
    await compare("clean_pdf_text", texts, cleanPdfText);
    const cleaned = texts.map(cleanPdfText);
    const long = Array.from({ length: 40 }, (_, i) => cleaned.slice(i * 10, i * 10 + 10).join("\n\n").repeat(1 + (i % 4)));
    await compare("chunk_structured", [...cleaned, ...long], chunkStructured);
    await compare("chunk_fixed", [...cleaned.slice(0, 50), ...long], chunkFixed);
  });
});
