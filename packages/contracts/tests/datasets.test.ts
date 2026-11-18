/**
 * 将静态数据集夹具送入与服务端共用的资源信封结构，验证新旧版本及形状约束而不重复编译器的业务检查。
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { validateSchema } from "../src/index.js";
import fixtures from "../fixtures/datasets.json" with { type: "json" };

test.each(fixtures)("dataset resource structure for $name", ({ document, invalidStructure }) => {
    const content = { kind: "DATASET", document };
    const issues = validateSchema("ResourceDocumentV1", content);
    expect(issues.length > 0).toBe(invalidStructure ?? false);
});

test("legacy dataset validates with its original shape", () => {
    const sample = JSON.parse(
        readFileSync(new URL("../../../fixtures/sample-workspace/assets/dataset.json", import.meta.url), "utf8"),
    );
    expect(validateSchema("ResourceDocumentV1", sample)).toEqual([]);
});

test("dataset queries exclusively replace eligible expected values while JSON literals remain inert", () => {
    const query = { alias: "reference", op: "contains", key: "missing" };
    const base = {
        id: "check",
        type: "responseField",
        source: "response:action",
        pointer: "",
        operator: "equals",
        severity: "BLOCK",
        expectedSource: "policy",
    };
    const valid = (input: unknown) => validateSchema("AssertionV1", input).length === 0;
    expect(valid({ ...base, expected: query })).toBe(true);
    expect(valid({ ...base, datasetExpected: query })).toBe(true);
    expect(valid(base)).toBe(false);
    expect(valid({ ...base, expected: null, datasetExpected: query })).toBe(false);
    expect(valid({ ...base, datasetExpected: { ...query, equals: null } })).toBe(false);
    expect(valid({ ...base, type: "responseSchema", operator: "matchesSchema", datasetExpected: query })).toBe(false);
});
