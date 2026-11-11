import { expect, test } from "vitest";
import { validate } from "../src/index.js";
import { snapshot, asset, id, rehash, hash } from "./helpers.js";
import { canonicalBytes } from "@veriq/contracts";
test("fixture inputs validate binding scope before fixture outputs become variables", () => {
  const fixture = asset(3, "FIXTURE", {
    schemaVersion: "1.0",
    prepare: { method: "POST", path: "/prepare" },
    query: { method: "GET", path: "/query" },
    cleanup: { method: "POST", path: "/cleanup" },
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    ttlSeconds: 60,
  });
  const s = snapshot(undefined, [fixture], {
    fixtureVersionId: id(3),
    fixtureInput: { name: "{{vars.code}}" },
  });
  expect(
    validate(s).some((x) => x.code === "VARIABLE_USED_BEFORE_DEFINED"),
  ).toBe(true);
  const c = s.assets[0]!;
  if (c.kind !== "CASE") throw Error();
  c.document.fixtureInput = { name: 123 };
  rehash(s);
  expect(validate(s).some((x) => x.code === "FIXTURE_INPUT_INVALID")).toBe(
    true,
  );
  c.document.fixtureInput = { name: "valid" };
  rehash(s);
  expect(validate(s)).toEqual([]);
});
test("source registry rejects unrelated configs and altered content hashes", () => {
  const s = snapshot();
  const configuration = {
    kind: "HTTP_BEARER" as const,
    identityPath: "/me",
    identityPointer: "/id",
  };
  s.authAdapters = [
    {
      workspaceId: s.workspaceId,
      versionId: id(20),
      configuration,
      contentHash: hash(canonicalBytes(configuration)),
    },
  ];
  rehash(s);
  expect(validate(s).some((x) => x.code === "UNRELATED_AUTH_ADAPTER")).toBe(
    true,
  );
  s.authAdapters[0]!.contentHash = "a".repeat(64);
  rehash(s);
  expect(validate(s).some((x) => x.code === "AUTH_ADAPTER_HASH_MISMATCH")).toBe(
    true,
  );
});
