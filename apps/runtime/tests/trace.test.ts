import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { EvidencePolicy } from "@veriq/runner-sdk";

test(
  "actual local Trace viewer retains restricted credential evidence and displays the trace",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp("/tmp/veriq-trace-");
    const secret = "synthetic-trace-secret";
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Set-Cookie", `session=${secret}`);
      res.end('<input aria-label="Password"><p>Trace target</p>');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const browser = await chromium.launch({
      executablePath: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const context = await browser.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
      });
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}`);
      await page.getByLabel("Password").fill(secret);
      const policy = new EvidencePolicy();
      policy.protect(secret);
      const screenshot = await policy.screenshot(page, root);
      assert.equal(screenshot.sensitivity, "CREDENTIAL_RESTRICTED");
      assert.ok((await readFile(screenshot.path)).length > 100);
      const trace = await policy.stopTrace(context, root);
      await context.close();
      const unzip = spawn("unzip", ["-p", trace.path]);
      let archive = "";
      unzip.stdout.on("data", (b) => (archive += b));
      await once(unzip, "close");
      assert.ok(
        archive.includes(secret),
        "Raw Trace demonstrably retains the synthetic secret",
      );
      assert.ok(
        archive.includes("Authorization") && archive.includes("session="),
      );
      assert.equal(
        JSON.stringify(
          policy.redact({
            password: secret,
            headers: {
              Authorization: `Bearer ${secret}`,
              Cookie: `session=${secret}`,
            },
          }),
        ).includes(secret),
        false,
      );
      child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "trace", "open", trace.path],
        {
          cwd: process.cwd(),
          env: { ...process.env, CI: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let errors = "";
      child.stderr!.on("data", (b) => (errors += b));
      const url = await new Promise<string>((resolve, reject) => {
        child!.stdout!.on("data", (b) => {
          output += b;
          const match = output.match(
            /Listening on (http:\/\/127\.0\.0\.1:[^\s]+)/,
          );
          if (match) resolve(match[1]!);
        });
        child!.once("exit", (code) =>
          reject(new Error(`Trace CLI exited ${code}: ${errors}`)),
        );
      });
      const viewer = await browser.newPage();
      await viewer.goto(url);
      await viewer.waitForFunction(() =>
        document.body.innerText.toLowerCase().includes("fill"),
      );
      assert.ok(
        (await viewer.locator("body").innerText())
          .toLowerCase()
          .includes("fill"),
      );
      assert.equal(new URL(viewer.url()).hostname, "127.0.0.1");
    } finally {
      child?.kill("SIGTERM");
      if (child && child.exitCode === null) await once(child, "exit");
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
