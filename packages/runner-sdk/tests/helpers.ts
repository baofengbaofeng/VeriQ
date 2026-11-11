import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import type { AssertionV1, StepV1, CatalogElementV1 } from "@veriq/contracts";
import type { CompiledStep } from "../../compiler/src/index.js";
export const a = (patch: Record<string, unknown>): AssertionV1 =>
  ({
    id: "assert",
    severity: "BLOCK",
    expectedSource: "REQ-1",
    ...patch,
  }) as AssertionV1;
export const step = (
  s: StepV1,
  assertions: AssertionV1[] = [],
  after: AssertionV1[] = [],
): CompiledStep => ({
  step: {
    ...s,
    ...(s.action === "apiRequest"
      ? {
          observers: [
            {
              id: "action",
              method: s.method,
              path: s.path,
              window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
            },
          ],
        }
      : {}),
  },
  sourcePath: `/steps/${s.id}`,
  before: [],
  responseAssertions: assertions.map((assertion) => ({
    assertion: assertion as never,
    sourcePath: "/assert",
    parameters: [],
  })),
  after: after.map((assertion) => ({
    assertion: assertion as never,
    sourcePath: "/after",
    parameters: [],
  })),
});
export async function fixture() {
  const hooks = new Map<string, () => Promise<void>>();
  let reads = 0;
  const requests: { method: string; path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += String(c)));
      req.on("end", () => resolve(s));
    });
    requests.push({ method: req.method!, path: req.url!, body });
    await hooks.get(req.url!)?.();
    if (req.url === "/slow-download") {
      res.writeHead(200, {
        "Content-Disposition": 'attachment; filename="slow.txt"',
        "Content-Type": "application/octet-stream",
      });
      res.write("partial".repeat(512));
      return;
    }
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<input data-testid="name"><input data-testid="check" type="checkbox"><select data-testid="select"><option value="a">A</option><option value="b">B</option></select><input data-testid="upload" type="file"><button data-testid="save" onclick="fetch('/save',{method:'POST',body:JSON.stringify({code:document.querySelector('input').value})})">Save</button><button data-testid="disabled" disabled>Disabled</button><div data-testid="text">Ready</div><div data-testid="row" data-record-key="x"><button>Scoped</button></div><div data-testid="duplicate">1</div><div data-testid="duplicate">2</div>`,
      );
    } else if (req.url === "/empty") {
      res.statusCode = 204;
      res.end();
    } else if (req.url === "/text") {
      res.end("plain");
    } else if (req.url === "/same-redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/save");
      res.end();
    } else if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "http://localhost:1/denied");
      res.end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/eventual"
            ? { exists: ++reads >= 3 }
            : req.url === "/missing"
              ? { exists: false }
              : {
                  code: 0,
                  id: "saved-1",
                  nil: null,
                  literal: "{{evil()}}",
                  items: [1, 2],
                },
        ),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: "/tmp/veriq-t06-config",
      XDG_CACHE_HOME: "/tmp/veriq-t06-cache",
    },
  });
  const page = await browser.newPage();
  await page.goto(origin);
  return {
    page,
    origin,
    requests,
    hooks,
    close: async () => {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
    options: {
      page,
      environment: {
        schemaVersion: "1.0" as const,
        baseURL: origin,
        apiBaseURL: origin,
        allowedOrigins: [origin] as [string],
        locale: "en-US",
        timezone: "UTC",
        roles: [] as never,
      },
      catalog: {
        schemaVersion: "1.0" as const,
        elements: [
          "name",
          "check",
          "select",
          "upload",
          "save",
          "disabled",
          "text",
          "duplicate",
          "row",
        ].map((key) => ({
          key,
          locator: { by: "testId" as const, value: key },
        })) as [CatalogElementV1, ...CatalogElementV1[]],
      },
      data: { name: "attempt-1" },
      vars: {},
    },
  };
}
