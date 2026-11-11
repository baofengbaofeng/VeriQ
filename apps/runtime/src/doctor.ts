/** Real diagnostics; reported capabilities are never a trust attestation. */
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { chromium } from "@playwright/test";
import { controlOrigin } from "./enrollment.ts";
import type { Capabilities } from "./enrollment.ts";

export interface DoctorResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  capabilities?: Capabilities;
}
export async function doctor(
  options: {
    server?: string | undefined;
    executablePath?: string | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = [];
  const check = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });
  check("Node", process.versions.node === "24.22.1", process.versions.node);
  check(
    "OS / architecture",
    ["linux", "win32"].includes(platform()) && arch() === "x64",
    `${platform()} / ${arch()}`,
  );
  const require = createRequire(import.meta.url);
  let engineVersion = "";
  for (const name of ["@veriq/compiler", "@veriq/runner-sdk"])
    try {
      const entry = require.resolve(name);
      const manifest = JSON.parse(
        await readFile(resolve(dirname(entry), "../package.json"), "utf8"),
      ) as { version: string };
      check(name, manifest.version === "0.1.0", manifest.version);
      engineVersion = manifest.version;
    } catch {
      check(name, false, "Package unavailable");
    }
  const executablePath = options.executablePath ?? chromium.executablePath();
  try {
    await access(executablePath, constants.X_OK);
    check("browser executable", true, "Chromium executable found");
  } catch {
    check("browser executable", false, "Chromium executable unavailable");
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    if (options.signal?.aborted) throw new Error();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 10_000,
    });
    const cancel = () => {
      void browser?.close();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<title>VeriQ doctor</title>", { timeout: 5_000 });
      check(
        "browser launch",
        (await page.title()) === "VeriQ doctor",
        "Chromium launched and rendered a page",
      );
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  } catch {
    check(
      "browser launch",
      false,
      options.signal?.aborted ? "Cancelled" : "Chromium launch/render failed",
    );
  } finally {
    await browser?.close();
  }
  if (options.server) {
    try {
      const origin = controlOrigin(options.server);
      const response = await fetch(origin + "/api/v1/health/live", {
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(5_000),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
      await response.body?.cancel();
      check(
        "control network",
        response.ok,
        response.ok ? "Control endpoint reachable" : `HTTP ${response.status}`,
      );
    } catch {
      check(
        "control network",
        false,
        "Control endpoint unreachable or invalid",
      );
    }
  }
  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    ...(ok
      ? {
          capabilities: {
            engineVersion,
            os: platform() as "linux" | "win32",
            arch: "x64" as const,
            browsers: ["chromium" as const],
            jobKinds: [
              "TEST" as const,
              "VALIDATE" as const,
              "CLEANUP" as const,
            ],
          },
        }
      : {}),
  };
}
