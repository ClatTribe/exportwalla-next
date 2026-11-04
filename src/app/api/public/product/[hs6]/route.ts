import { handle } from "@/lib/server/http";
import { publicProduct } from "@/lib/server/public";

export async function GET(_request: Request, ctx: RouteContext<"/api/public/product/[hs6]">) {
  const { hs6 } = await ctx.params;
  return handle(() => publicProduct(hs6));
}
