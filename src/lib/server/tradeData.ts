// Trade data on demand: a product outside the shipped scope has no import figures, so the plan fetches them from UN
// Comtrade (both years, from the world and from India, for every destination we cover) into this instance's overlay
// before ranking countries. Port of the fetch_missing branch of export-desk/app/stages.py choose_country.
// COMTRADE_FETCH=off switches it off (tests, offline work).
import { rows } from "../db";
import { destinations } from "../engine/stages";
import { uniq } from "../py";
import { appConn } from "../../pipeline/core";
import { comtradeScope } from "../../pipeline/ingest";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function ensureTradeData(diag: Json): Promise<void> {
  if (process.env.COMTRADE_FETCH === "off") return;
  const hs6s = uniq<string>(diag.products.map((p: Json) => p.classification).filter((c: Json) => c.status === "ok").map((c: Json) => c.hs6)).sort();
  if (!hs6s.length) return;
  const have = new Set(rows<{ hs6: string }>(`SELECT DISTINCT hs6 FROM trade_flow WHERE hs6 IN (${hs6s.map(() => "?").join(",")}) AND partner_m49=0`, ...hs6s).map((r) => r.hs6));
  const missing = hs6s.filter((h) => !have.has(h));
  if (!missing.length) return;
  const conn = appConn();
  try {
    await comtradeScope(conn, missing, [...new Set(destinations())].sort());
    conn.commit();
  } catch (e) {
    conn.commit();
    console.log("on-demand Comtrade fetch failed:", e);
  }
}
