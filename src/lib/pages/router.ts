// Every public page and crawl file by URL path, as export-desk/scripts/build_static.py writes them (which pages have a
// .md twin included). Served by src/app/[[...path]]/route.ts and prerendered from allPaths() at build time.
import { pyJson } from "../py";
import { loadIndex } from "../site";
import { type Json, loadGuides } from "./common";
import { llmsFull, llmsTxt, robots, sitemap, sitemapUrls, toMarkdown } from "./crawl";
import { TOOLS, guidePage, guidesHub } from "./guides";
import { homeHtml, manifest, shell } from "./home";
import { aboutPage, guide, legal, notFound, sourcesPage } from "./info";
import { countryHub, countryPage, ftaHub, ftaPage, indiaExportsPage, pairPage, productHub, productPage } from "./reference";
import { contactPage, pricingPage, refundPage, toolHsFinder, toolImportDuty, toolPriceCalculator, toolReadiness, toolsHub } from "./tools";

export interface Rendered { status: number; type: string; body: string; headers?: Record<string, string> }

const HTML = "text/html; charset=utf-8", MD = "text/markdown; charset=utf-8";

const TOOL_PAGES: Record<string, () => string> = { "hs-code-finder": toolHsFinder, "import-duty": toolImportDuty,
  "export-price-calculator": toolPriceCalculator, "export-readiness": toolReadiness };

/** Pages without a .md twin (hubs, legal pages, the home pages, the Hinglish pillar guide). */
const FIXED: Record<string, () => string> = {
  "/": () => homeHtml("en"), "/hi": () => homeHtml("hi"), "/app": () => shell("app.html"), "/review": () => shell("review.html"),
  "/export-to": countryHub, "/hs-code": productHub, "/refund-policy": refundPage, "/hi/export-kaise-kare": () => guide("hi"),
  "/sources": sourcesPage, "/privacy": () => legal("privacy"), "/terms": () => legal("terms"),
};

/** Pages with a .md twin. */
function page(p: string): string | null {
  const fixed: Record<string, () => string> = { "/fta": ftaHub, "/india-exports": indiaExportsPage, "/guide": guidesHub, "/tools": toolsHub,
    "/pricing": pricingPage, "/contact": contactPage, "/about": aboutPage, "/guide/how-to-export-from-india": () => guide("en") };
  if (Object.hasOwn(fixed, p)) return fixed[p]();
  const s = p.split("/").slice(1);
  if (s.length === 2 && s[0] === "export-to") return countryPage(s[1]);
  if (s.length === 2 && s[0] === "hs-code") return productPage(s[1]);
  if (s.length === 3 && s[0] === "export") return pairPage(s[1], s[2]);
  if (s.length === 2 && s[0] === "fta") return ftaPage(s[1]);
  if (s.length === 2 && s[0] === "guide") return guidePage(s[1]);
  if (s.length === 3 && s[0] === "hi" && s[1] === "guide") return guidePage(s[2], "hi");
  if (s.length === 2 && s[0] === "tools" && Object.hasOwn(TOOL_PAGES, s[1])) return TOOL_PAGES[s[1]]();
  return null;
}

export function render(p: string): Rendered {
  if (Object.hasOwn(FIXED, p)) return { status: 200, type: HTML, body: FIXED[p]() };
  switch (p) {
    case "/sitemap.xml": return { status: 200, type: "application/xml", body: sitemap() };
    case "/robots.txt": return { status: 200, type: "text/plain; charset=utf-8", body: robots() };
    case "/llms.txt": return { status: 200, type: MD, body: llmsTxt() };
    case "/llms-full.txt": return { status: 200, type: MD, body: llmsFull() };
    case "/site.webmanifest": return { status: 200, type: "application/manifest+json", body: pyJson(manifest()) };
  }
  const key = process.env.INDEXNOW_KEY ?? "";
  if (key && p === `/${key}.txt`) return { status: 200, type: "text/plain; charset=utf-8", body: key };
  if (p.endsWith(".html")) {
    const clean = p === "/index.html" ? "/" : p.slice(0, -5);
    return { status: 308, type: "text/plain", body: "", headers: { Location: clean } };
  }
  if (p.endsWith(".md")) {
    const html = page(p.slice(0, -3));
    if (html !== null) return { status: 200, type: MD, body: toMarkdown(html) };
  } else {
    const html = page(p);
    if (html !== null) return { status: 200, type: HTML, body: html };
  }
  return { status: 404, type: HTML, body: notFound() };
}

/** Every path the static build writes, for prerendering. */
export function allPaths(): string[] {
  const d = loadIndex(), gs = loadGuides();
  const md = [...Object.values(d.countries).map((c) => `/export-to/${(c as Json).slug}`), ...[...d.products.values()].map((p: Json) => `/hs-code/${p.slug}`),
    ...Object.keys(d.pairs).map((k) => { const [h, iso] = k.split("|"); return `/export/${d.products.get(h).slug}/${d.countries[iso].slug}`; }),
    "/fta", ...Object.values(d.ftas ?? {}).map((f) => `/fta/${(f as Json).slug}`), "/india-exports", "/guide",
    ...[...gs].flatMap(([s, g]) => (g.hi ? [`/guide/${s}`, `/hi/guide/${s}`] : [`/guide/${s}`])),
    "/tools", ...TOOLS.map(([s]) => `/tools/${s}`), "/pricing", "/contact", "/about", "/guide/how-to-export-from-india"];
  const out = [...Object.keys(FIXED), ...md, ...md.map((p) => p + ".md"),
    "/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt", "/site.webmanifest"];
  if (sitemapUrls().some((u) => !out.includes(u))) throw new Error("a sitemap URL has no page");
  return out;
}
