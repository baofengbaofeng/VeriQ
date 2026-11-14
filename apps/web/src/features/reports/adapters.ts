/**
 * 报告适配：Cloud 拉 runs/report/history/artifacts 并 SSE 订阅；Local 只读宿主已验签快照。
 * 原始证据下载仍受 Workspace 角色约束；脱敏展示字段由 display 接口提供。
 */

import type { PlatformComponents } from "@veriq/contracts";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { request, streamRequest, binaryRequest } from "../../api";
type S = PlatformComponents["schemas"];
/**
 * RunReportDTO：某次 Run 的汇总门禁、用例结果与当前 Attempt 指针，供报告头与列表共用。门禁字段区分执行时与当前。
 * subscribe 推送的也是此类型；workspaceId 必须与适配器作用域一致。
 */
export type RunReport = S["RunReportDTO"];
/**
 * ReportEventDTO：Attempt 时间线中的步骤/断言/网络事件，用于增量 history 渲染。序号必须单调递增消费。
 * after 序号分页；缺失值可能因脱敏显示为 withheld。
 */
export type ReportEvent = S["ReportEventDTO"];
/**
 * ReportArtifactDTO：截图/Trace 等证据元数据；download 另取 Blob，不把原始字节放进 React state。
 * 受限证据仅 Owner/Admin 可取；失败时表面错误而非空文件。
 */
export type ReportArtifact = S["ReportArtifactDTO"];
/**
 * ReportDisplayDTO：历史标签与脱敏后的展示投影，避免 UI 直接解析含凭证的原始 Trace。缺失标签时 UI 显示占位文案。
 * labels 不可用时 ReportView 显示 labelsAbsent 提示。
 */
export type ReportDisplay = S["ReportDisplayDTO"];
/**
 * 报告视图契约：list/report/display/history/artifacts/download/audit/subscribe 与 readOnly 标志。
 * Cloud 可写订阅；Local 只读且 download 依赖宿主 readRaw。
 */
export interface ReportAdapter {
    readonly readOnly: boolean;
    /** 桌面原始证据在宿主完成授权、校验与保存或本机查看，这个可选入口避免敏感字节经过渲染进程；普通 Web 适配器不实现它时继续保持现有 Blob 下载行为。 */
    nativeArtifact?(
        attemptId: string,
        artifactId: string,
        action: "save" | "trace" | "preview",
        signal?: AbortSignal,
    ): Promise<void>;
    list(cursor?: string, signal?: AbortSignal): Promise<S["RunDTOPageEnvelope"]["data"]>;
    report(runId: string, signal?: AbortSignal): Promise<RunReport>;
    display(runId: string, attemptId: string, signal?: AbortSignal): Promise<ReportDisplay>;
    history(attemptId: string, after: number, signal?: AbortSignal): Promise<S["ReportHistoryDTO"]>;
    artifacts(attemptId: string, signal?: AbortSignal): Promise<S["ReportArtifactsDTO"]>;
    download(attemptId: string, artifactId: string, signal?: AbortSignal): Promise<Blob>;
    audit(after?: string, signal?: AbortSignal): Promise<S["ReportAuditDTO"]>;
    subscribe(
        runId: string,
        receive: (report: RunReport) => void,
        signal: AbortSignal,
    ): Promise<void>;
}
/**
 * Workspace 作用域 HTTP+SSE：streamRequest 解析 report 事件，authorization 事件则抛错要求重载。
 * download 用 same-origin fetch；audit 支持 after 游标。
 */
export class CloudReportAdapter implements ReportAdapter {
    readonly readOnly = false;
    constructor(readonly workspaceId: string) {}
    private base = () => `/workspaces/${this.workspaceId}`;
    list = (cursor?: string, signal?: AbortSignal) =>
        request<S["RunDTOPageEnvelope"]["data"]>(
            this.base() + "/runs" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            "GET",
            undefined,
            signal,
        );
    report = (id: string, signal?: AbortSignal) =>
        request<RunReport>(this.base() + `/runs/${id}/report`, "GET", undefined, signal);
    display = (runId: string, attemptId: string, signal?: AbortSignal) =>
        request<ReportDisplay>(
            this.base() + `/runs/${runId}/attempts/${attemptId}/display`,
            "GET",
            undefined,
            signal,
        );
    history = (id: string, after: number, signal?: AbortSignal) =>
        request<S["ReportHistoryDTO"]>(
            this.base() + `/attempts/${id}/history?after=${after}`,
            "GET",
            undefined,
            signal,
        );
    artifacts = (id: string, signal?: AbortSignal) =>
        request<S["ReportArtifactsDTO"]>(
            this.base() + `/attempts/${id}/artifacts`,
            "GET",
            undefined,
            signal,
        );
    audit = (after?: string, signal?: AbortSignal) =>
        request<S["ReportAuditDTO"]>(
            this.base() + "/audit" + (after ? "?after=" + encodeURIComponent(after) : ""),
            "GET",
            undefined,
            signal,
        );
    async download(attemptId: string, artifactId: string, signal?: AbortSignal) {
        const response = await binaryRequest(
            this.base() + `/attempts/${attemptId}/artifacts/${artifactId}`,
            signal,
        );
        if (!response.ok) throw new Error((await response.json()).message);
        return response.blob();
    }
    async subscribe(runId: string, receive: (report: RunReport) => void, signal: AbortSignal) {
        let cursor: string | undefined;
        while (!signal.aborted) {
            const response = await streamRequest(
                this.base() + `/runs/${runId}/events/stream`,
                cursor ? { cursor } : {},
                signal,
            );
            if (!response.body) throw new Error("Report stream is unavailable.");
            const reader = response.body
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(
                    new EventSourceParserStream({
                        maxBufferSize: 32 * 1024 * 1024,
                        onError: "terminate",
                    }),
                )
                .getReader();
            try {
                while (!signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value.event === "authorization")
                        throw new Error(
                            "Report access changed. Reload after signing in or confirming Workspace access.",
                        );
                    if (value.event === "report") {
                        const update = JSON.parse(value.data) as { report: RunReport };
                        receive(update.report);
                        cursor = value.id;
                    }
                }
            } finally {
                await reader.cancel();
                reader.releaseLock();
            }
            if (!signal.aborted)
                await new Promise<void>((resolve, reject) => {
                    const abort = () => {
                        clearTimeout(timer);
                        reject(signal.reason);
                    };
                    const timer = setTimeout(() => {
                        signal.removeEventListener("abort", abort);
                        resolve();
                    }, 1000);
                    signal.addEventListener("abort", abort, { once: true });
                });
        }
    }
}
/**
 * 宿主验签后的不可变快照：reports/history/displays/artifacts，构造 LocalReportAdapter 前必须校验空间一致。
 * 原始字节授权与签名验证属于宿主，不在渲染进程重复实现。
 */
export interface LocalReportSnapshot {
    workspaceId: string;
    reports: RunReport[];
    history: Record<string, ReportEvent[]>;
    displays?: Record<string, ReportDisplay>;
    artifacts: Record<string, ReportArtifact[]>;
}
/**
 * 只读适配器：structuredClone 快照后按 attempt 提供 history/artifacts；跨空间条目构造即失败。
 * subscribe 为空操作或立即推送静态 report，避免桌面离线包误连云端流。
 */
export class LocalReportAdapter implements ReportAdapter {
    readonly readOnly = true;
    private readonly snapshot: LocalReportSnapshot;
    constructor(
        snapshot: LocalReportSnapshot,
        private readonly readRaw?: (
            attempt: string,
            artifact: string,
            signal?: AbortSignal,
        ) => Promise<Blob>,
    ) {
        this.snapshot = structuredClone(snapshot);
        if (this.snapshot.reports.some((report) => report.run.workspaceId !== snapshot.workspaceId))
            throw new Error("Foreign Workspace report");
        const attempts = new Set(
            this.snapshot.reports.flatMap((r) =>
                r.cases.flatMap((c) => c.attempts.map((a) => a.id)),
            ),
        );
        for (const [id, events] of Object.entries(this.snapshot.history)) {
            if (!attempts.has(id) || events.some((e) => e.attemptId !== id))
                throw new Error("Foreign Attempt history");
        }
        for (const [id, artifacts] of Object.entries(this.snapshot.artifacts)) {
            if (!attempts.has(id) || artifacts.some((a) => a.attemptId !== id))
                throw new Error("Foreign Attempt artifacts");
        }
        if (Object.keys(this.snapshot.displays ?? {}).some((id) => !attempts.has(id)))
            throw new Error("Foreign Attempt display");
    }
    private async found(id: string) {
        const report = this.snapshot.reports.find((r) => r.run.id === id);
        if (!report) throw new Error("Report not found");
        return structuredClone(report);
    }
    list = async () => ({
        items: this.snapshot.reports.map((r) => structuredClone(r.run)),
        nextCursor: null,
    });
    report = (id: string) => this.found(id);
    display = async (runId: string, attemptId: string): Promise<ReportDisplay> => {
        const report = await this.found(runId);
        if (!report.cases.some((c) => c.attempts.some((a) => a.id === attemptId)))
            throw new Error("Attempt not found in Run");
        return structuredClone(
            this.snapshot.displays?.[attemptId] ?? {
                display: null,
                metadataStatus: "ABSENT",
                environment: {},
            },
        );
    };
    history = async (id: string, after: number) => {
        const rows = (this.snapshot.history[id] ?? []).filter((e) => e.sequence > after);
        const items = structuredClone(rows.slice(0, 100));
        return {
            items,
            nextSequence: items.at(-1)?.sequence ?? after,
            hasMore: rows.length > 100,
        };
    };
    artifacts = async (id: string) => ({
        items: structuredClone(this.snapshot.artifacts[id] ?? []),
    });
    audit = async () => ({ items: [], nextCursor: null });
    download = async (attempt: string, artifact: string, signal?: AbortSignal) => {
        if (
            !this.readRaw ||
            !this.snapshot.artifacts[attempt]?.some(
                (a) => a.id === artifact && a.state === "AVAILABLE",
            )
        )
            throw new Error("Raw evidence requires host authorization.");
        return this.readRaw(attempt, artifact, signal);
    };
    subscribe = async (
        _id: string,
        _receive: (report: RunReport) => void,
        _signal: AbortSignal,
    ) => {};
}
