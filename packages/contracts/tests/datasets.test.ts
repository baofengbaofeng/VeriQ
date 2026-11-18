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
