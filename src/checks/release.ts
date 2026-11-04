// Build and check a release, then (optionally) deploy to Vercel. Replaces export-desk/scripts/release.sh.
//
//   SITE_URL=https://www.exportwalla.com npm run release                    build + checks only
//   SITE_URL=https://www.exportwalla.com npm run release -- --deploy preview  ...then a Vercel preview deploy
//   SITE_URL=https://www.exportwalla.com npm run release -- --deploy prod     ...then production (launch blockers apply)
//
// A data refresh comes first, when wanted: npm run data -- run-all --refresh && npm run data -- scope-pull
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const VERCEL_CLI = "vercel@64.7.0"; // pinned: a release at least two weeks old
const PORT = 8041;

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) { console.error(`\n${cmd} ${args.join(" ")} failed (exit ${r.status}).`); process.exit(r.status ?? 1); }
}

const size = (f: string) => (fs.existsSync(f) ? `${Math.round(fs.statSync(f).size / 1e6)} MB` : "missing");

async function main() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env"); // settings from .env; the environment wins
  const args = process.argv.slice(2);
  const target = args.includes("--deploy") ? args[args.indexOf("--deploy") + 1] : null;
  if (target && !["preview", "prod"].includes(target)) throw new Error("--deploy takes preview or prod");
  const site = process.env.SITE_URL;
  if (!site) { console.error("Set SITE_URL to the production origin, e.g. https://www.exportwalla.com"); process.exit(1); }

  console.log("1/6 reference database"); sh("npx", ["tsx", "src/pipeline/cli.ts", "build-reference"]);
  console.log("2/6 public data index"); sh("npx", ["tsx", "src/pipeline/cli.ts", "site-index"]);
  console.log("3/6 build (every page prerendered)"); sh("npx", ["next", "build"], { SITE_URL: site });
  console.log("4/6 local deploy server");
  const server: ChildProcess = spawn("npx", ["next", "start", "-p", String(PORT)], { env: { ...process.env, EXPORTWALLA_READONLY: "1" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/robots.txt`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log("5/6 checks: SEO crawl, data vs record keepers, every country x stage");
    sh("npx", ["tsx", "src/checks/cli.ts", "seo", "--base", `http://127.0.0.1:${PORT}`]);
    sh("npx", ["tsx", "src/checks/cli.ts", "data"]);
    sh("npx", ["tsx", "src/checks/cli.ts", "matrix", "--sample", "8"], { EXPORTWALLA_READONLY: "1" });
  } finally {
    server.kill();
  }
  console.log(`6/6 ready: data/reference.db (${size("data/reference.db")}), data/seo_index.json (${size("data/seo_index.json")})`);
  if (!target) return;
  if (target === "prod") { // launch blockers: what the public site must carry (contact, grievance officer, lead capture)
    const env = process.env;
    const need: Record<string, unknown> = { LEGAL_NAME: env.LEGAL_NAME, CONTACT_EMAIL: env.CONTACT_EMAIL, GRIEVANCE_OFFICER: env.GRIEVANCE_OFFICER,
      "SMTP_HOST/SMTP_USER/SMTP_PASSWORD or LEAD_WEBHOOK_URL": env.LEAD_WEBHOOK_URL || (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD),
      DESK_PHONE: env.DESK_PHONE && !env.DESK_PHONE.startsWith("+91 00000") };
    const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) { console.error(`Not deploying: set ${missing.join(" ")} in .env (and in the Vercel project) first.`); process.exit(1); }
  }
  sh("npx", ["--yes", VERCEL_CLI, "deploy", ...(target === "prod" ? ["--prod"] : [])]);
}

main().catch((e) => { console.error(e); process.exit(1); });
