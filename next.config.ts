import type { NextConfig } from "next";

// Response headers carried over from export-desk/vercel.json. The pages are the same plain HTML as the Python site
// (inline scripts, Google Fonts, Swagger UI from jsDelivr on /docs), so the Content-Security-Policy is unchanged.
const SECURITY = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
];
const CORS = { key: "Access-Control-Allow-Origin", value: "*" };

// What the server functions read at runtime: the shipped database and data index, the country rules, the latest
// verification run, and the page templates (prerendered pages are built ahead; these serve 404s and the API).
const RUNTIME_FILES = ["./data/reference.db", "./data/seo_index.json", "./data/reference/**/*", "./data/verify_matrix.json", "./src/templates/**/*"];
// Build-only data that must never be bundled: the API response cache, the full build database, logs.
const BUILD_ONLY = ["./data/raw/**/*", "./data/export_desk.db*", "./data/*.gz", "./data/*.log", "./data/local.db", "./data/uploads/**/*", "./tools/**/*"];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingIncludes: { "/*": RUNTIME_FILES, "/**/*": RUNTIME_FILES },
  outputFileTracingExcludes: { "/*": BUILD_ONLY, "/**/*": BUILD_ONLY },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY },
      { source: "/(app|review)", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
      { source: "/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=604800" }] },
      { source: "/api/public/:path*", headers: [CORS] },
      { source: "/llms.txt", headers: [CORS] },
      { source: "/llms-full.txt", headers: [CORS] },
    ];
  },
};

export default nextConfig;
