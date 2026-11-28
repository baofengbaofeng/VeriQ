import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBinding, validateDataset } from "@veriq/contracts";
import {
    bindSelectColumn,
    optionDataset,
    selectableColumns,
    tableDataset,
} from "../src/renderer/recording/annotation-data";
import { newRecordingDraft } from "../src/renderer/recording/draft-model";
import type { PublishedVersion } from "../src/renderer/recording/workspace-data";

const options = [
    { label: "请选择", value: "" },
    { label: "杭州", value: "hangzhou" },
    { label: "杭州", value: "other-id" },
];
const version: PublishedVersion = {
    id: "0a40c047-9837-4190-9898-ddd59751f24a",
    resourceId: "5d554cb7-d41d-4d42-a283-e308355fee79",
    versionNo: 2,
    name: "城市",
    kind: "DATASET",
    content: {
        kind: "DATASET",
        document: {
            schemaVersion: "1.0",
            columns: { city: "string" },
            rows: [{ key: "hz", values: { city: "hangzhou" } }],
        },
    },
};
const event = { id: "menu_1", candidates: [{ locator: { by: "veriqId" as const, value: "city" }, matches: 1 }] };

test("table extraction preserves every cell under distinct, bindable column keys", () => {
    const table = { columns: ["城市", "code", "code", "__proto__"], rows: [["杭州", "HGH", "", "x"]] };
    const { document } = tableDataset(table);
    assert.deepEqual(validateDataset(document), []);
    assert.ok(document.schemaVersion === "2.0" && document.source.kind === "STATIC");
    assert.deepEqual(selectableColumns(document), ["column_1", "code", "code_2", "column_4"]);
    assert.deepEqual(document.source.rows[0]?.values, { column_1: "杭州", code: "HGH", code_2: "", column_4: "x" });
    assert.throws(() => tableDataset({ columns: ["A"], rows: [["x", "lost"]] }));
});

test("capture preserves option order, repeated labels and empty values in a valid static dataset", () => {
    const { document } = optionDataset(options);
    assert.deepEqual(validateDataset(document), []);
    assert.ok(document.schemaVersion === "2.0" && document.shape === "TABLE" && document.source.kind === "STATIC");
    assert.deepEqual(
        document.source.rows.map((row) => row.values),
        options,
    );
    assert.equal(new Set(document.source.rows.map((row) => row.key)).size, 3);
    assert.deepEqual(selectableColumns(document), ["label", "value"]);
});

test("select binds the fixed matrix version and resolves the chosen column for each row", () => {
    const draft = newRecordingDraft();
    const bound = bindSelectColumn(draft, event, version, "city");
    assert.equal(bound.datasetVersionId, version.id);
    const step = bound.steps[0]!.step;
    assert.ok(step.action === "selectOption");
    assert.equal(resolveBinding(step.value, { data: { city: "hangzhou" }, vars: {} }), "hangzhou");
    assert.deepEqual(bound.steps[0]!.recording?.candidates, event.candidates);
    assert.equal(bindSelectColumn(bound, event, version, "city"), bound);
    assert.throws(() => bindSelectColumn({ ...draft, datasetVersionId: "another" }, event, version, "city"));
    assert.throws(() => bindSelectColumn(draft, event, version, "unknown"));
});

test("only columns that resolve to a string on every frozen row are selectable", () => {
    assert.deepEqual(
        selectableColumns({
            schemaVersion: "2.0",
            shape: "TABLE",
            fields: {
                city: { type: "string", required: true, nullable: false },
                optional: { type: "string", required: false, nullable: true },
                number: { type: "integer", required: true, nullable: false },
                "a.b": { type: "string", required: true, nullable: false },
            },
            source: { kind: "STATIC", rows: [{ key: "one", values: { city: "", number: 42, "a.b": "x" } }] },
        }),
        ["city"],
    );
});
