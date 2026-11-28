import { DataTable, useTableView } from "@veriq/web/desktop";
import { Button } from "@veriq/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RecordingEvent } from "../../shared/recording";
import { selectableColumns, tableColumnKeys } from "./annotation-data";
import type { PublishedVersion } from "./workspace-data";

export type AnnotationActionEvent = Extract<RecordingEvent, { type: "annotation-action" }>;

interface Props {
    event: AnnotationActionEvent;
    versions: PublishedVersion[];
    matrixId: string;
    busy: boolean;
    saveOptions(name: string, clientDraftId: string, trigger: HTMLButtonElement): void;
    bindColumn(version: PublishedVersion, column: string): void;
    cancel(): void;
}

const required = (
    <span className="field-required" aria-hidden="true">
        *
    </span>
);

function CapturePreview({ event }: { event: AnnotationActionEvent }) {
    const headers = useMemo(() => {
        if (!event.table)
            return [
                { key: "label", name: "标签 / Label" },
                { key: "value", name: "值 / Value" },
            ];
        const { columns } = event.table;
        return tableColumnKeys(columns).map((key, index) => ({ key, name: columns[index] ?? key }));
    }, [event.table]);
    const rows = useMemo(() => {
        const values = event.table?.rows ?? event.options?.map(({ label, value }) => [label, value]) ?? [];
        return values.map((cells, index) => ({ key: `row_${index + 1}`, cells }));
    }, [event]);
    const view = useTableView(rows, {
        scope: event.id,
        pageSize: 5,
        matches: (row, term) => row.cells.some((cell) => cell.toLowerCase().includes(term)),
    });
    return (
        <details data-testid="recording-options-preview" open>
            <summary>数据预览 / Preview · {rows.length}</summary>
            <DataTable label="采集预览 / Capture preview" searchLabel="搜索数据 / Search rows" view={view}>
                <div className="recording-capture-scroll">
                    <table>
                        <thead>
                            <tr>
                                {headers.map(({ key, name }) => (
                                    <th key={key} scope="col">
                                        {name}
                                        {event.table && ` · ${key}`}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {view.rows.map(({ key, cells }) => (
                                <tr key={key}>
                                    {headers.map((header, i) => (
                                        <td key={header.key}>{cells[i] || "（空 / Empty）"}</td>
                                    ))}
                                </tr>
                            ))}
                            {!view.rows.length && (
                                <tr>
                                    <td colSpan={Math.max(1, headers.length)}>无可见数据 / No visible rows</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </DataTable>
        </details>
    );
}

export function AnnotationDataPanel({ event, versions, matrixId, busy, saveOptions, bindColumn, cancel }: Props) {
    const available = useMemo(() => {
        if (event.action !== "bindColumn") return [];
        return versions.flatMap((version) => {
            if (version.content.kind !== "DATASET") return [];
            const columns = selectableColumns(version.content.document);
            return columns.length ? [{ version, columns }] : [];
        });
    }, [event.action, versions]);
    const [versionId, setVersionId] = useState(
        available.some(({ version }) => version.id === matrixId) ? matrixId : "",
    );
    const selected = available.find(({ version }) => version.id === versionId);
    const [column, setColumn] = useState("");
    const [name, setName] = useState("");
    const [createId] = useState(() => crypto.randomUUID());
    const [submitted, setSubmitted] = useState(false);
    const nameInput = useRef<HTMLInputElement>(null);
    const versionInput = useRef<HTMLSelectElement>(null);
    useEffect(() => {
        (nameInput.current ?? versionInput.current)?.focus();
    }, []);
    const count = event.table?.rows.length ?? event.options?.length ?? 0;

    return (
        <section className="panel">
            <fieldset disabled={busy}>
                {event.action !== "bindColumn" ? (
                    <>
                        <legend>保存为数据集 / Save as dataset</legend>
                        <label>
                            {required}数据集名称 / Dataset name
                            <input
                                ref={nameInput}
                                data-testid="recording-options-name"
                                required
                                maxLength={160}
                                readOnly={submitted}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </label>
                        <CapturePreview event={event} />
                        <div className="header-actions">
                            <Button
                                data-testid="recording-options-save"
                                disabled={!name.trim() || !count}
                                onClick={(e) => {
                                    setSubmitted(true);
                                    saveOptions(name.trim(), createId, e.currentTarget);
                                }}
                            >
                                保存数据集草稿 / Save dataset draft
                            </Button>
                            <Button tone="secondary" onClick={cancel}>
                                取消 / Cancel
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <legend>用数据列选择下拉选项 / Select an option from a data column</legend>
                        <label>
                            {required}已发布的静态数据集 / Published static dataset
                            <select
                                ref={versionInput}
                                data-testid="recording-bind-version"
                                required
                                value={versionId}
                                onChange={(e) => {
                                    setVersionId(e.target.value);
                                    setColumn("");
                                }}
                            >
                                <option value="">选择版本 / Choose version</option>
                                {available.map(({ version }) => (
                                    <option key={version.id} value={version.id}>
                                        {version.name} · v{version.versionNo}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {available.length === 0 && (
                            <p role="status">
                                请先发布包含文本列的静态数据集，再刷新已发布版本。 / Publish a static dataset with a
                                text column and refresh published versions.
                            </p>
                        )}
                        <label>
                            {required}选项值列 / Option value column
                            <select
                                data-testid="recording-bind-column"
                                required
                                disabled={!selected}
                                value={column}
                                onChange={(e) => setColumn(e.target.value)}
                            >
                                <option value="">选择列 / Choose column</option>
                                {selected?.columns.map((key) => (
                                    <option key={key} value={key}>
                                        {key}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <div className="header-actions">
                            <Button
                                data-testid="recording-bind-apply"
                                disabled={!selected?.columns.includes(column)}
                                onClick={() => {
                                    if (selected) bindColumn(selected.version, column);
                                }}
                            >
                                添加选择步骤 / Add selection step
                            </Button>
                            <Button tone="secondary" onClick={cancel}>
                                取消 / Cancel
                            </Button>
                        </div>
                    </>
                )}
            </fieldset>
        </section>
    );
}
