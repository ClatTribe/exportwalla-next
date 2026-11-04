import { handle, query } from "@/lib/server/http";
import { publicClassify } from "@/lib/server/public";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handle(() => publicClassify(query(url, "q")));
}
