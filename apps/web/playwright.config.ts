import { defineConfig } from "@playwright/test";
const namedSpecs = process.argv.filter((arg) => arg.endsWith(".spec.ts"));
const editorSuite =
  namedSpecs.length === 0 ||
  namedSpecs.some(
    (arg) => arg.includes("case-publish") || arg.includes("ai.spec") || arg.includes("bundles.spec"),
  );
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 0,
  outputDir: "../../.superpowers/cache/t02/browser-results",
  use: {
    actionTimeout: 20_000,
    screenshot: "only-on-failure",
    baseURL: "http://127.0.0.1:5173",
    ...(process.env.VERIQ_TEST_CHROMIUM
      ? { launchOptions: { executablePath: process.env.VERIQ_TEST_CHROMIUM } }
      : {}),
  },
  webServer: [
    {
      command:
        (editorSuite
          ? "node apps/web/tests/prepare-editor-agent.mjs && "
          : "") +
        "UV_CACHE_DIR=/tmp/veriq-t02-uv uv run --project apps/srv python apps/srv/tests/auth/browser_server.py",
      env: editorSuite
        ? {
            VERIQ_TEST_ENGINE_INVENTORY: new URL(
              "../../.superpowers/cache/t11/release/inventory.json",
              import.meta.url,
            ).pathname,
          }
        : {},
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
