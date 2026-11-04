import { handle, jsonBody } from "@/lib/server/http";
import { checkProfile } from "@/lib/server/workspace";

export async function POST(request: Request) {
  return handle(async () => checkProfile(await jsonBody(request)));
}
