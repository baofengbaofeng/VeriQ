import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

test("shared canonical source bytes run in a real browser without Node APIs", async ({
  page,
}) => {
  // A static same-origin document isolates this contract test from app startup
  // and Vite's client reload while dynamic dependencies are first optimized.
  await page.goto(
    "/@fs" +
      fileURLToPath(
        new URL("../../../packages/contracts/package.json", import.meta.url),
      ),
  );
  const modulePath =
    "/@fs" +
    fileURLToPath(
      new URL("../../../packages/contracts/src/index.ts", import.meta.url),
    );
  const result = await page.evaluate(async (modulePath) => {
    // Vite serves the workspace package as browser ESM; no crypto/Buffer polyfill.
    const contracts = await import(/* @vite-ignore */ modulePath);
    const bytes = contracts.canonicalBytes({ z: -0, a: 1.0 });
    const source = contracts.assetSourceBytes({
      schemaVersion: "1.0",
      workspaceId: "test",
      engineVersion: "0.1.0",
      entryCaseVersionIds: [],
      assets: [],
      validationTarget: { revision: 1 },
    });
    const binding = contracts.resolveBinding(
      { value: "{{data.answer}}" },
      { data: { answer: 42 }, vars: {} },
    );
    const missing = contracts.resolvePointer({ present: null }, "/missing");
    const present = contracts.resolvePointer({ present: null }, "/present");
    const eventIssues = contracts.validateSchema("ObserverV1", {
      id: "popup",
      kind: "newPage",
      pageKey: "detail",
    });
    return {
      canonical: new TextDecoder().decode(bytes),
      source: new TextDecoder().decode(source),
      binding,
      missing,
      present,
      eventIssues,
    };
  }, modulePath);
  expect(result.canonical).toBe('{"a":1,"z":0}');
  expect(JSON.parse(result.source)).not.toHaveProperty("validationTarget");
  expect(result.binding).toEqual({ value: 42 });
  expect(result.missing).toEqual({ present: false });
  expect(result.present).toEqual({ present: true, value: null });
  expect(result.eventIssues).toEqual([]);
});
