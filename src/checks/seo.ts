// Crawl every public URL in the sitemap and check what search engines and AI assistants need: HTTP 200; a <title>
// of 20-95 characters, unique across the site; a meta description of 70-160 characters; exactly one <h1>; a canonical
// that matches the URL; JSON-LD that parses; internal links that resolve; and robots.txt, llms.txt, a markdown twin
// and the public API. Prints failures; returns 1 on any. Port of export-desk/evals/seo_check.py.
import { pyStrip } from "../lib/py";

async function get(url: string): Promise<[number, string]> {
  const r = await fetch(url, { redirect: "follow" });
  return [r.status, r.ok ? new TextDecoder("utf-8").decode(await r.arrayBuffer()) : ""];
}

/** A seeded pick of n items (the Python version used random.Random(1); a sample is a smoke test either way). */
function sample<T>(xs: T[], n: number): T[] {
  let s = 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pool = [...xs], out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

export async function seoCheck(base = "http://localhost:8040", sampleN = 0, concurrency = 16): Promise<number> {
  const [, sm] = await get(base + "/sitemap.xml");
  const locs = [...sm.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  // the site's public origin, from the sitemap itself: every URL is fetched from `base`, never from the live domain
  const SITE = locs.length ? new URL(locs[0]).origin : base;
  let urls = locs.map((u) => u.split(SITE).join(base));
  if (sampleN) urls = [...urls.slice(0, 5), ...sample(urls.slice(5), Math.min(sampleN, urls.length - 5))];
  const problems: string[] = [], titles = new Map<string, number>(), links = new Set<string>();
  const results: [string, number, string][] = new Array(urls.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < urls.length) { const i = next++; const [st, h] = await get(urls[i]); results[i] = [urls[i], st, h]; }
  }));
  for (const [u, st, h] of results) { // in sitemap order, so the report reads the same every run
    const p = u.slice(base.length) || "/";
    if (st !== 200) { problems.push(`${st} ${p}`); continue; }
    const tm = h.match(/<title>([\s\S]*?)<\/title>/);
    const t = tm ? pyStrip(tm[1]) : "";
    titles.set(t, (titles.get(t) ?? 0) + 1);
    if (!([...t].length >= 20 && [...t].length <= 95)) problems.push(`title length ${[...t].length}: ${p}`);
    const dsc = h.match(/<meta name="description" content="([^"]*)"/);
    if (!dsc || !([...dsc[1]].length >= 70 && [...dsc[1]].length <= 160)) problems.push(`description length ${dsc ? [...dsc[1]].length : 0}: ${p}`);
    if ((h.match(/<h1[\s>]/g) ?? []).length !== 1) problems.push(`h1 count ${(h.match(/<h1[ >]/g) ?? []).length}: ${p}`);
    const can = h.match(/<link rel="canonical" href="([^"]+)"/);
    if (!can || can[1].split(SITE).join(base).replace(/\/+$/, "") !== u.replace(/\/+$/, "")) problems.push(`canonical mismatch: ${p} -> ${can ? can[1] : "None"}`);
    for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { JSON.parse(m[1]); } catch { problems.push(`bad JSON-LD: ${p}`); }
    }
    for (const m of h.matchAll(/href="(\/[^"#?]*)"/g)) {
      const l = m[1];
      if (!l.startsWith("/static/") && !l.startsWith("/app") && !l.startsWith("/docs") && !l.includes("${")) links.add(l);
    }
  }
  const sorted = [...links].sort();
  const linkStatus: number[] = new Array(sorted.length);
  next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < sorted.length) { const i = next++; linkStatus[i] = (await get(base + sorted[i]))[0]; }
  }));
  sorted.forEach((l, i) => { if (linkStatus[i] !== 200) problems.push(`broken internal link ${linkStatus[i]}: ${l}`); });
  for (const [t, n] of titles) if (n > 1) problems.push(`duplicate title x${n}: ${t}`);
  for (const extra of ["/robots.txt", "/llms.txt", "/export-to/united-kingdom.md", "/api/public/country/GBR",
    "/api/public/duty?hs6=640391&country=GBR", "/openapi.json"]) {
    const [st, body] = await get(base + extra);
    if (st !== 200 || !body) problems.push(`${st} ${extra}`);
  }
  console.log(`checked ${results.length} pages, ${links.size} internal links`);
  const kinds = new Map<string, number>();
  for (const p of problems) { const k = /^\d/.test(p) ? p.split(" ")[0] : p.replace(/[ :].*/s, ""); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  for (const [kind, k] of [...kinds].map((x, i) => [x, i] as const).sort((a, b) => b[0][1] - a[0][1] || a[1] - b[1]).map(([x]) => x)) {
    console.log(`  ${String(k).padStart(5)} ${kind}`);
  }
  for (const p of problems) console.log("   " + p);
  console.log(`${problems.length} problems`);
  return problems.length ? 1 : 0;
}
