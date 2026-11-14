import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { validateSchema } from "@veriq/contracts";
import { schemaValidator } from "../../../packages/contracts/src/validators.ts";

/** 构建出的静态校验器逐项对照原契约入口及跨语言规范样本，包括嵌套引用、非法附加字段和格式错误；这验证 CSP 兼容改动沿用相同规则，不能以空校验器换取桌面成功挂载。 */
test("desktop standalone validators preserve contract sample results and errors", async () => {
    const generated = createRequire(import.meta.url)("../../web/dist-desktop/validators.cjs");
    const cases: { schema: string; value: unknown; valid: boolean }[] = JSON.parse(
        await readFile(
            new URL("../../../packages/contracts/fixtures/compatibility.json", import.meta.url),
            "utf8",
        ),
    );
    cases.push(
        { schema: "Id", value: "not-a-uuid", valid: false },
        { schema: "Id", value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", valid: true },
    );
    for (const sample of cases) {
        const fn = generated.schemaValidator(sample.schema);
        const valid = fn(sample.value);
        assert.equal(valid, sample.valid, sample.schema);
        assert.equal(
            valid,
            validateSchema(sample.schema, sample.value).length === 0,
            sample.schema,
        );
        const original = schemaValidator(sample.schema);
        assert.equal(original(sample.value), valid, sample.schema);
        assert.deepEqual(fn.errors, original.errors, sample.schema);
    }
});
