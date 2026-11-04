import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { status } from "@/lib/server/public";

export async function GET() {
  await connection(); // AI on or off is decided per request, not at build time
  return handle(status);
}
