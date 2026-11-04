import { handle, jsonBody } from "@/lib/server/http";
import { requote } from "@/lib/server/workspace";

export async function POST(request: Request) {
  return handle(async () => requote(await jsonBody(request)));
}
