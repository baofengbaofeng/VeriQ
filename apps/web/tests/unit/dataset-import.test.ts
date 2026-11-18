import assert from "node:assert/strict";
import test from "node:test";
import type { DatasetV2 } from "@veriq/contracts";
import { parseDatasetImport } from "../../src/features/resources/dataset-import";

const dataset: DatasetV2 = {
    schemaVersion: "2.0",
    shape: "TABLE",
    fields: Object.fromEntries([
        ["__proto__", { type: "string", required: true, nullable: false }],
        ["a.b", { type: "integer", required: false, nullable: true }],
    ]),
    source: { kind: "STATIC", rows: [] },
};

/**
 * 校验可与原型属性重名的字段以及含点的字段，空串必须保留而可选数字留空应产生真正缺失的属性。
 */
test("CSV preserves quoted strings, empty strings, absent integers and literal field names", () => {
    const result = parseDatasetImport("CSV", 'key,__proto__,a.b\r\na,"comma, ""x""\r\ny",0\r\nb,,  \r\n', dataset);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.rows, [
        { key: "a", values: { ["__proto__"]: 'comma, "x"\r\ny', "a.b": 0 } },
        { key: "b", values: { ["__proto__"]: "" } },
    ]);
});

/**
 * 从结构化行数组导入显式空值并拒绝类型错配；失败的候选行整体不可用，调用方始终能继续读取原始数据。
 */
test("JSON keeps explicit null, rejects bad types, and enforces the byte limit", () => {
    const row = { key: "a", values: { ["__proto__"]: "", "a.b": null } };
    assert.deepEqual(parseDatasetImport("JSON", JSON.stringify([row]), dataset), { rows: [row], issues: [] });
    const invalid = parseDatasetImport(
        "JSON",
        JSON.stringify([row, { ...row, values: { ...row.values, "a.b": "1" } }]),
        dataset,
    );
    assert.deepEqual(invalid.rows, []);
    assert.ok(invalid.issues.some((issue) => issue.row === 2 && issue.field === "a.b"));
    assert.ok(parseDatasetImport("CSV", "文".repeat(800_000), dataset).issues.length);
});

/**
 * 逐项覆盖文本转换不能容忍的歧义，尤其是必填数字的空格不能通过数字构造函数误转换为合法的零。
 */
test("CSV fails closed on invalid quoting, record width, numbers and blank required numbers", () => {
    const numeric = { ...dataset, fields: { n: { type: "number" as const, required: true, nullable: false } } };
    for (const text of ['key,n\na,"1', "key,n\na,1,2", "key,n\na,1e999", "key,n\na, "]) {
        const result = parseDatasetImport("CSV", text, numeric);
        assert.deepEqual(result.rows, []);
        assert.equal(result.issues[0]?.row, 2);
    }
});

/**
 * 合理大小的文本在展开行对象后可能超过资源预算。按候选文档的实际编码字节计算，避免预检通过后才发现无法应用。
 */
test("enforces candidate budget even for compact CSV", () => {
    const lines = Array.from({ length: 65_000 }, (_, i) => "r" + i + ",").join("\n");
    const result = parseDatasetImport("CSV", "key,__proto__\n" + lines, dataset);
    assert.deepEqual(result.rows, []);
    assert.equal(result.issues[0]?.code, "DATASET_SIZE_LIMIT");
});

/**
 * 引用后面的父节点可以成功，环和过深的树则必须复用编译器的稳定诊断；字段错误也须定位到对应的行。
 */
test("tree checks preserve forward references, detect cycles and enforce depth", () => {
    const tree: DatasetV2 = { schemaVersion: "2.0", shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const rows = Array.from({ length: 101 }, (_, i) => ({
        key: "r" + i,
        parentKey: i === 0 ? null : "r" + (i - 1),
        order: 0,
        values: {},
    }));
    const deep = parseDatasetImport("JSON", JSON.stringify(rows), tree);
    assert.deepEqual(deep.issues, [{ row: 101, field: "parentKey", code: "DATASET_TREE_DEPTH_LIMIT" }]);
    assert.equal(
        parseDatasetImport("CSV", "key,parentKey,order\na,b,1\nb,a,0", tree).issues[0]?.code,
        "DATASET_TREE_CYCLE",
    );
    assert.deepEqual(parseDatasetImport("CSV", "key,parentKey,order\na,b,1\nb,,0", tree).issues, []);
});
