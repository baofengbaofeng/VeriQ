import { expect, test } from "vitest";
import { validateSchema, assetSourceBytes } from "../src/index.js";
import source from "../fixtures/asset-source.json" with { type: "json" };
const id = "00000000-0000-4000-8000-000000000001";
test("fixed auth configurations accept supported handlers and reject uploaded code", () => {
  expect(
    validateSchema("AuthAdapterConfigV1", {
      kind: "HTTP_BEARER",
      identityPath: "/me",
      identityPointer: "/id",
    }),
  ).toEqual([]);
  expect(
    validateSchema("AuthAdapterConfigV1", { kind: "SCRIPT", source: "eval()" }),
  ).not.toEqual([]);
});
test("source identity binds optional registry configurations", () => {
  const original = source.snapshot as never;
  const extended = {
    ...source.snapshot,
    authAdapters: [
      {
        workspaceId: id,
        versionId: id,
        contentHash: "a".repeat(64),
        configuration: {
          kind: "HTTP_BEARER",
          identityPath: "/me",
          identityPointer: "/id",
        },
      },
    ],
  } as never;
  expect(assetSourceBytes(extended)).not.toEqual(assetSourceBytes(original));
});
test("fixture contracts admit explicit inputs and isolated service identities", () => {
  const c = {
    ...source.snapshot.assets[0]!.document,
    fixtureInput: { name: "{{data.name}}" },
  };
  expect(validateSchema("CaseDslV1", c)).toEqual([]);
  const f = {
    schemaVersion: "1.0",
    prepare: { method: "POST", path: "/prepare" },
    query: { method: "GET", path: "/query" },
    cleanup: { method: "POST", path: "/cleanup" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    ttlSeconds: 60,
  };
  expect(validateSchema("FixtureV1", f)).toEqual([]);
  expect(
    validateSchema("FixtureV1", {
      ...f,
      prepare: { method: "GET", path: "/prepare" },
    }),
  ).not.toEqual([]);
});
test("evidence manifests require an explicit sensitivity classification", () => {
  const file = { path: "trace.zip", sha256: "a".repeat(64), sizeBytes: 1 };
  expect(validateSchema("EvidenceFileEntryV1", file)).not.toEqual([]);
  expect(
    validateSchema("EvidenceFileEntryV1", {
      ...file,
      sensitivity: "CREDENTIAL_RESTRICTED",
    }),
  ).toEqual([]);
});
test("registry source projection matches Python with mixed-case UUID lexical ordering", async () => {
  const { createHash } = await import("node:crypto");
  const vector = (
    await import("../fixtures/identity-source.json", { with: { type: "json" } })
  ).default;
  expect(
    createHash("sha256")
      .update(assetSourceBytes(vector.snapshot))
      .digest("hex"),
  ).toBe(vector.sha256);
});
test("initial variable declarations expose only own correctly typed frozen values", async () => {
  const { resolveInitialVariables } = await import("../src/index.js");
  expect(
    resolveInitialVariables(
      { name: "string", count: "number" },
      { name: "Ada", count: 2, legacy: true },
    ),
  ).toEqual({ name: "Ada", count: 2 });
  expect(resolveInitialVariables(undefined, { legacy: true })).toEqual({});
  expect(() => resolveInitialVariables({ name: "string" }, {})).toThrow(
    "INITIAL_VARIABLES_INVALID",
  );
  expect(() =>
    resolveInitialVariables({ name: "string" }, { name: 42 }),
  ).toThrow("INITIAL_VARIABLES_INVALID");
  expect(() =>
    resolveInitialVariables({ name: "string" }, Object.create({ name: "Ada" })),
  ).toThrow("INITIAL_VARIABLES_INVALID");
});
