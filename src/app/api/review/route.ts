import { handle, jsonBody } from "@/lib/server/http";
import { addReview } from "@/lib/server/operator";

export async function POST(request: Request) {
  return handle(async () => addReview(request, await jsonBody(request)));
}
