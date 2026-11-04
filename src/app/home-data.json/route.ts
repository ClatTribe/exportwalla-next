// The home page's live numbers, as the static build writes them (json.dumps spacing). Prerendered at build.
import { pyJson } from "@/lib/py";
import { home } from "@/lib/server/public";

export function GET() {
  return new Response(pyJson(home(), { ascii: false }), { headers: { "content-type": "application/json" } });
}
