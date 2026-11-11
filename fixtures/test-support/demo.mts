import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
export async function startDemo() {
  const dir = await mkdtemp(join(tmpdir(), "veriq-demo-"));
  const businessToken = randomBytes(24).toString("hex"),
    fixtureToken = randomBytes(24).toString("hex"),
    maintenanceToken = randomBytes(24).toString("hex");
  const child = spawn(
    fileURLToPath(new URL("../../apps/srv/.venv/bin/python", import.meta.url)),
    [fileURLToPath(new URL("server.py", import.meta.url))],
    {
      env: {
        ...process.env,
        VERIQ_DEMO_DATABASE: join(dir, "demo.sqlite"),
        VERIQ_DEMO_BUSINESS_TOKEN: businessToken,
        VERIQ_DEMO_FIXTURE_TOKEN: fixtureToken,
        VERIQ_DEMO_MAINTENANCE_TOKEN: maintenanceToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const port = await new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (b) => resolve(String(b).trim()));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Demo exited ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  async function post(path: string, body = {}) {
    const r = await fetch(origin + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${maintenanceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw Error("Demo control failed");
    return r.json();
  }
  return {
    origin,
    businessToken,
    fixtureToken,
    waitAccepted: () => post("/test/accepted"),
    release: () => post("/test/release"),
    expire: (namespace: string) => post("/test/expire", { namespace }),
    reconcile: () => post("/maintenance"),
    close: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
