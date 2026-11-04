// Builds the Next app once before the tests that serve it (SKIP_BUILD=1 reuses the last build).
import { execFileSync } from "node:child_process";
import { BUILD_ENV } from "./next";

export default function setup() {
  if (!process.env.SKIP_BUILD) execFileSync("npx", ["next", "build"], { env: { ...process.env, ...BUILD_ENV }, stdio: "ignore" });
}
