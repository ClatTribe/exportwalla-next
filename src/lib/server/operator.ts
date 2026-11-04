// Operator-only endpoints: the verification grid and human reviews. Locked by OPERATOR_TOKEN; on a deploy with no
// token set they are closed, so nobody can flood the review webhook. Local development without a token stays open.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, readonly } from "../config";
import { rows } from "../db";
import { pyRound } from "../py";
import { HttpError, field, isObject, nowIso, objectBody } from "./http";
import { forward } from "./lead";
import { localDb } from "./local";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function operator(request: Request): void {
  const token = process.env.OPERATOR_TOKEN ?? "";
  if (!token) {
    if (readonly()) throw new HttpError(403, "Operator tools are off: set OPERATOR_TOKEN to use them.");
    return;
  }
  const sent = Buffer.from(request.headers.get("x-operator-token") ?? ""), want = Buffer.from(token);
  if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) throw new HttpError(401, "Operator token required.");
}

export function verifyMatrix(request: Request): Json {
  operator(request);
  const f = path.join(DATA_DIR, "verify_matrix.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { countries: {} };
}

/** A pydantic `X | str | None` field: a JSON object, a string or null. */
function objectOrString(b: Json, name: string): Json | string | null {
  const v = b[name];
  if (v === undefined || v === null || typeof v === "string" || isObject(v)) return v ?? null;
  throw new HttpError(422, [{ type: "dict_type", loc: ["body", name], msg: "Input should be a valid dictionary", input: v }]);
}

export async function addReview(request: Request, body: unknown): Promise<Json> {
  const b = objectBody(body);
  const planId = b.plan_id ?? null;
  if (!(planId === null || typeof planId === "string" || Number.isInteger(planId))) {
    throw new HttpError(422, [{ type: "int_type", loc: ["body", "plan_id"], msg: "Input should be a valid integer", input: planId }]);
  }
  const r = {
    plan_id: planId, feature: field<string>(b, "feature", "str"), item_key: field<string>(b, "item_key", "str"),
    input: objectOrString(b, "input"), output: objectOrString(b, "output"), verdict: field<string>(b, "verdict", "str"),
    correction: field<string>(b, "correction", "str", { default: "" }), note: field<string>(b, "note", "str", { default: "" }),
  };
  operator(request);
  if (!["correct", "wrong", "unsure"].includes(r.verdict)) throw new HttpError(400, "verdict must be correct, wrong or unsure");
  if (readonly()) { // production: reviews go to the operator's webhook; the golden set is rebuilt from them offline
    const ok = await forward("REVIEW_WEBHOOK_URL", { ...r, created_at: nowIso() }, `Review ${r.verdict}: ${r.feature} ${r.item_key}`);
    return { ok };
  }
  localDb().prepare(`INSERT INTO review (created_at, plan_id, feature, item_key, input, output, verdict, correction, note)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(nowIso(), r.plan_id, r.feature, r.item_key, JSON.stringify(r.input), JSON.stringify(r.output),
    r.verdict, r.correction, r.note);
  return { ok: true };
}

export function listReviews(request: Request): Json {
  operator(request);
  const itemsSql = "SELECT * FROM review ORDER BY id DESC LIMIT 500";
  const statsSql = `SELECT feature, COUNT(*) n, SUM(verdict='correct') correct, SUM(verdict='wrong') wrong,
    SUM(verdict='unsure') unsure FROM review GROUP BY feature ORDER BY feature`;
  const read = <T>(sql: string): T[] => (readonly() ? rows<T>(sql) : localDb().prepare(sql).all() as T[]);
  const items = read<Json>(itemsSql), stats = read<Json>(statsSql);
  for (const s of stats) {
    const judged = (s.correct || 0) + (s.wrong || 0);
    s.accuracy = judged ? pyRound(100 * (s.correct || 0) / judged) : null;
  }
  return { stats, items };
}
