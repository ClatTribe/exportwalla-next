import { handle, jsonBody } from "@/lib/server/http";
import { pickBuyer } from "@/lib/server/workspace";

export async function POST(request: Request) {
  return handle(async () => pickBuyer(await jsonBody(request)));
}
