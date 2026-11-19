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

/**
 * 行结构缺失属性与额外属性均应显示原始键，含斜线和波浪号的未声明值不向用户展示指针转义文本。
 */
test("JSON issues identify missing and extra keys and decode pointer tokens", () => {
    const parse = (row: unknown) => parseDatasetImport("JSON", JSON.stringify([row]), dataset).issues;
    assert.ok(parse({ values: {} }).some((i) => i.field === "key"));
    assert.ok(parse({ key: "a", values: {}, "x/~odd": true }).some((i) => i.field === "x/~odd"));
    assert.ok(parse({ key: "a", values: { ["__proto__"]: "", "x/~odd": true } }).some((i) => i.field === "x/~odd"));
});

/**
 * 跨行文本上的闭引号错误、未闭引号都指向物理起始行及当前字段，不能误报引号所在的下一物理行。
 */
test("malformed CSV quotes identify record start and offending column", () => {
    for (const ending of ['a,"one\ntwo"oops,1', 'a,"one\ntwo']) {
        assert.deepEqual(parseDatasetImport("CSV", "key,__proto__,a.b\n" + ending, dataset).issues, [
            { row: 2, field: "__proto__", code: "INVALID_CSV" },
        ]);
    }
});

/**
 * 显式限定字段列以区分行元数据，重复检查使用解析后的业务键，因此两种等价拼写不能覆盖彼此。
 */
test("qualified CSV headers distinguish row metadata and literal dotted field names", () => {
    const fields = Object.fromEntries(
        ["key", "parentKey", "order", "values.foo", "a.b"].map((k) => [
            k,
            { type: "string" as const, required: true, nullable: false },
        ]),
    );
    const tree: DatasetV2 = { schemaVersion: "2.0", shape: "TREE", fields, source: { kind: "STATIC", rows: [] } };
    const header = "key,parentKey,order,values.key,values.parentKey,values.order,values.values.foo,a.b";
    assert.deepEqual(parseDatasetImport("CSV", header + "\nr,,3,k,p,o,f,ab", tree), {
        rows: [
            {
                key: "r",
                parentKey: null,
                order: 3,
                values: { key: "k", parentKey: "p", order: "o", "values.foo": "f", "a.b": "ab" },
            },
        ],
        issues: [],
    });
    assert.deepEqual(parseDatasetImport("CSV", header + ",values.a.b", tree).issues, [
        { row: 1, field: "a.b", code: "DUPLICATE_COLUMN" },
    ]);
});

/**
 * 输入包含转义的孤立代理项时，原始文本仍可由 JSON 解析，预检必须与服务端规范化字节约束保持一致。
 */
test("JSON rejects unpaired UTF-16 instead of accepting a draft the server cannot save", () => {
    const text = JSON.stringify([{ key: "a", values: { ["__proto__"]: "\ud800" } }]);
    const result = parseDatasetImport("JSON", text, dataset);
    assert.deepEqual(result.rows, []);
    assert.ok(result.issues.length);
});

/**
 * 结构错误、字段语义错误及宽表头都只保留界面能够显示的问题，任意未展示错误都不能使导入结果含有可应用的行。
 */
test("crowded imports keep the first hundred diagnostics and reject all rows", () => {
    const semantic = Array.from({ length: 2400 }, (_, i) => ({ key: "r" + i, values: { unknown: true } }));
    const extras = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => ["extra" + i, 0]));
    for (const [format, input, lastRow, lastField] of [
        ["JSON", JSON.stringify(Array(2400).fill(null)), 100, "row"],
        ["JSON", JSON.stringify(semantic), 50, "__proto__"],
        ["JSON", JSON.stringify([{ key: "r", values: {}, ...extras }]), 1, "extra99"],
        ["CSV", ["key", ...Array(1200).fill("bad")].join(","), 1, "bad"],
    ] as const) {
        const result = parseDatasetImport(format, input, dataset);
        assert.deepEqual(result.rows, []);
        assert.equal(result.issues.length, 100);
        assert.equal(result.issues[0]?.row, 1);
        assert.equal(result.issues.at(-1)?.row, lastRow);
        assert.equal(result.issues.at(-1)?.field, lastField);
    }
});
