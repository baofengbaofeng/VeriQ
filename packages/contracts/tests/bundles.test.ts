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
