import { handle, jsonBody } from "@/lib/server/http";
import { mcp } from "@/lib/server/mcp";

export const maxDuration = 60;

export async function POST(request: Request) {
  return handle(async () => mcp(await jsonBody(request)));
}
