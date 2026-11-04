# Exportwalla: Python to Next.js migration tracker

The Python app (`../export-desk`) keeps serving production until every phase below is green. Each TypeScript part
is proven equal to its Python original by differential tests: the same inputs go through both engines, and any
difference fails the test. Plan: `../reports/Exportwalla full Nextjs migration.md`.

## Commands

```bash
npm test                                   # builds Next once, then every parity suite (needs ../export-desk with its .venv), ~4 minutes
npx vitest run -t "tariff"                 # one suite
SKIP_BUILD=1 npx vitest run tests/api.contract.test.ts   # one suite against the last test build (settings: tests/next.ts)
SKIP_BUILD=1 npx vitest run tests/screens.e2e.test.ts    # browser test; uses a cached Playwright Chromium (or CHROMIUM_PATH)
npm run test:pipeline                       # both pipelines rebuild everything offline, on their own (~2 minutes; needs data/raw)
cd ../export-desk && .venv/bin/python -m evals.golden   # refresh golden files after a Python change
```

- **Data:** read from `../export-desk/data` (`reference.db`, `reference/*.json`, `seo_index.json`) until phase 9 moves it.
  Override with `EXPORTWALLA_DATA`.
- **Python bridge:** `../export-desk/evals/bridge.py`. It takes one JSON call per line and returns the Python
  engine's answer, in read-only (deploy) mode, with an empty overlay.
- **Switched off on both sides during parity:** AI and the live UK tariff search (tested on their own in phase 4), and
  the on-demand Comtrade fetch (phase 9). Cited passages in documents are real on both sides.

## Status

| # | Phase | Status | Proof |
|---|---|---|---|
| 0 | Harness: golden files, Python bridge, parity test runner | ✅ done | `golden/`: 2,839 pages, 2,827 markdown copies, 6 text files, 928 API answers |
| 1 | Next.js 16 project, database layer (`better-sqlite3`), config | ✅ done (shell UI pending) | Full-text search matched Python: 2,320/2,320 rows, same order and scores |
| 2 | Engine A: duty, Section 301, VAT, lanes, deals (`src/lib/engine/markets.ts`) | ✅ done | `tests/markets.parity.test.ts`: **70,590/70,590 identical** (23,562 duty pairs; 8,937 Section 301 checks; 37,105 rounding, formatting and sum checks) |
| 3 | Engine B: classifier, country scoring, buyers, quote, documents, GSTIN (`src/lib/engine/stages.ts`, `gstin.ts`) | ✅ done | `tests/stages.parity.test.ts`: **7,750/7,750 identical** (1,317 classifications; 1,227 tariff searches; 375 country rankings; 1,981 quotes; 110 buyer and outreach results; 90 document sets) |
| 4 | Engine C: retrieval and cited answers (`src/lib/engine/rag.ts`), AI wrapper for Claude and Gemini (`src/lib/llm.ts`) | ✅ done | `tests/rag.parity.test.ts`: **4,848/4,848 identical** (1,018 searches incl. official-only and hybrid; 462 passage sets with fact cards; 2,686 snippets; all 66 countries' document sets; 154 answers). `tests/llm.test.ts` (9) and `tests/uksearch.test.ts` (3): request shapes, fallback beta and retry, errors, Gemini quote check, AI picks verified against candidates |
| 5 | Engine D: document reading (`src/lib/engine/intake.ts`), spreadsheet reader (`src/lib/xlsx.ts`) | ✅ done | `tests/intake.parity.test.ts`: **291/291 identical** (16 files read incl. OCR of real PDFs and photos; 196 documents parsed, synthetic and real; 6 spreadsheets as text and as product tables; 9 CSV encodings; 50 whole extractions without AI; 8 profile merges) |
| 6 | API, MCP and lead email route handlers (`src/app/api/**`, `src/app/mcp`, `src/lib/server/*`) | ✅ done | `tests/api.contract.test.ts`: **2,093/2,093 identical** HTTP answers from the FastAPI app and the built Next server (1,323 public API, status and docs calls; 18 MCP; 59 uploads read, 53 checks, 58 plans, 154 country changes, 336 quotes, 71 buyer picks; 21 lead and operator calls) and the same 5 webhook deliveries. `tests/lead.test.ts` (3): the lead email's recipients, reply-to and TLS mode |
| 7 | Pages: home (English and Hinglish), countries, HS codes, product x country, trade deals, guides, tools, pricing, legal, `.md` twins, sitemap, robots, llms files (`src/lib/pages/*`, `src/app/[[...path]]`) | ✅ done | `tests/pages.parity.test.ts`: **byte-identical** to the Python static build: 5,674/5,674 pages and files with default settings, 5,675/5,675 with every optional setting filled in (WhatsApp, legal name, email, grievance officer, verification tags, price, IndexNow key, Gemini), 11/11 static assets; served by `next start`, 5,684/5,684 paths with the right status and content type, 404 page and `.html` redirects |
| 8 | Workspace (`/app`) and review console (`/review`) screens, the site-wide contact dialog | ✅ done | `tests/screens.e2e.test.ts` (headless Chromium through `playwright-core`): one visit runs on the Python app and on the built Next app, **39/39 steps identical** and no page errors: typed note read, profile, all six plan tabs, another UK buyer, second product family, another country, re-quote, asking the rules, call back, an upload over 4 MB stopped in the browser, PDF + Excel + photo read, Hinglish workspace, review console, the contact dialog on a public page |
| 9 | Data pipeline (`src/pipeline/*`, `npm run data`): every ingester, official-text reading and chunking, the deploy database, the site index; trade data fetched on demand at request time | ✅ done | `tests/pipeline.parity.test.ts`: both pipelines rebuild everything offline from the same `data/raw` cache: **build database 27/27 tables, 1,446,852 rows identical; reference.db 28/28 tables, 1,454,802 rows identical** (search-index tables and SQLite value types included); **seo_index.json 9/9 sections identical** in key order. `tests/pipeline.text.parity.test.ts`: web page to text **2,601/2,601** (11 real pages + generated edge cases), `html.unescape` 2,590/2,590, PDF clean-up 400/400, chunking 530/530. `tests/tradedata.parity.test.ts`: on-demand Comtrade fetch, Python replays the cache TypeScript wrote and ranks countries identically |
| 10 | Release checks and release script in TypeScript; the app self-contained; Vercel configuration; local production rehearsal; then preview deploy and switch | 🟡 deploy pending | `tests/checks.parity.test.ts`: site crawl (2,836 pages, 2,733 links, 0 problems, same report), data structure check, every-country matrix on stored data (66 countries, same file and report), review replay: **4/4 identical**. Retrieval ablation in `npm run test:pipeline`. Rehearsal with `VERCEL=1` and a read-only `reference.db`: pages, 404, plan with UK buyers, leads, full crawl clean. Preview deploy needs your Vercel login and approval |

## Python behaviour reproduced on purpose (`src/lib/py.ts`)

- **Rounding:** `round(x, n)` rounds exact ties to even (0.125 → 0.12). JavaScript's `toFixed` gives 0.13. Use `pyRound`.
- **Number format:** `f"{x:g}"`: 6 significant digits, trailing zeros dropped, exponent form below 1e-4 and from 1e6.
  Use `fmtG`.
- **Format specs:** `:,.0f`, `:+.0%`, `:.1%` and `str(float)` ("12.0"). Use `fmtFixed`, `fmtPct` and `pyFloatStr`.
- **Sum:** `sum()` of floats is compensated (Neumaier) since Python 3.12. Use `pySum`, or scores can round differently at .5.
- **Word boundaries:** `\b` is Unicode-aware in Python. Use `WB` with the `u` flag.
- **Whitespace split:** `str.split()` with no argument drops empty strings. Use `pySplit`.
- **Dict order:** use `Map`, not plain objects, wherever Python relies on insertion order. JavaScript objects reorder
  integer-like keys.

## Fixed in the Python app along the way (so both engines agree, and the live site is better)

- **Quote crash:** editing the sea freight in the workspace quote crashed it (`dict() got multiple values for keyword
  argument 'sea_freight_usd'`). Fixed and checked through the API.
- **Tie order:** country rankings with tied scores came out in whatever order SQLite grouped the rows. They now come in a
  fixed order (`ORDER BY` on the trade-flow query).
- **Word scores:** the word-overlap score summed a Python set, whose order is randomised per process, so scores could
  change in the last decimal between runs. It now sums in sorted order.
- **Number text:** numbers inside sentences print the same whether stored as int or float ("at ₹88/US$", not "at ₹88.0/US$").
- **Document reader crash:** any text with a word ending in "rs" or "inr" before a comma ("We are leather
  manufacturers, Kanpur") crashed the reader: the price pattern took "rs" as rupees and then an empty amount. Amounts
  must now start with a digit and "Rs"/"INR" must start a word, in the price, quantity, MOQ and capacity patterns.
  Spreadsheet price cells such as "1.2.3" no longer crash either. The crash cases are in the parity corpus.
- **Upload size:** Vercel caps a whole request body at 4.5 MB, but the upload accepted 10 files of 4 MB each. Both apps
  now refuse more than 4 MB in total, with a message that says so. Vercel still rejects a body over 4.5 MB before the
  code runs, so the workspace page must check sizes before sending (phase 8).
- **Test switches:** `UK_SEARCH=off` and `COMTRADE_FETCH=off` turn off the two live lookups (tests, offline work), and
  `EXPORTWALLA_OFFLINE=1` makes the pipeline replay its cache only. Same names in both apps.
- **Upload size in the browser:** the workspace now checks file sizes before sending (4 MB per file and in total, the
  server's own limits and messages), so a large upload gets a clear message instead of the host's 413 error.
- **No-AI classifier read the description over the name:** "Cumin seeds, whole" came out as raw hides and "Cumin
  seeds, machine cleaned" as seed-cleaning machines. The tariff search now anchors on the name's most distinctive word
  that the tariff uses (a line without it drops 15 points), reads plurals of trade words ("chillies"), ignores what the
  merchant negates ("not roasted") and what tariff lines exclude ("excluding … rice"), and treats polished stone as
  worked. The chapter gate matches whole words ("coated" is not a coat) and sends "pumps"/"belts" to machinery when
  machine words are there. On 30 merchant-style products (`tests/fixtures/classify_labelled.json`) 24 are right, up
  from 16; on the 357 site products it is unchanged at 4 digits from the tariff wording and 2 fewer from an everyday
  name plus that wording. `tests/classify.labelled.test.ts` keeps both engines equal and at least 24 right.
- **Reading documents without AI (both engines):** form labels without a colon ("1. Legal Name X", the GST
  certificate's table) and a company-name line when there is no label; the city no longer comes from a directors
  table ("Director, Uttar Pradesh"); a photographed invoice's HS code on its own line takes its description from the
  lines below; a price list's header is found under a title row, the product column is not "Item code", and monthly
  capacity is read; packing lists are called that; a note's product comes from the sentence with the price, without
  Hinglish filler. The six files in `samples/` are in the parity fixtures.
- **Uploads that fit:** the deploy uploads `reference.db.gz` (26 MB) and unpacks it before the build (upload about
  41 MB, under the Hobby limit); the workspace makes photos over 1 MB smaller in the browser before sending.
- **Cited passages cost an AI call each:** with AI on, every document section asked the AI for a full cited answer and
  then used only the two passages under it. Both engines now take the passages from retrieval alone.

## Document reading on Vercel (no OCR tool)

The macOS OCR tool (`../export-desk/tools/ocr`) reads PDFs and photos locally. On a server without it, PDFs fall back
to their text layer: pypdf in Python, unpdf in Node. On the 5 test PDFs both fallbacks find the same company details
and products. The only difference is spacing in the quoted source line (pypdf keeps column gaps, unpdf joins words
with single spaces). Photos without OCR need the AI reader (Claude or Gemini) on both sides.

## How the API runs in Next.js

- **Read-only database, per-request where it matters:** `/api/status`, `/api/verify` and `/api/reviews` call
  `connection()` so they are never prerendered (an operator route prerendered at build would skip the token check).
  `/api/home`, `/openapi.json`, `/docs` and `/.well-known/mcp.json` are prerendered at build: their data ships with
  the deploy.
- **Live calls:** `src/lib/server/hooks.ts` gives the engine the AI (when a key is set) and the UK tariff search.
  `UK_SEARCH=off` switches the search off (tests, offline work).
- **Leads:** webhook (`LEAD_WEBHOOK_URL`) and SMTP through `nodemailer` 10.1.7 (pinned: earlier releases have known
  SMTP injection advisories). In development, a lead that reached neither goes to `data/local.db`, as do review
  verdicts; Python used its development database for both.
- **Headers:** security headers and CORS on `/api/public/*` are in `next.config.ts` (they were in `vercel.json`). The
  Content-Security-Policy comes with the pages in phase 7.
- **OpenAPI:** `src/lib/openapi.json` was generated from the FastAPI app. Edit it by hand when the public endpoints change.

## How the pages run in Next.js

- **Same HTML, not React:** the public pages are the Python site's HTML, rendered by the same string templates ported
  to TypeScript (`src/lib/pages/*`) and served by one route handler (`src/app/[[...path]]/route.ts`). Search engines
  and AI crawlers get byte-identical pages, structured data and `.md` twins. Every page is prerendered at build time
  from `allPaths()`; an unknown path renders the 404 page and an old `.html` URL redirects (308) to the clean one, as
  Vercel's `cleanUrls` did.
- **Content as data:** guides, the Hinglish copy and the site's fixed tables are in `src/content/*.json`; the home,
  workspace and review templates and the tools' page scripts are in `src/templates/`; stylesheets, scripts and brand
  files are in `public/static/`. Until the switch, edit them in the Python app and copy them over with
  `python scripts/export_content.py` (the page parity test fails if the copies drift).
- **Key order:** `products` and `uk_buyers` in the site index are keyed by HS codes, which JavaScript objects reorder;
  `loadIndex()` keeps them as Maps in file order, the order the Python site lists them in.

## How the data pipeline runs in TypeScript

```bash
EXPORTWALLA_DB=/path/new/export_desk.db npm run data -- rebuild-all   # everything, in order, from data/raw (fetches what is missing)
npm run data -- run-all --refresh                                        # re-fetch the leather wedge from source
npm run data -- india-exports | wits | scope-pull | rules-docs          # one step on data/export_desk.db
npm run data -- build-reference && npm run data -- site-index           # reference.db (+ .gz) and seo_index.json
```

- **Same cache, same files:** responses are cached under `data/raw/<source>/` with the same keys and file format as
  the Python pipeline, so either can replay the other's pulls. `EXPORTWALLA_OFFLINE=1` makes a cache miss an error
  instead of a fetch.
- **One engine:** the site index is computed by the same TypeScript engine the API uses (duty, country ranking, deal
  labels), so the duplicate Python copy of that logic goes away with the switch.
- **Official texts:** PDFs go through the same on-device OCR tool as before; web pages go through a port of CPython
  3.15's `HTMLParser` and `html.unescape` (the entity table is exported from Python, `src/pipeline/html5-entities.json`).
- **Trade data on demand:** the app's database connection is a small writable overlay in `EXPORTWALLA_TMP` with
  `reference.db` attached read-only. For a product outside the shipped data, the plan endpoint fetches its Comtrade
  figures into the overlay first (about 20 seconds: Comtrade's free API is paced at 6 seconds a call). The pipeline
  itself reads its build database directly, so fetched rows never leak into a data build. `COMTRADE_FETCH=off` turns
  the fetch off (tests).
- **Site index floats:** Python wrote whole-number floats as `0.0`, TypeScript writes `0`; the parsed values are
  identical, which is what the test compares. The country rules are checked to carry no whole-number floats, the one
  place their text would differ.

## Phase 10: the switch

- **Nothing to switch from:** the Python app was never deployed, so there is no live traffic to shadow. The first
  deploy is the Next.js app.
- **Self-contained:** the data moved to `exportwalla-next/data` (`export-desk/data` is now a link to it, so the Python
  app still runs as the reference for the parity tests); the OCR tool is in `tools/`; content is edited in
  `src/content/*.json` (stop using `export-desk/scripts/export_content.py`).
- **Release checks ported:** `npm run check -- seo | data | matrix | evals | rag | indexnow`, and `npm run release`
  (replaces `scripts/release.sh`). The crawler takes the site's origin from the sitemap, so it never fetches the live
  domain by mistake (the Python one used `SITE_URL` and would).
- **Deploy configuration:** `next.config.ts` bundles `reference.db`, `seo_index.json`, the country rules, the
  verification run and the templates into every server function (about 140 MB) and keeps the raw cache and build
  database out; `.vercelignore` keeps them out of the upload. `prebuild` can fetch `reference.db` from
  `REFERENCE_DB_URL` when it is not uploaded; normally it unpacks the uploaded `reference.db.gz`.
- **Retiring Python, after the first deploy is accepted:** the parity tests (`tests/*.parity.test.ts`,
  `tests/bridge.ts`, `golden/`) need `../export-desk`; keep them as long as both exist, then delete them with the
  Python app. Before deleting `export-desk`, remove the `data` link (the data itself lives here).

## Differences on purpose (API)

- **422 wording:** a missing or wrongly typed field is a 422 on both sides, but the error text is pydantic's in
  Python and shorter in Next. The contract test compares only the status for 422s.
- **MCP tool text:** the JSON inside `content[0].text` is compact in Next (Python's `json.dumps` adds spaces). The data
  is the same, and `structuredContent` is identical.
- **`/docs`:** Swagger UI is pinned to 5.33.3 (FastAPI loaded "@5", whatever is newest) and uses the site's favicon.

## Known quirks kept for parity (fix in both engines after the switch)

- The cited-answer method line says "Claude read all N documents…" even when Gemini answered.

- `us_section301` notes end with a trailing space when there are no extra sentences.
- `documents()` writes "None" (Python) or "null" (TypeScript) in the packing-list marks if a buyer has a `name` key set to
  null. The site never sends that.
