// One Next build for every test that needs a running server (the API contract and the served pages), built once by
// tests/global-setup.ts with these settings. Each test starts its own `next start` on its own port.
import { type ChildProcess, spawn } from "node:child_process";

export const BUILD_ENV: Record<string, string> = {
  EXPORTWALLA_READONLY: "1", SITE_URL: "https://www.exportwalla.com", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", GEMINI_API_KEY: "",
  UK_SEARCH: "off", COMTRADE_FETCH: "off", DESK_PHONE: "+91 00000 00000", DESK_WHATSAPP: "", CONTACT_EMAIL: "", LEGAL_NAME: "", BUSINESS_ADDRESS: "",
  GRIEVANCE_OFFICER: "", GOOGLE_SITE_VERIFICATION: "", BING_SITE_VERIFICATION: "", PRICE_FROM_INR: "12,000", INDEXNOW_KEY: "",
};

/** Starts the built app and waits until it answers. */
export async function startNext(port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, ...BUILD_ENV, ...env }, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/robots.txt`)).ok) return child;
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("next start did not come up");
}
