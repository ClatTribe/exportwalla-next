// A thin wrapper around an LLM for JSON-shaped answers and cited answers. Port of export-desk/app/llm.py.
// Two providers: Claude (ANTHROPIC_API_KEY, via the official SDK) or Google Gemini (GEMINI_API_KEY, REST). Set
// LLM_PROVIDER to "anthropic" or "gemini" when both keys are present. With no key, available() is false and callers fall
// back to rule-based logic: on-server text extraction, tariff search for HS codes, retrieved passages instead of a
// written answer, and a form to send the question to the desk.
import Anthropic from "@anthropic-ai/sdk";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
export const GEMINI_MODEL_DEFAULT = "gemini-2.5-flash"; // override with GEMINI_MODEL when Google retires or renames it

export class LLMError extends Error {}

export function provider(): "anthropic" | "gemini" | null {
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const want = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (want === "gemini" && hasGemini) return "gemini";
  if (want === "anthropic" && hasClaude) return "anthropic";
  return hasClaude ? "anthropic" : hasGemini ? "gemini" : null;
}

export const available = () => provider() !== null;

export const providerName = () => ({ anthropic: "Anthropic's Claude API", gemini: "Google's Gemini API" } as Json)[provider() ?? ""] ?? "";

/** The word the Python engine puts in front of "read all N documents": it says "Claude" for either provider. */
export const providerLabel = () => "Claude";

let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic());
/** Tests swap in a fake client. */
export function setClient(c: Anthropic | null) { _client = c; }

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } | { type: "text"; media_type: string; data: string }; [k: string]: unknown };

function claudeError(e: unknown): never {
  if (e instanceof Anthropic.AuthenticationError) throw new LLMError("Claude API key was rejected. Check ANTHROPIC_API_KEY in .env.");
  if (e instanceof Anthropic.RateLimitError) throw new LLMError("Claude API rate limit hit. Try again in a minute.");
  if (e instanceof Anthropic.APIConnectionError) throw new LLMError("Could not reach the Claude API.");
  throw e;
}

/** One request; returns the JSON object matching `schema`. `content` is a string or content blocks. */
export async function askJson(system: string, content: string | Block[], schema: Json, effort = "low", maxTokens = 8000): Promise<Json> {
  const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (provider() === "gemini") return geminiJson(system, blocks, schema, maxTokens);
  const params: Json = {
    model: CLAUDE_MODEL, max_tokens: maxTokens, system,
    messages: [{ role: "user", content: blocks }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  let resp: Json;
  try {
    resp = await client().beta.messages.create({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", ...params } as never);
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError) { // some accounts or platforms reject the fallback beta: retry without it
      try { resp = await client().messages.create(params as never); } catch (e2) { claudeError(e2); }
    } else claudeError(e);
  }
  if (resp!.stop_reason === "refusal") throw new LLMError("The model declined this request.");
  if (resp!.stop_reason === "max_tokens") throw new LLMError("The answer was cut off (max_tokens). Try a smaller file.");
  const text = (resp!.content as Json[]).find((b) => b.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMError("The model returned malformed JSON.");
  }
}

export interface CitedDoc { title: string; text: string; context?: string }
export interface Cited { answer: string; citations: Json[] }

/** Answer from whole documents with citations. The corpus per country is small, so the model reads all of it rather
 * than a few retrieved chunks. Citations and structured outputs are incompatible, so this is a plain request. */
export async function askCited(system: string, documents: CitedDoc[], question: string, effort = "medium", maxTokens = 3000): Promise<Cited> {
  if (provider() === "gemini") return geminiCited(system, documents, question);
  const blocks: Json[] = documents.map((d) => ({
    type: "document", source: { type: "text", media_type: "text/plain", data: d.text },
    title: d.title.slice(0, 500), context: (d.context ?? "").slice(0, 1000), citations: { enabled: true },
  }));
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: "ephemeral" }; // the documents repeat per country
  let resp: Json;
  try {
    resp = await client().messages.create({
      model: CLAUDE_MODEL, max_tokens: maxTokens, system, output_config: { effort },
      messages: [{ role: "user", content: [...blocks, { type: "text", text: question }] }],
    } as never);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new LLMError("Claude API key was rejected. Check ANTHROPIC_API_KEY in .env.");
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.BadRequestError) {
      throw new LLMError(`Claude API error: ${(e as Error).message}`);
    }
    throw e;
  }
  if (resp.stop_reason === "refusal") throw new LLMError("The model declined this request.");
  const answer: string[] = [], cites: Json[] = [];
  for (const b of resp.content as Json[]) {
    if (b.type !== "text") continue;
    answer.push(b.text);
    for (const c of b.citations ?? []) {
      cites.push({ title: c.document_title || documents[c.document_index].title, cited_text: c.cited_text, document_index: c.document_index });
    }
  }
  return { answer: answer.join("").trim(), citations: cites };
}

// ---------------------------------------------------------------- Gemini (REST)

function geminiParts(content: Block[]): Json[] {
  const parts: Json[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ text: b.text });
    else if ((b.type === "image" || b.type === "document") && b.source.type === "base64") {
      parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
    } else if (b.type === "document" && b.source.type === "text") parts.push({ text: b.source.data });
  }
  return parts;
}

async function geminiCall(body: Json): Promise<string> {
  const model = process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  let r: Response;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(110_000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    });
  } catch {
    throw new LLMError("Could not reach the Gemini API.");
  }
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new LLMError("Gemini API key was rejected. Check GEMINI_API_KEY.");
    if (r.status === 429) throw new LLMError("Gemini rate limit or free-tier quota reached. Try again later.");
    throw new LLMError(`Gemini API error ${r.status}: ${detail}`);
  }
  const resp: Json = await r.json();
  const cand = (resp.candidates ?? [{}])[0];
  if (["SAFETY", "PROHIBITED_CONTENT", "RECITATION"].includes(cand.finishReason)) throw new LLMError("The model declined this request.");
  if (cand.finishReason === "MAX_TOKENS") throw new LLMError("The answer was cut off. Try a smaller file.");
  return ((cand.content ?? {}).parts ?? []).map((p: Json) => p.text ?? "").join("");
}

function jsonFrom(text: string): Json {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(t);
  } catch {
    throw new LLMError("The model returned malformed JSON.");
  }
}

async function geminiJson(system: string, content: Block[], schema: Json, maxTokens: number): Promise<Json> {
  const body: Json = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: geminiParts(content) }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: maxTokens, temperature: 0 },
  };
  try {
    return jsonFrom(await geminiCall(body));
  } catch (e) {
    if (!(e instanceof LLMError) || !e.message.includes("400")) throw e;
  }
  // older models reject responseJsonSchema: ask for the schema in words instead
  delete body.generationConfig.responseJsonSchema;
  body.contents[0].parts.push({ text: "Return only JSON matching this JSON Schema:\n" + JSON.stringify(schema) });
  return jsonFrom(await geminiCall(body));
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** Gemini has no citations API: it answers in JSON with quotes, and only quotes found word for word in the named
 * document are kept, so every citation shown is real. */
async function geminiCited(system: string, documents: CitedDoc[], question: string): Promise<Cited> {
  const docs = documents.map((d, i) => `<document index="${i}" title="${d.title.slice(0, 200)}">\n${d.text}\n</document>`).join("\n\n");
  const schema = { type: "object", required: ["answer", "citations"], properties: {
    answer: { type: "string" },
    citations: { type: "array", items: { type: "object", required: ["document_index", "cited_text"],
      properties: { document_index: { type: "integer" }, cited_text: { type: "string" } } } } } };
  const instr = system + "\n\nAnswer only from the documents. For every claim, add a citation: the document index and a short quote " +
    "copied exactly from that document (one sentence or less). If the documents do not answer the question, say so.";
  const out = await geminiJson(instr, [{ type: "text", text: docs }, { type: "text", text: "Question: " + question }], schema, 3000);
  const cites: Json[] = [];
  for (const c of out.citations ?? []) {
    const i = c.document_index;
    if (Number.isInteger(i) && i >= 0 && i < documents.length && c.cited_text && norm(documents[i].text).includes(norm(c.cited_text))) {
      cites.push({ title: documents[i].title, cited_text: c.cited_text, document_index: i });
    }
  }
  return { answer: (out.answer || "").trim(), citations: cites };
}
