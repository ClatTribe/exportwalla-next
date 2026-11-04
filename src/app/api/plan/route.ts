import { handle, jsonBody } from "@/lib/server/http";
import { buildPlan } from "@/lib/server/workspace";

export const maxDuration = 60;

export async function POST(request: Request) {
  return handle(async () => buildPlan(await jsonBody(request)));
}
