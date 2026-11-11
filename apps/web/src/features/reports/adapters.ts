import type { PlatformComponents } from "@veriq/contracts";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { request, streamRequest } from "../../api";
type S = PlatformComponents["schemas"];
export type RunReport = S["RunReportDTO"];
export type ReportEvent = S["ReportEventDTO"];
export type ReportArtifact = S["ReportArtifactDTO"];
export type ReportDisplay = S["ReportDisplayDTO"];
export interface ReportAdapter {
  readonly readOnly: boolean;
  list(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<S["RunDTOPageEnvelope"]["data"]>;
  report(runId: string, signal?: AbortSignal): Promise<RunReport>;
  display(
    runId: string,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<ReportDisplay>;
  history(
    attemptId: string,
    after: number,
    signal?: AbortSignal,
  ): Promise<S["ReportHistoryDTO"]>;
  artifacts(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<S["ReportArtifactsDTO"]>;
  download(
    attemptId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<Blob>;
  audit(after?: string, signal?: AbortSignal): Promise<S["ReportAuditDTO"]>;
  subscribe(
    runId: string,
    receive: (report: RunReport) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
export class CloudReportAdapter implements ReportAdapter {
  readonly readOnly = false;
  constructor(readonly workspaceId: string) {}
  private base = () => `/workspaces/${this.workspaceId}`;
  list = (cursor?: string, signal?: AbortSignal) =>
    request<S["RunDTOPageEnvelope"]["data"]>(
      this.base() +
        "/runs" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      "GET",
      undefined,
      signal,
    );
  report = (id: string, signal?: AbortSignal) =>
    request<RunReport>(
      this.base() + `/runs/${id}/report`,
      "GET",
      undefined,
      signal,
    );
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
      this.base() +
        "/audit" +
        (after ? "?after=" + encodeURIComponent(after) : ""),
      "GET",
      undefined,
      signal,
    );
  async download(attemptId: string, artifactId: string, signal?: AbortSignal) {
    const response = await fetch(
      "/api/v1" +
        this.base() +
        `/attempts/${attemptId}/artifacts/${artifactId}`,
      { credentials: "same-origin", signal },
    );
    if (!response.ok) throw new Error((await response.json()).message);
    return response.blob();
  }
  async subscribe(
    runId: string,
    receive: (report: RunReport) => void,
    signal: AbortSignal,
  ) {
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
/** Host-verified immutable snapshot. Signature verification and raw-byte authorization belong to the host. */
export interface LocalReportSnapshot {
  workspaceId: string;
  reports: RunReport[];
  history: Record<string, ReportEvent[]>;
  displays?: Record<string, ReportDisplay>;
  artifacts: Record<string, ReportArtifact[]>;
}
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
    if (
      this.snapshot.reports.some(
        (report) => report.run.workspaceId !== snapshot.workspaceId,
      )
    )
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
    if (
      Object.keys(this.snapshot.displays ?? {}).some((id) => !attempts.has(id))
    )
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
  display = async (
    runId: string,
    attemptId: string,
  ): Promise<ReportDisplay> => {
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
    const rows = (this.snapshot.history[id] ?? []).filter(
      (e) => e.sequence > after,
    );
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
  download = async (
    attempt: string,
    artifact: string,
    signal?: AbortSignal,
  ) => {
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
