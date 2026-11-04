// Tell Bing, Yandex and Seznam about every URL in the sitemap once the site is live (ChatGPT search leans on Bing).
// Port of `python -m app.seo indexnow`. Needs INDEXNOW_KEY and the production SITE_URL.
import { siteUrl } from "../lib/config";
import { sitemap } from "../lib/pages/crawl";

export async function indexNow(): Promise<number> {
  const key = process.env.INDEXNOW_KEY ?? "", site = siteUrl();
  if (!key || site.startsWith("http://localhost")) { console.error("Set INDEXNOW_KEY and SITE_URL in .env first."); return 1; }
  const urls = [...sitemap().matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  for (let i = 0; i < urls.length; i += 10_000) {
    const batch = urls.slice(i, i + 10_000);
    const r = await fetch("https://api.indexnow.org/indexnow", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: site.replace(/^https?:\/\//, ""), key, keyLocation: `${site}/${key}.txt`, urlList: batch }), signal: AbortSignal.timeout(60_000) });
    console.log(r.status, batch.length, "URLs");
  }
  return 0;
}
