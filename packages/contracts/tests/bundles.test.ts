import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { validateSchema } from "../src/index.js";
const id = "00000000-0000-4000-8000-000000000001";
test("offline selection is bounded, exclusive and explicit about draft debug", () => {
  const base = { environmentVersionId: id, validationStatus: "VALIDATED" };
  for (const selection of [{ caseVersionIds: [id] }, { suiteVersionId: id }])
    expect(
      validateSchema("BundleSelectionV1", { ...base, ...selection }),
    ).toEqual([]);
  expect(
    validateSchema("BundleSelectionV1", {
      ...base,
      draftValidationJobId: id,
      validationStatus: "UNVALIDATED_DEBUG",
    }),
  ).toEqual([]);
  for (const selection of [
    {},
    { caseVersionIds: [] },
    { caseVersionIds: [id, id] },
    { caseVersionIds: [id], suiteVersionId: id },
    { draftValidationJobId: id },
    {
      caseVersionIds: Array.from(
        { length: 101 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      ),
    },
  ])
    expect(
      validateSchema("BundleSelectionV1", { ...base, ...selection }).length,
    ).toBeGreaterThan(0);
});
test("issuer trust requires explicit versioned revocation facts and bounded keys", () => {
  const key = {
    keyId: "key_1",
    algorithm: "Ed25519",
    publicKey: "a".repeat(43) + "=",
    fingerprint: "a".repeat(64),
    revoked: false,
  };
  const good = { issuerId: "issuer_1", revision: 1, keys: [key] };
  expect(validateSchema("IssuerTrustV1", good)).toEqual([]);
  for (const value of [
    { ...good, revision: 0 },
    { ...good, keys: [] },
    { ...good, keys: [{ ...key, revoked: "false" }] },
    { ...good, privateKey: "never" },
  ])
    expect(validateSchema("IssuerTrustV1", value).length).toBeGreaterThan(0);
});

test("synchronous bundle API has one session auth path and durable retry contract", () => {
  const api = JSON.parse(
    readFileSync(new URL("../openapi/platform.yaml", import.meta.url), "utf8"),
  );
  for (const [path, methods] of Object.entries(api.paths) as [
    string,
    Record<string, any>,
  ][]) {
    if (!path.startsWith("/api/v1/workspaces/{workspaceId}/bundles")) continue;
    for (const operation of Object.values(methods))
      expect(operation.security).toEqual([{ WebSession: [], CsrfToken: [] }]);
  }
  const create = api.paths["/api/v1/workspaces/{workspaceId}/bundles"].post;
  expect(create.responses["201"]).toBeDefined();
  expect(create.responses["202"]).toBeUndefined();
  expect(
    create.parameters.find(
      (p: { name: string }) => p.name === "Idempotency-Key",
    ).required,
  ).toBe(true);
  expect(create.responses["409"]).toBeDefined();
});
