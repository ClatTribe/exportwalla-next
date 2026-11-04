import { pyJson } from "@/lib/py";
import { MCP_TOOLS } from "@/lib/server/mcp";
import { mcpCard } from "@/lib/site";

export function GET() {
  return new Response(pyJson(mcpCard(MCP_TOOLS), { ascii: false, indent: 1 }),
    { headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
