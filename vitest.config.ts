import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // an empty overlay (on-demand trade data) for every run, so nothing fetched earlier leaks into a comparison
  test: { env: { EXPORTWALLA_TMP: fs.mkdtempSync(path.join(os.tmpdir(), "ew-test-")), COMTRADE_FETCH: "off" }, environment: "node", testTimeout: 600_000, hookTimeout: 600_000, include: ["tests/**/*.test.ts"], globalSetup: ["tests/global-setup.ts"] },
});
