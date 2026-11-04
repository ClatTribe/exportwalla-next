import { handle } from "@/lib/server/http";
import { readDocuments } from "@/lib/server/workspace";

export const maxDuration = 60; // the AI reads every page of every file

export async function POST(request: Request) {
  return handle(async () => readDocuments(await request.formData().catch(() => new FormData())));
}
