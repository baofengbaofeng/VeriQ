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
function initialSource(
    inputSchema: unknown = {
        type: "object",
        properties: {
            name: { type: "string" },
            constant: { type: "integer", minimum: 1 },
        },
        required: ["name"],
        additionalProperties: false,
    },
) {
    const fixture = asset(3, "FIXTURE", {
        schemaVersion: "1.0",
        prepare: { method: "POST", path: "/prepare" },
        query: { method: "GET", path: "/query" },
        cleanup: { method: "POST", path: "/cleanup" },
        inputSchema,
        outputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
        },
        ttlSeconds: 60,
    });
    return snapshot(undefined, [fixture], {
        fixtureVersionId: id(3),
        initialVariables: { private: "string" },
        fixtureInput: { name: "{{vars.private}}", constant: 1 },
    });
}
test("declared initial fixture inputs compile while undeclared future outputs and static mismatches fail", () => {
    const s = initialSource();
    expect(validate(s)).toEqual([]);
    const c = s.assets[0]!;
    if (c.kind !== "CASE") throw Error();
    c.document.fixtureInput = { name: "{{vars.code}}" };
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain(
        "VARIABLE_USED_BEFORE_DEFINED",
    );
    c.document.fixtureInput = { name: "{{vars.private}}", constant: 0 };
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain("FIXTURE_INPUT_INVALID");
    c.document.initialVariables = { private: "integer" };
    c.document.fixtureInput = { name: "{{vars.private}}" };
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain("BINDING_TYPE_MISMATCH");
    c.document.initialVariables = { code: "string" };
    c.document.fixtureInput = { name: "{{vars.code}}" };
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain("DUPLICATE_VARIABLE");
});
test("dynamic fixture inputs preserve local refs and defer only value-dependent conditional constraints", () => {
    const s = initialSource({
        type: "object",
        $defs: {
            label: { type: "string", minLength: 2 },
            count: { type: "integer", minimum: 1 },
        },
        properties: {
            name: { $ref: "#/$defs/label" },
            constant: { $ref: "#/$defs/count" },
        },
        required: ["name", "constant"],
        additionalProperties: false,
        if: { properties: { name: { const: "Ada" } } },
        then: { properties: { constant: { const: 1 } } },
        else: { properties: { constant: { const: 2 } } },
    });
    expect(validate(s)).toEqual([]);
    const c = s.assets[0]!;
    if (c.kind !== "CASE") throw Error();
    c.document.fixtureInput = { name: "{{vars.private}}", constant: 0 };
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain("FIXTURE_INPUT_INVALID");
});
test.each([
    { constant: 1 },
    { name: "{{vars.private}}", constant: 1, extra: true },
])("dynamic fixture input still enforces unconditional keys: %j", (input) => {
    const s = initialSource();
    const c = s.assets[0]!;
    if (c.kind !== "CASE") throw Error();
    c.document.fixtureInput = input;
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain("FIXTURE_INPUT_INVALID");
});
test("dynamic fixture schemas check known data siblings", () => {
    const s = initialSource({
        type: "object",
        properties: {
            name: { type: "string" },
            constant: { type: "integer", minimum: 1 },
        },
        required: ["name", "constant"],
    });
    s.assets.push(
        asset(4, "DATASET", {
            schemaVersion: "1.0",
            columns: { count: "integer" },
            rows: [{ key: "row", values: { count: 0 } }],
        }),
    );
    const c = s.assets[0]!;
    if (c.kind !== "CASE") throw Error();
    c.document.datasetVersionId = id(4);
    c.document.fixtureInput = {
        name: "{{vars.private}}",
        constant: "{{data.count}}",
    };
    rehash(s);
    expect(validate(s).map((i) => i.code)).toContain("FIXTURE_INPUT_INVALID");
});
