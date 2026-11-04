// Settings and data locations. The data lives in ./data (the Python app's export-desk/data links here during the
// migration); EXPORTWALLA_DATA points elsewhere. Defaults match export-desk/config.py.
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.EXPORTWALLA_DATA ?? path.resolve(process.cwd(), "data");
export const REFERENCE_DB = process.env.EXPORTWALLA_DB ?? path.join(DATA_DIR, "reference.db");
export const REFERENCE_DIR = path.join(DATA_DIR, "reference");

/** On Vercel (or when asked) nothing is written to the data folder: leads and reviews go to email and webhooks. */
export const readonly = () => process.env.VERCEL === "1" || process.env.EXPORTWALLA_READONLY === "1";
export const TMP_DIR = process.env.EXPORTWALLA_TMP ?? path.join(os.tmpdir(), "exportwalla");
/** Writable database for local development only: leads that found no email or webhook, and review verdicts. */
export const LOCAL_DB = process.env.EXPORTWALLA_LOCAL_DB ?? path.join(DATA_DIR, "local.db");

export const BRAND = "Exportwalla";
export const deskPhone = () => process.env.DESK_PHONE ?? "+91 00000 00000";
export const contactEmail = () => process.env.CONTACT_EMAIL ?? "";
/** Public origin used in canonical URLs, API links and the MCP card. Set SITE_URL in production. */
export const siteUrl = () => (process.env.SITE_URL ?? "http://localhost:8040").replace(/\/+$/, "");

/** Leather and footwear headings the app started with; always in scope (export-desk/config.py SCOPE_HS4). */
export const SCOPE_HS4 = ["4104", "4105", "4106", "4107", "4112", "4113", "4114", "4115",
  "4201", "4202", "4203", "4205", "6401", "6402", "6403", "6404", "6405", "6406"];
