import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { verifyMatrix } from "@/lib/server/operator";

export async function GET(request: Request) {
  await connection(); // the operator token is checked per request; never prerender
  return handle(() => verifyMatrix(request));
}
