import { handle, query } from "@/lib/server/http";
import { ask } from "@/lib/server/public";

export const maxDuration = 60; // the AI reads every official text for the country

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handle(() => ask(query(url, "q"), url.searchParams.get("country")));
}
