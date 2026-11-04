// The AI wrapper against mocked Claude and Gemini responses: provider choice, request shapes, fallbacks, error
// messages, the citation check, and how retrieval and classification use the AI when a key is set.
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as rag from "../src/lib/engine/rag";
import * as st from "../src/lib/engine/stages";
import * as llm from "../src/lib/llm";

const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "LLM_PROVIDER", "GEMINI_MODEL"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
afterEach(() => { KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); llm.setClient(null); vi.unstubAllGlobals(); });

/** A fake SDK client: beta.messages.create and messages.create return queued responses or throw queued errors. */
function fakeClaude(queue: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const next = async (p: Record<string, unknown>) => { calls.push(p); const r = queue.shift(); if (r instanceof Error) throw r; return r; };
  llm.setClient({ beta: { messages: { create: next } }, messages: { create: next } } as unknown as Anthropic);
  return calls;
}
const claudeText = (text: string, extra: Record<string, unknown> = {}) => ({ stop_reason: "end_turn", content: [{ type: "text", text, ...extra }] });

function fakeGemini(replies: { status?: number; text?: string; finish?: string; body?: string }[]) {
  const bodies: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies.shift()!;
    const ok = !r.status || r.status < 300;
    return new Response(ok ? JSON.stringify({ candidates: [{ finishReason: r.finish ?? "STOP", content: { parts: [{ text: r.text ?? "{}" }] } }] }) : (r.body ?? "error"),
      { status: r.status ?? 200 });
  });
  return bodies;
}

describe("provider choice", () => {
  test("no key, one key, both keys, explicit choice", () => {
    expect(llm.provider()).toBe(null);
    expect(llm.available()).toBe(false);
    process.env.GEMINI_API_KEY = "g";
    expect(llm.provider()).toBe("gemini");
    process.env.ANTHROPIC_API_KEY = "a";
    expect(llm.provider()).toBe("anthropic");
    process.env.LLM_PROVIDER = "gemini";
    expect(llm.provider()).toBe("gemini");
    expect(llm.providerName()).toBe("Google's Gemini API");
  });
});

describe("Claude", () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = "test"; });

  test("structured JSON with the fallback beta, and the retry without it", async () => {
    const calls = fakeClaude([claudeText('{"ok": true}'), new Anthropic.BadRequestError(400, {}, "beta not allowed", new Headers()), claudeText('{"ok": 2}')]);
    expect(await llm.askJson("sys", "hi", { type: "object" })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", model: llm.CLAUDE_MODEL,
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } } });
    expect(await llm.askJson("sys", "hi", { type: "object" })).toEqual({ ok: 2 });
    expect(calls[2]).not.toHaveProperty("betas");
  });

  test("refusal, cut-off, bad JSON and a rejected key become LLMError", async () => {
    fakeClaude([{ stop_reason: "refusal", content: [] }, { stop_reason: "max_tokens", content: [] }, claudeText("not json"),
      new Anthropic.AuthenticationError(401, {}, "bad key", new Headers())]);
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("declined");
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("cut off");
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("malformed JSON");
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("cited answer: documents with citations enabled and the last one cached", async () => {
    const calls = fakeClaude([{ stop_reason: "end_turn", content: [
      { type: "text", text: "VAT is 19%. ", citations: [{ document_index: 1, document_title: "", cited_text: "Import VAT: 19%" }] },
      { type: "text", text: "Ask the desk." }] }]);
    const res = await llm.askCited("sys", [{ title: "A", text: "a" }, { title: "Rules", text: "Import VAT: 19%", context: "Source: x" }], "VAT?");
    expect(res).toEqual({ answer: "VAT is 19%. Ask the desk.", citations: [{ title: "Rules", cited_text: "Import VAT: 19%", document_index: 1 }] });
    const blocks = (calls[0].messages as { content: Record<string, unknown>[] }[])[0].content;
    expect(blocks[0]).toMatchObject({ type: "document", citations: { enabled: true }, source: { type: "text", data: "a" } });
    expect(blocks[1]).toHaveProperty("cache_control", { type: "ephemeral" });
    expect(blocks[2]).toEqual({ type: "text", text: "VAT?" });
  });
});

describe("Gemini", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "test"; });

  test("JSON with the schema, images as inline data, retry without the schema on 400", async () => {
    const bodies = fakeGemini([{ text: '```json\n{"ok": true}\n```' }, { status: 400, body: "unknown field responseJsonSchema" }, { text: '{"ok": 3}' }]);
    expect(await llm.askJson("sys", [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], { type: "object" }))
      .toEqual({ ok: true });
    expect(bodies[0].contents[0].parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
    expect(bodies[0].generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object" }, temperature: 0 });
    expect(await llm.askJson("sys", "x", { type: "object" })).toEqual({ ok: 3 });
    expect(bodies[2].generationConfig).not.toHaveProperty("responseJsonSchema");
    expect(bodies[2].contents[0].parts.at(-1).text).toContain("JSON Schema");
  });

  test("quota and key errors read plainly", async () => {
    fakeGemini([{ status: 429 }, { status: 403 }, { finish: "SAFETY" }]);
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("free-tier quota");
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("GEMINI_API_KEY");
    await expect(llm.askJson("s", "x", {})).rejects.toThrow("declined");
  });

  test("cited answer keeps only quotes found word for word in the named document", async () => {
    fakeGemini([{ text: JSON.stringify({ answer: " VAT is 19%. ", citations: [
      { document_index: 0, cited_text: "import  vat: 19%" }, { document_index: 0, cited_text: "made up quote" }, { document_index: 5, cited_text: "x" }] }) }]);
    const res = await llm.askCited("sys", [{ title: "DE rules", text: "Germany. Import VAT: 19% on CIF plus duty." }], "VAT?");
    expect(res).toEqual({ answer: "VAT is 19%.", citations: [{ title: "DE rules", cited_text: "import  vat: 19%", document_index: 0 }] });
  });
});

describe("AI inside retrieval and classification", () => {
  test("rag.answer with a key: cited answer with document URLs; an AI error falls back to passages", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const docs = rag.countryDocuments("DEU");
    fakeClaude([{ stop_reason: "end_turn", content: [{ type: "text", text: "19%.", citations: [{ document_index: 0, document_title: docs[0].title, cited_text: "VAT" }] }] },
      new Anthropic.RateLimitError(429, {}, "slow down", new Headers())]);
    const ok = await rag.answer("import vat", "DEU");
    expect(ok.answer).toBe("19%.");
    expect(ok.citations[0].url).toBe(docs[0].url);
    expect(ok.method).toBe(`Claude read all ${docs.length} documents for DEU (whole texts, API citations)`);
    expect(ok.passages.length).toBeLessThanOrEqual(4);
    const failed = await rag.answer("import vat", "DEU");
    expect(failed.answer_error).toContain("Claude API error");
    expect(failed.passages.length).toBeGreaterThan(0);
  });

  test("classify: the AI's pick is used only if it is one of the candidates", async () => {
    const product = { name: "men's leather chelsea boots with rubber sole" };
    const base = await st.classify(product, { ukSearch: async () => [] });
    const pick = base.candidates[1].code;
    const used = await st.classify(product, { ukSearch: async () => [], llmJson: async () => ({ uk_code: pick, us_code: "", confidence: "high",
      rationale: "GRI 1", alternative_uk_code: "", what_would_change_it: "" }) });
    expect(used.method).toBe("claude");
    expect(used.uk.code).toBe(pick);
    expect(used.confidence).toBe("medium"); // US line chosen by our rules, so not "high"
    const rejected = await st.classify(product, { ukSearch: async () => [], llmJson: async () => ({ uk_code: "9999999999", us_code: "",
      confidence: "high", rationale: "", alternative_uk_code: "", what_would_change_it: "" }) });
    expect(rejected.method).toBe("claude; AI code rejected (not in tariff)");
    expect(rejected.uk.code).toBe(base.uk.code);
  });
});
