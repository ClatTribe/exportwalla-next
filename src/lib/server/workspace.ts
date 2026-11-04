// The workspace API, stateless: the merchant's profile and plan live in their browser and travel with each request.
// Nothing about a merchant is stored, and uploaded files are read in memory, then dropped. Port of the workspace
// half of export-desk/app/main.py.
import path from "node:path";
import { checkGstin } from "../engine/gstin";
import { extract, merge } from "../engine/intake";
import * as stages from "../engine/stages";
import { LLMError, available } from "../llm";
import { pyFloat, pyStrip } from "../py";
import { liveHooks } from "./hooks";
import { ensureTradeData } from "./tradeData";
import { HttpError, field, isObject, nowIso, objectBody, pyLen } from "./http";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A copy of the profile with defaults filled in, product ids given, and the GSTIN check attached. */
export function withChecks(profileIn: Json | null): Json {
  const profile: Json = Object.fromEntries(Object.entries(profileIn ?? {}).filter(([k]) => k !== "checks"));
  if (!("company" in profile)) profile.company = {};
  if (!("products" in profile)) profile.products = [];
  profile.products.forEach((p: Json, i: number) => { if (!("id" in p)) p.id = `p${i + 1}`; });
  const [ok, message, state] = checkGstin(profile.company.gstin);
  return { ...profile, checks: { gstin: { ok, message, state } } };
}

function cleanProfile(profileIn: Json): Json {
  const profile = withChecks(profileIn);
  delete profile.checks;
  if (!profile.products?.length) throw new HttpError(400, "Add at least one product first.");
  return profile;
}

const focused = (plan: Json) => stages.focus(plan.diagnosis, plan.family ?? null);

async function runDownstream(profile: Json, plan: Json, country: string): Promise<Json> {
  const hooks = liveHooks();
  plan.country = country;
  const fd = focused(plan);
  plan.buyers = await stages.findBuyers(fd, country, profile, 25, hooks);
  plan.quotes = {};
  for (const p of fd.products) {
    const prod = profile.products.find((x: Json) => x.id === p.product_id) ?? {};
    if (p.classification.status === "ok") plan.quotes[p.product_id] = stages.quote(prod, p.classification, country);
  }
  const firstBuyer = (plan.buyers.buyers?.length ? plan.buyers.buyers : [null])[0];
  plan.documents = stages.documents(profile, fd, plan.quotes, firstBuyer, country, hooks);
  plan.selected_buyer = firstBuyer && firstBuyer.trader_id;
  return plan;
}

// ---------------------------------------------------------------- /api/read

const MAX_FILES = 10, MAX_BYTES = 4_000_000, MAX_TOTAL = 4_000_000; // Vercel caps a request body at 4.5 MB
const ALLOWED_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".heic", ".tif", ".tiff", ".xlsx", ".xlsm", ".csv", ".txt"]);

/** Reads uploaded documents and typed text into the export profile, merged into the one sent. */
export async function readDocuments(form: FormData): Promise<Json> {
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
  const text = String(form.get("text") ?? "");
  const profileText = String(form.get("profile") ?? "{}");
  if (files.length > MAX_FILES) throw new HttpError(400, `Up to ${MAX_FILES} files at a time, please.`);
  if (pyLen(text) > 5000) throw new HttpError(400, "Please keep the typed note under 5,000 characters.");
  const got: [string, Buffer][] = [];
  let total = 0;
  for (const f of files) {
    const name = path.basename(f.name || "file");
    if (!ALLOWED_EXT.has(path.extname(name).toLowerCase())) {
      throw new HttpError(400, `${name}: please upload a PDF, photo (JPG, PNG, HEIC), Excel or CSV file.`);
    }
    if (f.size > MAX_BYTES) throw new HttpError(400, `${name} is larger than ${MAX_BYTES / 1_000_000} MB. Try a smaller photo or a PDF.`);
    total += f.size;
    if (f.size) got.push([name, Buffer.from(await f.arrayBuffer())]);
  }
  if (total > MAX_TOTAL) {
    throw new HttpError(400, `Together these files are larger than ${MAX_TOTAL / 1_000_000} MB. Send them in two goes, or use smaller photos.`);
  }
  if (!got.length && !pyStrip(text)) throw new HttpError(400, "Add a file or type a few lines about your products.");
  let extracted: Json;
  try {
    extracted = await extract(got, text);
  } catch (e) {
    if (e instanceof LLMError) throw new HttpError(502, e.message);
    throw e;
  }
  let current: unknown;
  try {
    current = JSON.parse(profileText || "{}");
  } catch {
    current = {};
  }
  const merged = merge(isObject(current) ? current : {}, extracted);
  return { profile: withChecks(merged), extracted, ai: available() };
}

// ---------------------------------------------------------------- /api/check and /api/plan*

export const checkProfile = (body: unknown) => withChecks(objectBody(body));

function planRequest(body: unknown) {
  const b = objectBody(body);
  return {
    profile: field<Json>(b, "profile", "dict"),
    country: field<string | null>(b, "country", "str", { default: null, nullable: true }),
    family: field<string | null>(b, "family", "str", { default: null, nullable: true }),
    plan: field<Json | null>(b, "plan", "dict", { default: null, nullable: true }),
  };
}

export async function buildPlan(body: unknown): Promise<Json> {
  const req = planRequest(body);
  const profile = cleanProfile(req.profile);
  const diag = await stages.diagnose(profile, liveHooks());
  const fams = stages.families(diag);
  const family = fams.some((f) => f.code === req.family) ? req.family : (fams.length ? fams[0].code : null);
  if (family) await ensureTradeData(stages.focus(diag, family)); // products outside the shipped data: fetch first
  const countries = family ? stages.chooseCountry(stages.focus(diag, family)) : { status: "no_products", markets: [] };
  const country = req.country || countries.recommended || "GBR";
  return runDownstream(profile, { diagnosis: diag, countries, families: fams, family, created_at: nowIso() }, country);
}

export async function changeCountry(body: unknown): Promise<Json> {
  const req = planRequest(body);
  if (!req.plan) throw new HttpError(400, "plan missing");
  return runDownstream(cleanProfile(req.profile), req.plan, req.country || "GBR");
}

export function requote(body: unknown): Json {
  const b = objectBody(body);
  const profileIn = field<Json>(b, "profile", "dict"), plan = field<Json>(b, "plan", "dict");
  const productId = field<string>(b, "product_id", "str");
  const qty = field<number | null>(b, "qty", "int", { default: null, nullable: true });
  const overridesIn = field<Json>(b, "overrides", "dict", { default: {} });
  const profile = cleanProfile(profileIn);
  const prod = profile.products.find((x: Json) => x.id === productId);
  const cls = plan.diagnosis.products.find((p: Json) => p.product_id === productId)?.classification;
  if (!prod || !cls) throw new HttpError(404, "product not in this plan");
  const overrides: Json = {};
  for (const [k, v] of Object.entries(overridesIn)) {
    if (v === null || v === "") continue;
    if (typeof v === "number") overrides[k] = v;
    else if (typeof v === "boolean") overrides[k] = Number(v);
    else if (typeof v === "string") {
      try {
        overrides[k] = pyFloat(v);
      } catch {
        throw new HttpError(400, `${k} must be a number`);
      }
    } else throw new HttpError(400, `${k} must be a number`);
  }
  const country = "country" in plan ? plan.country : "GBR";
  const q = stages.quote(prod, cls, country, qty, overrides);
  plan.quotes[productId] = q;
  const buyer = (plan.buyers.buyers ?? []).find((x: Json) => x.trader_id === plan.selected_buyer) ?? null;
  const documents = stages.documents(profile, focused(plan), plan.quotes, buyer, country, liveHooks());
  return { quote: q, documents };
}

export function pickBuyer(body: unknown): Json {
  const b = objectBody(body);
  const profileIn = field<Json>(b, "profile", "dict"), plan = field<Json>(b, "plan", "dict");
  const traderId = field<number>(b, "trader_id", "int");
  const buyer = (plan.buyers.buyers ?? []).find((x: Json) => x.trader_id === traderId) ?? null;
  const documents = stages.documents(cleanProfile(profileIn), focused(plan), plan.quotes, buyer, "country" in plan ? plan.country : "GBR", liveHooks());
  return { documents, selected_buyer: traderId };
}
