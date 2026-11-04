// Release checks and evaluations from the command line (replaces export-desk/evals/*):
//
//   npm run check -- seo [--base http://localhost:3000] [--sample N]   crawl every sitemap URL
//   npm run check -- data [--n 20]                                      stored data vs the live record keepers
//   npm run check -- matrix [--sample 8 | --live-all | --no-live] [--countries GBR,ARE]   every country x stage
//   npm run check -- evals                                              replay your workspace reviews
//   npm run check -- rag                                                chunking and retrieval ablation
//   npm run check -- indexnow                                           submit the sitemap to IndexNow (after a release)
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  let code = 0;
  switch (cmd) {
    case "seo": code = await (await import("./seo")).seoCheck(opt("--base"), Number(opt("--sample") ?? 0)); break;
    case "data": code = await (await import("./data")).checkData(Number(opt("--n") ?? 20)); break;
    case "matrix": code = await (await import("./matrix")).verifyMatrix({ liveAll: args.includes("--live-all"), noLive: args.includes("--no-live"),
      sample: Number(opt("--sample") ?? 8), countries: opt("--countries") }); break;
    case "evals": code = await (await import("./evals")).runEvals(); break;
    case "rag": code = await (await import("./ragEval")).ragEval(); break;
    case "indexnow": code = await (await import("./indexnow")).indexNow(); break;
    default:
      console.log("usage: npm run check -- seo | data | matrix | evals | rag | indexnow");
      code = 2;
  }
  process.exitCode = code;
}

main().catch((e) => { console.error(e); process.exit(1); });
