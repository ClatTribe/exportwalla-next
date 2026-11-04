// MCP server (streamable HTTP, JSON responses): the public API as tools for AI agents. Port of /mcp in
// export-desk/app/main.py.
import { apiCountry, apiProduct } from "../site";
import { HttpError } from "./http";
import { publicClassify, publicDuty } from "./public";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MCP_TOOLS = [
  { name: "lookup_duty", description: "Import duty an Indian product pays in a country, vs the normal rate, with the official source.",
    inputSchema: { type: "object", properties: { hs6: { type: "string", description: "6-digit HS code" },
      country: { type: "string", description: "ISO3 country code, e.g. GBR, ARE, USA" } }, required: ["hs6", "country"] } },
  { name: "best_markets", description: "Countries ranked for exporting this HS6 product from India (demand, growth, India's share, duty).",
    inputSchema: { type: "object", properties: { hs6: { type: "string" } }, required: ["hs6"] } },
  { name: "country_rules", description: "Trade agreement with India, certificate of origin, import VAT and notes for a country.",
    inputSchema: { type: "object", properties: { country: { type: "string" } }, required: ["country"] } },
  { name: "classify_product", description: "HS code candidates for a product description (a search, not a ruling).",
    inputSchema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
];

/** Python's str() of a JSON argument, as the tools receive it ("None" for null, "True" for true). */
function pyArg(v: unknown, fallback = ""): string {
  if (v === undefined) return fallback;
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export async function mcp(msg: unknown): Promise<Response> {
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null || !("id" in msg)) {
    return new Response(null, { status: 202 }); // notifications (and batches, unsupported) need no body
  }
  const m = msg as Json;
  const id = m.id, method = m.method, params: Json = m.params || {};
  const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    return ok({ protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "exportwalla", version: "1.0" },
      instructions: "Duty, trade rules and HS codes for exporting from India. Data from official tariffs." });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: MCP_TOOLS });
  if (method === "tools/call") {
    const a: Json = params.arguments || {};
    try {
      const name = params.name;
      let data: Json | null;
      if (name === "lookup_duty") data = publicDuty(pyArg(a.hs6), pyArg(a.country));
      else if (name === "best_markets") {
        const p = apiProduct(pyArg(a.hs6));
        data = p && { hs6: p.hs6, name: p.name, markets: p.markets.slice(0, 10), page: p.page };
      } else if (name === "country_rules") data = apiCountry(pyArg(a.country));
      else if (name === "classify_product") data = await publicClassify(pyArg(a.description));
      else return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
      if (data === null) throw new HttpError(404, "not covered");
      return ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
    } catch (e) {
      if (e instanceof HttpError) return ok({ content: [{ type: "text", text: String(e.detail) }], isError: true });
      throw e;
    }
  }
  return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}
