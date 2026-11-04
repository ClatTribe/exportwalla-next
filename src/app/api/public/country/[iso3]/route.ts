import { handle } from "@/lib/server/http";
import { publicCountry } from "@/lib/server/public";

export async function GET(_request: Request, ctx: RouteContext<"/api/public/country/[iso3]">) {
  const { iso3 } = await ctx.params;
  return handle(() => publicCountry(iso3));
}
