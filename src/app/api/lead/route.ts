import { handle, jsonBody } from "@/lib/server/http";
import { lead } from "@/lib/server/lead";

export async function POST(request: Request) {
  return handle(async () => lead(await jsonBody(request)));
}
