// Request and response plumbing shared by the route handlers, shaped like the FastAPI app they replace: errors come
// back as {"detail": ...} with the same status codes, and request bodies are checked the way pydantic's lax mode
// checks them (a missing or wrongly typed field is a 422).
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

/** Runs a handler body: a plain value becomes JSON, an HttpError becomes {"detail"}, anything else a bare 500. */
export async function handle(fn: () => unknown, headers?: HeadersInit): Promise<Response> {
  try {
    const out = await fn();
    return out instanceof Response ? out : Response.json(out, { headers });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ detail: e.detail }, { status: e.status, headers });
    console.error(e);
    return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

const invalid = (loc: (string | number)[], type: string, msg: string, input?: unknown) =>
  new HttpError(422, [{ type, loc, msg, ...(input === undefined ? {} : { input }) }]);

/** The JSON body of a request; invalid JSON is a 422, as in FastAPI. */
export async function jsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(["body", 0], "json_invalid", "JSON decode error");
  }
}

export const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body must be a JSON object (a pydantic model or a `dict` parameter). */
export function objectBody(body: unknown): Json {
  if (!isObject(body)) throw invalid(["body"], "model_attributes_type", "Input should be a valid dictionary or object to extract fields from", body);
  return body;
}

type Kind = "str" | "int" | "bool" | "dict";
const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]), FALSE = new Set(["0", "off", "f", "false", "n", "no"]);

function coerce(v: unknown, kind: Kind, loc: (string | number)[]): unknown {
  switch (kind) {
    case "str":
      if (typeof v === "string") return v;
      throw invalid(loc, "string_type", "Input should be a valid string", v);
    case "dict":
      if (isObject(v)) return v;
      throw invalid(loc, "dict_type", "Input should be a valid dictionary", v);
    case "int":
      if (typeof v === "number" && Number.isInteger(v)) return v;
      if (typeof v === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(v)) return Number(v.replaceAll("_", ""));
      throw invalid(loc, "int_parsing", "Input should be a valid integer", v);
    case "bool":
      if (typeof v === "boolean") return v;
      if (v === 0 || v === 1) return v === 1;
      if (typeof v === "string" && TRUE.has(v.toLowerCase())) return true;
      if (typeof v === "string" && FALSE.has(v.toLowerCase())) return false;
      throw invalid(loc, "bool_parsing", "Input should be a valid boolean", v);
  }
}

/** A field of a JSON body. Without a default it is required; `nullable` lets null through (`X | None`). */
export function field<T = unknown>(body: Json, name: string, kind: Kind, opts: { default?: T; nullable?: boolean } = {}): T {
  if (!(name in body) || body[name] === undefined) {
    if ("default" in opts) return opts.default as T;
    throw invalid(["body", name], "missing", "Field required", body);
  }
  const v = body[name];
  if (v === null && opts.nullable) return null as T;
  return coerce(v, kind, ["body", name]) as T;
}

/** A required query parameter (missing is a 422, as for `q: str` in FastAPI). */
export function query(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (v === null) throw invalid(["query", name], "missing", "Field required", null);
  return v;
}

export { pyLen } from "../py";

/** ingest.common.now(): UTC to the second, "+00:00" offset. */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
