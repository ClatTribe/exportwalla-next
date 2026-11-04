import { handle, query } from "@/lib/server/http";
import { publicDuty } from "@/lib/server/public";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handle(() => publicDuty(query(url, "hs6"), query(url, "country")));
}
