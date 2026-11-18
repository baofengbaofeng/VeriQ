/**
 * 静态数据集夹具送入冻结快照分析，确认结构可接受的草稿仍要接受编译语义检查，独立库与执行矩阵的要求也不同。
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import fixtures from "../../contracts/fixtures/datasets.json" with { type: "json" };
import { analyze } from "../src/validate.js";
import { asset, id, rehash, snapshot } from "./helpers.js";

/**
 * 用真实资产摘要和验证目标重建独立数据集发布输入，使数据行诊断不会被来源摘要或无入口用例的校验错误遮住。
 */
function diagnostics(document: unknown) {
    const target = asset(1, "DATASET", document);
    return analyze(
        rehash({
            schemaVersion: "1.0",
            workspaceId: id(99),
            engineVersion: "0.1.0",
            sourceHash: "0".repeat(64),
            entryCaseVersionIds: [],
            assets: [target],
            validationTarget: { resourceId: target.resourceId, versionId: target.versionId, revision: 1 },
        }),
    ).issues;
}

test("datasetV2 validates sparse rows and typed values", () => {
    const sparse = structuredClone(fixtures[0]!.document);
    const numeric = fixtures[1]!;
    const x: Record<string, unknown> = sparse.source.rows[0]!.values;
    expect(diagnostics(sparse)).toEqual([]);
    expect(diagnostics(numeric.document)).toEqual([
        expect.objectContaining({ ...numeric.issue, path: "/assets/0/document" + numeric.issue!.path }),
    ]);
    Object.assign(x, { label: null });
    expect(diagnostics(sparse)).toEqual([]);
    Object.assign(x, { code: null });
    expect(diagnostics(sparse)).toEqual([
        expect.objectContaining({
            code: "DATASET_FIELD_NULL_FORBIDDEN",
            path: "/assets/0/document/source/rows/0/values/code",
        }),
    ]);
    delete x.code;
    expect(diagnostics(sparse)).toEqual([
        expect.objectContaining({
            code: "DATASET_REQUIRED_FIELD_MISSING",
            path: "/assets/0/document/source/rows/0/values/code",
        }),
    ]);
});

test("tree rejects unresolved and cyclic parent links", () => {
    for (const { document, issue } of fixtures.slice(2, 4)) {
        expect(diagnostics(document)).toEqual([
            expect.objectContaining({ ...issue, path: "/assets/0/document" + issue!.path }),
        ]);
    }
});

test("legacy dataset validates with its original shape and semantics", () => {
    const sample = JSON.parse(
        readFileSync(new URL("../../../fixtures/sample-workspace/assets/dataset.json", import.meta.url), "utf8"),
    );
    expect(diagnostics(sample.document)).toEqual([]);
});

test("empty static dataset validates on its own", () => {
    expect(diagnostics(fixtures.at(-1)!.document)).toEqual([]);
});

test("tree validates one hundred levels and rejects a deeper child", () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
        key: `node_${i}`,
        values: {},
        parentKey: i === 0 ? null : `node_${i - 1}`,
        order: 0,
    }));
    const document = { ...fixtures[2]!.document, source: { kind: "STATIC", rows } };
    expect(diagnostics({ ...document, source: { kind: "STATIC", rows: rows.slice(0, 100) } })).toEqual([]);
    expect(diagnostics(document)).toEqual([
        expect.objectContaining({
            code: "DATASET_TREE_DEPTH_LIMIT",
            path: "/assets/0/document/source/rows/100/parentKey",
        }),
    ]);
});

test("tree rejects duplicate row keys and undeclared value fields", () => {
    const rows = [
        { key: "node", values: {}, parentKey: null, order: 0 },
        { key: "node", values: { "unknown/key": true }, parentKey: null, order: 0 },
    ];
    const document = { ...fixtures[2]!.document, source: { kind: "STATIC", rows } };
    expect(diagnostics(document)).toEqual([
        expect.objectContaining({ code: "DATASET_DUPLICATE_ROW_KEY", path: "/assets/0/document/source/rows/1/key" }),
        expect.objectContaining({
            code: "DATASET_UNKNOWN_FIELD",
            path: "/assets/0/document/source/rows/1/values/unknown~1key",
        }),
    ]);
});

test("the suite rejects an empty dataset used as its matrix driver", () => {
    const data = asset(3, "DATASET", fixtures.at(-1)!.document);
    const suite = asset(4, "SUITE", { schemaVersion: "1.0", cases: [{ versionId: id(1), datasetVersionId: id(3) }] });
    expect(analyze(snapshot(undefined, [data, suite])).issues).toEqual([
        expect.objectContaining({ code: "DATASET_EMPTY_MATRIX", path: "/assets/3/document/cases/0/datasetVersionId" }),
    ]);
});

test("the case accepts a typed string from its matrix and detects sparse bindings", () => {
    const document = fixtures[0]!.document;
    const data = asset(3, "DATASET", document);
    expect(
        analyze(
            snapshot([{ id: "fill", action: "fill", target: "name", value: "{{data.code}}" }], [data], {
                datasetVersionId: id(3),
            }),
        ).issues,
    ).toEqual([]);
    expect(
        analyze(
            snapshot([{ id: "fill", action: "fill", target: "name", value: "{{data.label}}" }], [data], {
                datasetVersionId: id(3),
            }),
        ).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "POSSIBLY_MISSING_VARIABLE" })]));
});
