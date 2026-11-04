import { handle, jsonBody } from "@/lib/server/http";
import { changeCountry } from "@/lib/server/workspace";

export const maxDuration = 60;

export async function POST(request: Request) {
  return handle(async () => changeCountry(await jsonBody(request)));
}
