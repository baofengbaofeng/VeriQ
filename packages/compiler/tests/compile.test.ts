import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assetSourceBytes,
  canonicalBytes,
  type AssetSnapshotV1,
  type AssetVersionV1,
  type CaseDslV1,
  type StepV1,
} from "@veriq/contracts";
import { validate } from "../src/index.js";
import { id, asset, catalog, snapshot, rehash, hash } from "./helpers.js";
const codes = (s: AssetSnapshotV1) => validate(s).map((x) => x.code);
describe("semantic validation", () => {
  it("accepts valid closure", () => expect(validate(snapshot())).toEqual([]));
  it("rejects use before extraction", () =>
    expect(
      codes(
        snapshot([
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{vars.employeeId}}",
          },
        ]),
      ),
    ).toContain("VARIABLE_USED_BEFORE_DEFINED"));
  it("verifies source hash", () => {
    const s = snapshot();
    s.sourceHash = "f".repeat(64);
    expect(codes(s)).toContain("SOURCE_HASH_MISMATCH");
  });
  it("verifies document hash", () => {
    const s = snapshot();
    s.assets[0].sha256 = "f".repeat(64);
    s.sourceHash = hash(assetSourceBytes(s));
    expect(codes(s)).toContain("DOCUMENT_HASH_MISMATCH");
  });
  it("requires pinned reference kinds", () => {
    const s = snapshot();
    (s.assets[0].document as CaseDslV1).catalogVersionId = id(1);
    expect(codes(rehash(s))).toContain("REFERENCE_KIND_MISMATCH");
  });
  it("rejects missing catalog element", () =>
    expect(
      codes(snapshot([{ id: "click", action: "click", target: "missing" }])),
    ).toContain("UNKNOWN_ELEMENT"));
  it("requires WRITE persistence and critical business result", () =>
    expect(
      codes(
        snapshot(
          [{ id: "save", action: "click", target: "name", critical: true }],
          [],
          { kind: "WRITE" },
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "MISSING_PERSISTENCE_CHECKPOINT",
        "MISSING_BUSINESS_ASSERTION",
      ]),
    ));
  it("rejects unsafe expressions structurally", () =>
    expect(
      codes(
        snapshot([
          { id: "fill", action: "fill", target: "name", value: "{{evil()}}" },
        ]),
      ),
    ).toContain("SCHEMA_VIOLATION"));
});
describe("closure and dependency semantics", () => {
  it("rejects duplicate version identities", () =>
    expect(codes(snapshot(undefined, [catalog()]))).toContain(
      "DUPLICATE_VERSION",
    ));
  it("rejects unreachable assets", () =>
    expect(
      codes(
        snapshot(undefined, [
          asset(9, "DATASET", {
            schemaVersion: "1.0",
            columns: { name: "string" },
            rows: [{ key: "one", values: { name: "Jane" } }],
          }),
        ]),
      ),
    ).toContain("UNREACHABLE_ASSET"));
  it("validates dataset row types", () =>
    expect(
      codes(
        snapshot(
          undefined,
          [
            asset(3, "DATASET", {
              schemaVersion: "1.0",
              columns: { name: "string" },
              rows: [{ key: "one", values: { name: 1 } }],
            }),
          ],
          { datasetVersionId: id(3) },
        ),
      ),
    ).toContain("DATA_TYPE_MISMATCH"));
  it("rejects recursive flows", () =>
    expect(
      codes(
        snapshot(
          [{ id: "call", action: "callFlow", versionId: id(3) }],
          [
            asset(3, "FLOW", {
              schemaVersion: "1.0",
              steps: [{ id: "again", action: "callFlow", versionId: id(3) }],
            }),
          ],
        ),
      ),
    ).toContain("FLOW_CYCLE"));
  it("rejects undefined observer references", () =>
    expect(
      codes(
        snapshot([
          {
            id: "step",
            action: "reload",
            extract: [
              {
                source: "response:absent",
                pointer: "/id",
                to: "id",
                valueType: "string",
                required: true,
              },
            ],
          },
        ]),
      ),
    ).toContain("UNKNOWN_OBSERVER"));
  it("accepts extraction before dependent assertions and subsequent actions", () =>
    expect(
      validate(
        snapshot([
          {
            id: "save",
            action: "reload",
            observers: [{ id: "read", method: "GET", path: "/" }],
            extract: [
              {
                source: "response:read",
                pointer: "/id",
                to: "id",
                valueType: "string",
                required: true,
              },
            ],
            afterAssertions: [
              {
                id: "same",
                type: "responseField",
                source: "response:read",
                pointer: "/id",
                operator: "equals",
                expected: "{{vars.id}}",
                severity: "BLOCK",
                expectedSource: "API",
              },
            ],
          },
          { id: "fill", action: "fill", target: "name", value: "{{vars.id}}" },
        ]),
      ),
    ).toEqual([]));
  it("rejects optional extraction used without presence guarantee", () =>
    expect(
      codes(
        snapshot([
          {
            id: "read",
            action: "reload",
            observers: [{ id: "read", method: "GET", path: "/" }],
            extract: [
              {
                source: "response:read",
                pointer: "/id",
                to: "id",
                valueType: "string",
                required: false,
              },
            ],
          },
          { id: "fill", action: "fill", target: "name", value: "{{vars.id}}" },
        ]),
      ),
    ).toContain("POSSIBLY_MISSING_VARIABLE"));
  it("preserves full-placeholder types", () =>
    expect(
      codes(
        snapshot([
          {
            id: "read",
            action: "reload",
            observers: [{ id: "read", method: "GET", path: "/" }],
            extract: [
              {
                source: "response:read",
                pointer: "/id",
                to: "id",
                valueType: "integer",
                required: true,
              },
            ],
          },
          { id: "fill", action: "fill", target: "name", value: "{{vars.id}}" },
        ]),
      ),
    ).toContain("BINDING_TYPE_MISMATCH"));
  it("rejects a zero-case CASE validation target", () => {
    const s = snapshot();
    s.entryCaseVersionIds = [];
    s.validationTarget = {
      resourceId: s.assets[0].resourceId,
      versionId: id(1),
      revision: 1,
    };
    expect(codes(rehash(s))).toContain("INVALID_VALIDATION_TARGET");
  });
});
describe("binding and pointer behavior", () => {
  it("distinguishes missing/null and never traverses prototypes", async () => {
    const { resolvePointer } = await import("../src/index.js");
    expect(resolvePointer({ x: null }, "/x")).toEqual({
      present: true,
      value: null,
    });
    expect(resolvePointer({}, "/constructor")).toEqual({ present: false });
    expect(resolvePointer({ "a/b": { "~x": 1 } }, "/a~1b/~0x")).toEqual({
      present: true,
      value: 1,
    });
  });
  it("preserves full binding types without reinterpreting resolved data", async () => {
    const { resolveBinding } = await import("../src/index.js");
    expect(
      resolveBinding("{{data.x}}", { data: { x: "{{evil()}}" }, vars: {} }),
    ).toBe("{{evil()}}");
    expect(resolveBinding("{{data.x}}", { data: { x: 12 }, vars: {} })).toBe(
      12,
    );
    expect(() =>
      resolveBinding("{{vars.constructor}}", { data: {}, vars: {} }),
    ).toThrow("MISSING_BINDING");
  });
});
