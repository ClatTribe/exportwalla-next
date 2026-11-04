// Python number behaviour, reproduced exactly so the TypeScript engine prints the same figures as the Python one.

/** Python's round(x, nd): rounds the exact binary value of x, ties to even, then returns the nearest double. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else { mant |= 1n << 52n; e = exp - 1075; }
  // |x| * 10^nd = mant * 10^nd * 2^e, as an exact fraction num/den
  let num = mant * 10n ** BigInt(nd), den = 1n;
  if (e >= 0) num <<= BigInt(e); else den <<= BigInt(-e);
  let q = num / den;
  const twice = 2n * (num % den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const v = Number(`${q}e-${nd}`);
  return negative ? -v : v;
}

/** Python's f"{x:g}": 6 significant digits, trailing zeros dropped, exponent form below 1e-4 or from 1e6. */
export function fmtG(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const [m, ex] = x.toExponential(5).split("e");
  const exp = Number(ex);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 6) return `${strip(m)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  return strip(x.toFixed(5 - exp));
}

/** Exact decimal digits of |x| * 10^nd rounded half-to-even (as Python's float formatting does). */
function scaledDigits(x: number, nd: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else { mant |= 1n << 52n; e = exp - 1075; }
  let num = mant * 10n ** BigInt(nd), den = 1n;
  if (e >= 0) num <<= BigInt(e); else den <<= BigInt(-e);
  let q = num / den;
  const twice = 2n * (num % den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  return q;
}

/** Python's format(x, "<sign><,>.<nd>f"): fixed point, half-to-even on the exact value, optional sign and commas. */
export function fmtFixed(x: number, nd: number, opts: { sign?: boolean; comma?: boolean } = {}): string {
  const negative = x < 0 || Object.is(x, -0);
  const digits = scaledDigits(x, nd).toString().padStart(nd + 1, "0");
  let int = nd ? digits.slice(0, -nd) : digits;
  const frac = nd ? digits.slice(-nd) : "";
  if (opts.comma) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? "-" : opts.sign ? "+" : "";
  return sign + int + (nd ? "." + frac : "");
}

/** Python's format(x, ".<nd>%") and "+.<nd>%": x * 100 as a double, then fixed point. */
export const fmtPct = (x: number, nd: number, sign = false) => fmtFixed(x * 100, nd, { sign }) + "%";

/** Python's str() of a float: shortest round-trip digits, always with a decimal point or exponent ("12.0", "1e-05"). */
export function pyFloatStr(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(x);
  if (abs >= 1e16 || abs < 1e-4) {
    const [m, e] = x.toExponential().split("e");
    const n = Number(e);
    return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const s = String(x);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
}

/** Python's len(): code points, not UTF-16 units. */
export const pyLen = (s: string) => [...s].length;

/** Python's str.split() with no argument: split on runs of whitespace, no empty strings. */
export const pySplit = (s: string) => s.split(new RegExp(`[${S}]+`, "u")).filter(Boolean);

/** Python's \b for str patterns: Unicode letters, digits and underscore count as word characters. */
export const WB = String.raw`(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))`;

/** Python's dict.fromkeys(xs): unique values, first occurrence order. */
export const uniq = <T,>(xs: Iterable<T>): T[] => [...new Set(xs)];

/** Python's built-in sum() of floats (CPython 3.12+): Neumaier compensated summation, compensation added at the end
 * if finite. Use it wherever the Python engine calls sum() on floats, or scores can round differently. */
export function pySum(xs: Iterable<number>): number {
  let f = 0, c = 0;
  for (const x of xs) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  return c && Number.isFinite(c) ? f + c : f;
}

/** Python's str.splitlines(): splits on \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029; no trailing empty line. */
export function pySplitlines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (/(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/.test(s)) parts.pop();
  return parts;
}

/** Python's str.strip(chars): remove any of `chars` from both ends (whitespace when omitted). */
export function pyStrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(new RegExp(`^[${S}]+|[${S}]+$`, "gu"), "");
  const set = new Set(Array.from(chars));
  const cp = Array.from(s);
  let a = 0, b = cp.length;
  while (a < b && set.has(cp[a])) a++;
  while (b > a && set.has(cp[b - 1])) b--;
  return cp.slice(a, b).join("");
}

/** Python slicing s[a:b] by code point (JavaScript strings index UTF-16 units, which differ for emoji). */
export function cpSlice(s: string, a: number, b?: number): string {
  // fast path: no astral characters, so code units and code points agree
  if (!/[\uD800-\uDFFF]/.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join("");
}

/** Python's float(s) for plain decimal strings: raises on anything that is not a number (float("") is an error). */
export function pyFloat(s: string): number {
  const t = s.trim();
  if (!/^[+-]?(\d+(_\d+)*)?(\.(\d+(_\d+)*)?)?([eE][+-]?\d+)?$/.test(t) || !/\d/.test(t)) throw new Error(`ValueError: could not convert string to float: '${s}'`);
  return Number(t.replaceAll("_", ""));
}

/** Python's \w for str patterns (letters, digits, underscore in any script), for use inside a character class with the u flag. */
export const W = String.raw`\p{L}\p{N}_`;

/** Python's \s (and str.isspace): unlike JavaScript's \s it includes \x1c-\x1f and \x85 and excludes the BOM \ufeff.
 * Use inside a character class with the u flag: new RegExp(`[${S}]+`, "u"). */
export const S = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

/** Python's html.escape(s): &, <, >, " and ' (as &#x27;). */
export const escapeHtml = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Python's html.unescape for the entities the site produces: the five escapes, &nbsp; and numeric references. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[ref] ?? m;
  });
}

function pyJsonString(s: string, ascii: boolean): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || (ascii && c > 0x7e)) { // ensure_ascii escapes everything outside " " to "~"
      if (c > 0xffff) {
        const v = c - 0x10000;
        out += `\\u${(0xd800 + (v >> 10)).toString(16)}\\u${(0xdc00 + (v & 0x3ff)).toString(16)}`;
      } else out += `\\u${c.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out + '"';
}

/** Python's json.dumps(x, ensure_ascii=..., indent=...): ", " and ": " separators, Python's string escapes. Integral
 * numbers print as ints (JavaScript cannot tell 20.0 from 20). */
export function pyJson(x: unknown, opts: { ascii?: boolean; indent?: number } = {}): string {
  const ascii = opts.ascii ?? true, ind = opts.indent;
  const walk = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isNaN(v) ? "NaN" : !Number.isFinite(v) ? (v > 0 ? "Infinity" : "-Infinity") : Number.isInteger(v) ? String(v) : pyFloatStr(v);
    if (typeof v === "string") return pyJsonString(v, ascii);
    const entries: [string | null, unknown][] = v instanceof Map ? [...v.entries()].map(([k, x]) => [String(k), x])
      : Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v as object);
    const open = Array.isArray(v) ? "[" : "{", close = Array.isArray(v) ? "]" : "}";
    if (!entries.length) return open + close;
    const items = entries.map(([k, x]) => (k === null ? "" : pyJsonString(k, ascii) + ": ") + walk(x, depth + 1));
    if (ind === undefined) return open + items.join(", ") + close;
    const pad = "\n" + " ".repeat(ind * (depth + 1));
    return open + pad + items.join("," + pad) + "\n" + " ".repeat(ind * depth) + close;
  };
  return walk(x, 0);
}
