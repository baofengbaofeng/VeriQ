import type { DatasetV1, DatasetV2, ResourceDocumentV1 } from "@veriq/contracts";
import type { RecordingCandidate, RecordingTable } from "../../shared/recording";
import type { RecordingDraft } from "./draft-model";
import type { PublishedVersion } from "./workspace-data";

export function optionDataset(
    options: { label: string; value: string }[],
): Extract<ResourceDocumentV1, { kind: "DATASET" }> {
    if (!options.length) throw new Error("OPTIONS_UNAVAILABLE");
    return {
        kind: "DATASET",
        document: {
            schemaVersion: "2.0",
            shape: "TABLE",
            fields: {
                label: { type: "string", required: true, nullable: false },
                value: { type: "string", required: true, nullable: false },
            },
            source: {
                kind: "STATIC",
                rows: options.map(({ label, value }, index) => ({
                    key: `option_${index + 1}`,
                    values: { label, value },
                })),
            },
        },
    };
}

export function selectableColumns(document: DatasetV1 | DatasetV2): string[] {
    const rows =
        document.schemaVersion === "1.0"
            ? document.rows
            : document.source.kind === "STATIC"
              ? document.source.rows
              : [];
    if (!rows.length) return [];
    const fields = document.schemaVersion === "1.0" ? document.columns : document.fields;
    return Object.entries(fields)
        .filter(
            ([key, field]) =>
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
                (typeof field === "string" ? field === "string" : field.type === "string" && !field.nullable) &&
                rows.every(({ values }) => Object.hasOwn(values, key) && typeof values[key] === "string"),
        )
        .map(([key]) => key);
}

export function tableColumnKeys(columns: string[]): string[] {
    const keys = new Set<string>();
    return columns.map((header, index) => {
        const text = header.trim();
        const base =
            /^[A-Za-z_][A-Za-z0-9_]{0,140}$/.test(text) && !Object.hasOwn(Object.prototype, text)
                ? text
                : `column_${index + 1}`;
        let key = base;
        for (let suffix = 2; keys.has(key); suffix++) key = `${base}_${suffix}`;
        keys.add(key);
        return key;
    });
}

export function tableDataset(table: RecordingTable): Extract<ResourceDocumentV1, { kind: "DATASET" }> {
    const keys = tableColumnKeys(table.columns);
    if (!keys.length || !table.rows.length || table.rows.some((row) => row.length !== keys.length))
        throw new Error("DATA_UNAVAILABLE");
    return {
        kind: "DATASET",
        document: {
            schemaVersion: "2.0",
            shape: "TABLE",
            fields: Object.fromEntries(keys.map((key) => [key, { type: "string", required: true, nullable: false }])),
            source: {
                kind: "STATIC",
                rows: table.rows.map((row, index) => ({
                    key: `row_${index + 1}`,
                    values: Object.fromEntries(keys.map((key, col) => [key, row[col]!])),
                })),
            },
        },
    };
}

export function bindSelectColumn(
    draft: RecordingDraft,
    event: { id: string; candidates: RecordingCandidate[] },
    version: PublishedVersion,
    column: string,
): RecordingDraft {
    if (draft.datasetVersionId && draft.datasetVersionId !== version.id) throw new Error("DATASET_VERSION_CONFLICT");
    if (version.content.kind !== "DATASET" || !selectableColumns(version.content.document).includes(column))
        throw new Error("INVALID_DATA_COLUMN");
    const id = `step_${event.id}`;
    if (draft.steps.some(({ step }) => step.id === id)) return draft;
    if (draft.steps.length >= 500) throw new Error("STEP_LIMIT");
    return {
        ...draft,
        datasetVersionId: version.id,
        steps: [
            ...draft.steps,
            {
                step: { id, action: "selectOption", target: "", value: `{{data.${column}}}` },
                recording: { catalogVersionId: draft.catalogVersionId, candidates: event.candidates },
            },
        ],
    };
}
