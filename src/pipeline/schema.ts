// SQLite schema of the full data build (data/export_desk.db) and of the /tmp overlay for on-demand fetches.
// Copied verbatim from export-desk/db.py.
export const SCHEMA = `
-- Reference data (filled by ingest/)
CREATE TABLE IF NOT EXISTS ingest_runs (
    id INTEGER PRIMARY KEY, source TEXT, started_at TEXT, finished_at TEXT,
    rows INTEGER, status TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS hs6 (
    code TEXT PRIMARY KEY, hs4 TEXT, description TEXT, unit TEXT
);
CREATE TABLE IF NOT EXISTS countries (
    m49 INTEGER PRIMARY KEY, iso3 TEXT, iso2 TEXT, name TEXT, is_group INTEGER
);
CREATE TABLE IF NOT EXISTS uk_commodity (
    code TEXT PRIMARY KEY,           -- 10-digit UK commodity code
    hs6 TEXT, cn8 TEXT, description TEXT, path TEXT,
    mfn_rate TEXT, mfn_pct REAL,     -- third-country duty
    india_rate TEXT, india_pct REAL, -- CETA tariff preference for India (NULL if none)
    supplementary_unit TEXT, fetched_at TEXT, run_id INTEGER
);
CREATE TABLE IF NOT EXISTS us_hts (
    code TEXT PRIMARY KEY,           -- HTS number as printed, e.g. 6403.99.60.75
    hs6 TEXT, indent INTEGER, description TEXT, path TEXT,
    general_rate TEXT, general_pct REAL, special TEXT, is_leaf INTEGER,
    fetched_at TEXT, run_id INTEGER
);
CREATE TABLE IF NOT EXISTS trade_flow (
    year INTEGER, hs6 TEXT, reporter_m49 INTEGER, partner_m49 INTEGER, flow TEXT,
    value_usd REAL, qty REAL, qty_unit TEXT, run_id INTEGER,
    PRIMARY KEY (year, hs6, reporter_m49, partner_m49, flow)
);
CREATE TABLE IF NOT EXISTS uk_trader (
    trader_id INTEGER PRIMARY KEY, name TEXT, address TEXT, postcode TEXT
);
CREATE TABLE IF NOT EXISTS uk_trader_commodity (
    trader_id INTEGER, cn8 TEXT, year INTEGER, import_months TEXT, export_months TEXT,
    run_id INTEGER, PRIMARY KEY (trader_id, cn8, year)
);

CREATE TABLE IF NOT EXISTS india_export (
    year INTEGER, partner_m49 INTEGER, hs TEXT, level TEXT, value_usd REAL, run_id INTEGER,
    PRIMARY KEY (year, partner_m49, hs)
);
CREATE TABLE IF NOT EXISTS tariff_hs6 (           -- WITS/TRAINS HS6 averages of national lines
    reporter TEXT, hs6 TEXT, partner TEXT, year INTEGER, tariff_type TEXT,
    avg_pct REAL, min_pct REAL, max_pct REAL, lines INTEGER, pref_lines INTEGER, nomen TEXT,
    run_id INTEGER, PRIMARY KEY (reporter, hs6, partner)
);
CREATE TABLE IF NOT EXISTS rag_doc (
    id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, country TEXT, agreement TEXT, kind TEXT,
    fetched_at TEXT, chars INTEGER, run_id INTEGER
);
CREATE TABLE IF NOT EXISTS rag_chunk (
    id INTEGER PRIMARY KEY, doc_id INTEGER, ord INTEGER, heading TEXT, context TEXT, text TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
    context, text, content='rag_chunk', content_rowid='id', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS tree_fts USING fts5(
    code UNINDEXED, context, text, tokenize='porter unicode61'
);

-- Merchant workspace
CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY, created_at TEXT, data TEXT        -- JSON export profile
);
CREATE TABLE IF NOT EXISTS upload (
    id INTEGER PRIMARY KEY, profile_id INTEGER, filename TEXT, path TEXT,
    mime TEXT, extracted TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS plan (
    id INTEGER PRIMARY KEY, profile_id INTEGER, created_at TEXT, data TEXT  -- JSON stage outputs
);

-- Verification: every reviewed output becomes a golden case
CREATE TABLE IF NOT EXISTS review (
    id INTEGER PRIMARY KEY, created_at TEXT, plan_id INTEGER, feature TEXT,
    item_key TEXT, input TEXT, output TEXT, verdict TEXT, correction TEXT, note TEXT
);
`;

export const OVERLAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ov.trade_flow (
    year INTEGER, hs6 TEXT, reporter_m49 INTEGER, partner_m49 INTEGER, flow TEXT,
    value_usd REAL, qty REAL, qty_unit TEXT, run_id INTEGER,
    PRIMARY KEY (year, hs6, reporter_m49, partner_m49, flow)
);
CREATE TABLE IF NOT EXISTS ov.ingest_runs (
    id INTEGER PRIMARY KEY, source TEXT, started_at TEXT, finished_at TEXT, rows INTEGER, status TEXT, note TEXT
);
`;
