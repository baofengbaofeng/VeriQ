import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 0,
  outputDir: "../../.superpowers/cache/t02/browser-results",
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...(process.env.VERIQ_TEST_CHROMIUM
      ? { launchOptions: { executablePath: process.env.VERIQ_TEST_CHROMIUM } }
      : {}),
  },
  webServer: [
    {
      command:
        "UV_CACHE_DIR=/tmp/veriq-t02-uv uv run --project apps/srv python apps/srv/tests/auth/browser_server.py",
      cwd: "../..",
      url: "http://127.0.0.1:8888/api/v1/setup",
      reuseExistingServer: false,
    },
    {
      command: "pnpm dev --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
