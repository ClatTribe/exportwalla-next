// Every public page, its .md twin and the crawl files (src/lib/pages/router.ts), prerendered at build time. Paths not
// listed by generateStaticParams render on request: a 404 page, or a redirect from an old .html URL.
import { allPaths, render } from "@/lib/pages/router";

export function generateStaticParams() {
  return allPaths().map((p) => ({ path: p === "/" ? [] : p.slice(1).split("/") }));
}

export async function GET(_request: Request, ctx: RouteContext<"/[[...path]]">) {
  const { path } = await ctx.params;
  const r = render("/" + (path ?? []).join("/"));
  return new Response(r.body || null, { status: r.status, headers: { "content-type": r.type, ...r.headers } });
}
