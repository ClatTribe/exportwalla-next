# Exportwalla

Export desk for Indian manufacturers: HS code, best countries, the duty an Indian product pays in 66 countries, UK
importers, a landed-cost quote and export documents, free; plus a human desk paid per shipment. Next.js 16, SQLite
(read-only on a deploy), plain server-rendered HTML for every public page.

## Run it

```bash
npm install
cp .env.example .env          # optional locally; see the comments in the file
npm run dev                   # http://localhost:3000
```

| Path | What |
|---|---|
| `src/app/[[...path]]/route.ts` | Every public page, its `.md` twin, sitemap, robots, llms files (prerendered at build) |
| `src/app/api/**`, `src/app/mcp` | Workspace API, public API (`/docs`), MCP server, leads |
| `src/lib/engine/*` | Duty, Section 301, classification, country ranking, buyers, quotes, documents, retrieval, document reading |
| `src/lib/pages/*` | Page renderers; content in `src/content/*.json`, templates in `src/templates/` |
| `src/pipeline/*` | The data pipeline (`npm run data`) |
| `src/checks/*` | Release checks and evaluations (`npm run check`), the release script (`npm run release`) |
| `data/` | `reference.db` and `seo_index.json` ship with the deploy; `raw/` (API cache) and `export_desk.db` (full build) stay local |
| `tools/ocr` | On-device OCR (macOS Vision, source `ocr.swift`), used locally to read PDFs and photos |

## Data

```bash
npm run data -- run-all --refresh        # re-fetch the leather wedge (UK tariff, US HTS, HMRC, Comtrade)
npm run data -- india-exports            # India's exports by partner and product
npm run data -- wits                     # WITS tariffs for every market
npm run data -- scope-pull               # the full product scope (about an hour from scratch)
npm run data -- rules-docs               # official trade-agreement texts into the search index
npm run data -- build-reference          # data/reference.db (+ .gz) for deploys
npm run data -- site-index               # data/seo_index.json for the pages
```

Every response is cached under `data/raw/`, so a re-run replays the cache; `--refresh` fetches again.
`EXPORTWALLA_OFFLINE=1` makes a cache miss an error. Products outside the shipped data get their trade figures from
UN Comtrade on demand (into a `/tmp` overlay on the server).

## Release and deploy

```bash
SITE_URL=https://www.exportwalla.com npm run release                     # reference db, data index, build, crawl, checks
SITE_URL=https://www.exportwalla.com npm run release -- --deploy preview # ...then a Vercel preview
SITE_URL=https://www.exportwalla.com npm run release -- --deploy prod    # ...then production
npm run check -- indexnow                                                # after a production release
```

A production deploy refuses to go without `LEGAL_NAME`, `CONTACT_EMAIL`, `GRIEVANCE_OFFICER`, a real `DESK_PHONE`, and
SMTP settings or `LEAD_WEBHOOK_URL`. Set the same variables in the Vercel project.

**Vercel:** one Next.js project, root `exportwalla-next`. The upload is about 41 MB: the database goes up compressed
(`data/reference.db.gz`, 26 MB, written by `build-reference`) and `prebuild` unpacks it, so the Hobby plan's CLI
upload limit is not a problem. Each server function then carries `reference.db` (119 MB) and `seo_index.json`
(13 MB), about 140 MB, under the 250 MB function limit. Node 22 or newer.

**Document uploads:** one request may carry 4.5 MB on Vercel, so uploads are limited to 4 MB in all. The workspace
makes photos over 1 MB smaller in the browser first (JPEG, long edge 2400 px), so phone photos fit; PDFs and
spreadsheets go as they are.

## Checks

```bash
npm test                     # everything below except the data pipeline (~5 minutes, builds once)
npm run test:pipeline        # both data pipelines rebuild everything offline, plus the retrieval ablation
npm run check -- seo --base http://localhost:3000    # crawl a running site
npm run check -- matrix --sample 8                   # every country x stage, writes data/verify_matrix.json (/review)
```

The tests compare this app with the Python app it replaced (`../export-desk`, kept as the reference until the
switch): see `MIGRATION.md`.
