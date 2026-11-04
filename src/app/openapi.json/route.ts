// The public API's OpenAPI document. Generated once from the FastAPI app; edit it with the public endpoints.
import spec from "@/lib/openapi.json";

export function GET() {
  return Response.json(spec);
}
