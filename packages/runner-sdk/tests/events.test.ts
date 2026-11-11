import { beforeAll, afterAll, afterEach, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepContext, executeStep } from "../src/index.js";
import { fixture, step, a } from "./helpers.js";
let f: Awaited<ReturnType<typeof fixture>>, dir: string;
beforeAll(async () => {
  f = await fixture();
  dir = await mkdtemp(join(tmpdir(), "veriq-evidence-"));
  await f.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<button data-testid="prompt" onclick="document.querySelector('[data-testid=text]').textContent=prompt('Name?')">Prompt</button><button data-testid="popup" onclick="window.open('/','_blank')">Popup</button><a data-testid="download" download="../../untrusted.txt" href="/text">Download</a>`,
    );
  });
  f.options.catalog.elements.push(
    ...["prompt", "popup", "download"].map((key) => ({
      key,
      locator: { by: "testId" as const, value: key },
    })),
  );
});
afterEach(async () => {
  for (const page of f.page.context().pages())
    if (page !== f.page) await page.close();
  await f.page.bringToFront();
});
afterAll(async () => {
  await f.close();
  await rm(dir, { recursive: true, force: true });
});
it("prearms and answers an expected prompt; mismatched dialog is dismissed without hanging", async () => {
  for (const [message, expected] of [
    ["Name?", "PASSED"],
    ["Wrong", "FAILED"],
  ]) {
    const ctx = createStepContext(f.options);
    const r = await executeStep(
      step({
        id: "prompt",
        action: "click",
        target: "prompt",
        observers: [
          {
            id: "ask",
            kind: "dialog",
            dialogType: "prompt",
            message: message!,
            handling: "accept",
            promptText: "A",
          },
        ],
      }),
      ctx,
    );
    expect(r.status).toBe(expected);
    expect(ctx.registry.activeCount()).toBe(0);
    ctx.dispose();
  }
});
it("fails and dismisses an unexpected dialog", async () => {
  const ctx = createStepContext(f.options);
  expect(
    (
      await executeStep(
        step({ id: "prompt", action: "click", target: "prompt" }),
        ctx,
      )
    ).errorCode,
  ).toBe("UNEXPECTED_DIALOG");
  ctx.dispose();
});
it("captures popup into explicit pageKey without changing original page", async () => {
  const ctx = createStepContext(f.options);
  const r = await executeStep(
    step({
      id: "popup",
      action: "click",
      target: "popup",
      observers: [{ id: "opened", kind: "newPage", pageKey: "detail" }],
    }),
    ctx,
  );
  expect(r.status).toBe("PASSED");
  const p = step(
    {
      id: "fill",
      action: "fill",
      target: "name",
      value: "popup-only",
      pageKey: "detail",
    },
    [],
    [
      a({
        type: "ui",
        target: "name",
        operator: "valueEquals",
        expected: "popup-only",
        pageKey: "detail",
      }),
    ],
  );
  expect((await executeStep(p, ctx)).status).toBe("PASSED");
  expect(await f.page.getByTestId("name").inputValue()).toBe("");
  ctx.dispose();
});
it("stores a bounded download under an engine-generated filename and cleans oversized output", async () => {
  const ctx = createStepContext({
    ...f.options,
    downloads: { directory: dir, maxBytes: 64 },
  });
  const p = step({
    id: "download",
    action: "click",
    target: "download",
    observers: [{ id: "file", kind: "download" }],
  });
  const r = await executeStep(p, ctx);
  expect(r.status).toBe("PASSED");
  expect(r.events[0]?.kind).toBe("download");
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9-]+\.bin$/);
  expect(await readFile(join(dir, files[0]!), "utf8")).toBe("plain");
  ctx.dispose();
  const failed = createStepContext({
    ...f.options,
    downloads: { directory: dir, maxBytes: 1 },
  });
  expect((await executeStep(p, failed)).errorCode).toBe("DOWNLOAD_SIZE_LIMIT");
  expect(await readdir(dir)).toEqual(files);
  failed.dispose();
});
it("fails clearly when download storage is unavailable", async () => {
  const ctx = createStepContext(f.options);
  const r = await executeStep(
    step({
      id: "download",
      action: "click",
      target: "download",
      observers: [{ id: "file", kind: "download" }],
    }),
    ctx,
  );
  expect(r.errorCode).toBe("DOWNLOAD_PROVIDER_REQUIRED");
  ctx.dispose();
});
it("makes wrapper popup available to children and keeps omitted pageKey on the original page", async () => {
  const ctx = createStepContext(f.options);
  const wrapper = step({
    id: "flow",
    action: "callFlow",
    versionId: "00000000-0000-4000-8000-000000000003",
    observers: [{ id: "opened", kind: "newPage", pageKey: "wrapper" }],
  });
  wrapper.children = [
    step({ id: "open", action: "click", target: "popup" }),
    step(
      {
        id: "fill",
        action: "fill",
        target: "name",
        pageKey: "wrapper",
        value: "wrapper-value",
      },
      [],
      [
        a({
          type: "ui",
          target: "name",
          operator: "valueEquals",
          expected: "",
        }),
      ],
    ),
  ];
  const r = await executeStep(wrapper, ctx);
  expect(r.status).toBe("PASSED");
  expect(ctx.pages.has("wrapper")).toBe(true);
  expect(
    await (await ctx.pages.get("wrapper")!).getByTestId("name").inputValue(),
  ).toBe("wrapper-value");
  expect(await ctx.page.getByTestId("name").inputValue()).toBe("");
  ctx.dispose();
});
it("flow-local popup keys do not leak to the caller", async () => {
  const ctx = createStepContext(f.options);
  const wrapper = step({
    id: "flow",
    action: "callFlow",
    versionId: "00000000-0000-4000-8000-000000000003",
  });
  wrapper.children = [
    step({
      id: "open",
      action: "click",
      target: "popup",
      observers: [{ id: "opened", kind: "newPage", pageKey: "local" }],
    }),
    step({
      id: "fill",
      action: "fill",
      target: "name",
      pageKey: "local",
      value: "local-value",
    }),
  ];
  expect((await executeStep(wrapper, ctx)).status).toBe("PASSED");
  expect(ctx.pages.has("local")).toBe(false);
  ctx.dispose();
});
it("a missing wrapper popup fails waiting children at its observer deadline", async () => {
  const ctx = createStepContext(f.options);
  const wrapper = step({
    id: "flow",
    action: "callFlow",
    versionId: "00000000-0000-4000-8000-000000000003",
    observers: [
      { id: "opened", kind: "newPage", pageKey: "missing", timeoutMs: 100 },
    ],
  });
  wrapper.children = [
    step({
      id: "fill",
      action: "fill",
      target: "name",
      pageKey: "missing",
      value: "never",
    }),
  ];
  const r = await executeStep(wrapper, ctx);
  expect(r.status).toBe("FAILED");
  expect(ctx.registry.activeCount()).toBe(0);
  ctx.dispose();
}, 1500);
it("a wrapper dialog observer handles a child action without an unexpected-dialog handler racing it", async () => {
  const ctx = createStepContext(f.options);
  const wrapper = step({
    id: "flow",
    action: "callFlow",
    versionId: "00000000-0000-4000-8000-000000000003",
    observers: [
      {
        id: "asked",
        kind: "dialog",
        dialogType: "prompt",
        message: "Name?",
        handling: "accept",
        promptText: "wrapper",
      },
    ],
  });
  wrapper.children = [
    step({ id: "prompt", action: "click", target: "prompt" }),
  ];
  const r = await executeStep(wrapper, ctx);
  expect(r.status).toBe("PASSED");
  ctx.dispose();
});
it("fails a second popup observed during a later child within the wrapper step", async () => {
  const ctx = createStepContext(f.options);
  let count = 0,
    resolveSecond!: () => void;
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  const observed = () => {
    if (++count === 2) resolveSecond();
  };
  f.page.on("popup", observed);
  f.hooks.set("/await-second-popup", () => second);
  try {
    const wrapper = step({
      id: "flow",
      action: "callFlow",
      versionId: "00000000-0000-4000-8000-000000000003",
      observers: [{ id: "opened", kind: "newPage", pageKey: "twice" }],
    });
    wrapper.children = [
      step({ id: "first", action: "click", target: "popup" }),
      step({ id: "second", action: "click", target: "popup" }),
      step({
        id: "barrier",
        action: "apiRequest",
        method: "GET",
        path: "/await-second-popup",
      }),
    ];
    expect((await executeStep(wrapper, ctx)).errorCode).toBe("AMBIGUOUS_EVENT");
    expect(ctx.registry.activeCount()).toBe(0);
  } finally {
    f.page.off("popup", observed);
    f.hooks.delete("/await-second-popup");
    ctx.dispose();
  }
});
it("a captured dialog does not time out while later children finish their business assertions", async () => {
  const ctx = createStepContext(f.options);
  const wrapper = step({
    id: "flow",
    action: "callFlow",
    versionId: "00000000-0000-4000-8000-000000000003",
    observers: [
      {
        id: "asked",
        kind: "dialog",
        dialogType: "prompt",
        message: "Name?",
        handling: "accept",
        timeoutMs: 300,
      },
    ],
  });
  wrapper.children = [
    step({ id: "prompt", action: "click", target: "prompt" }),
    step(
      { id: "read", action: "apiRequest", method: "GET", path: "/save" },
      [],
      [
        a({
          type: "eventually",
          query: { method: "GET", path: "/eventual" },
          pointer: "/exists",
          operator: "equals",
          expected: true,
          timeoutMs: 2000,
          intervalMs: 200,
        }),
      ],
    ),
  ];
  const result = await executeStep(wrapper, ctx);
  expect(result.status, JSON.stringify(result)).toBe("PASSED");
  ctx.dispose();
});
it("rejects a second popup arriving during the after-assertion phase", async () => {
  const ctx = createStepContext(f.options);
  f.hooks.set("/late-popup", async () => {
    // Deliver the second popup during this assertion's HTTP request window.
    // window.open returning alone does not guarantee Playwright event delivery.
    const popup = f.page.waitForEvent("popup");
    await f.page.evaluate(() => window.open("/", "_blank"));
    await popup;
  });
  try {
    const p = step(
      {
        id: "open",
        action: "click",
        target: "popup",
        observers: [{ id: "opened", kind: "newPage", pageKey: "late" }],
      },
      [],
      [
        a({
          type: "eventually",
          query: { method: "GET", path: "/late-popup" },
          pointer: "/code",
          operator: "equals",
          expected: 0,
          timeoutMs: 2000,
        }),
      ],
    );
    const r = await executeStep(p, ctx);
    expect(r.errorCode).toBe("AMBIGUOUS_EVENT");
    expect(ctx.registry.activeCount()).toBe(0);
  } finally {
    f.hooks.delete("/late-popup");
    ctx.dispose();
  }
});
it("cancels an unfinished browser download when acquisition times out and leaves no partial evidence", async () => {
  const ctx = createStepContext({
    ...f.options,
    downloads: { directory: dir, maxBytes: 64 },
  });
  const files = await readdir(dir);
  let failure: string | null | undefined;
  const download = f.page.waitForEvent("download").then((d) => {
    void d.failure().then((value) => {
      failure = value;
    });
  });
  await f.page.evaluate(() => {
    document
      .querySelector("[data-testid=download]")!
      .setAttribute("href", "/slow-download");
  });
  try {
    const r = await executeStep(
      step({
        id: "slow",
        action: "click",
        target: "download",
        observers: [{ id: "file", kind: "download", timeoutMs: 200 }],
      }),
      ctx,
    );
    await download;
    expect(r.errorCode).toBe("EVENT_TIMEOUT");
    await expect.poll(() => failure, { timeout: 1000 }).toBe("canceled");
    expect(await readdir(dir)).toEqual(files);
    expect(ctx.registry.activeCount()).toBe(0);
  } finally {
    await f.page.evaluate(() => {
      document
        .querySelector("[data-testid=download]")!
        .setAttribute("href", "/text");
    });
    ctx.dispose();
  }
});
