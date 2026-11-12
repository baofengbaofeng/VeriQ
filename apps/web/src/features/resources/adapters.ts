import type {
  FileEntry,
  PlatformComponents,
  ResourceDocumentV1,
  ResourceKind,
} from "@veriq/contracts";
import { request, ApiError } from "../../api";
type S = PlatformComponents["schemas"];
export type Resource = S["ResourceDTO"];
export type Draft = S["DraftDTO"];
export type Version = S["ResourceVersionDTO"];
export type Job = S["JobDTO"];
export type Receipt = S["ValidationReceiptDTO"];
export type Page<T> = { items: T[]; nextCursor: string | null };
export type SourceFiles = S["CompiledSourceDTO"];
/** Views consume only this interface. Transport, credentials and signed-snapshot trust belong to the host. */
export interface ResourceAdapter {
  readonly readOnly: boolean;
  list(
    kind?: ResourceKind,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Resource>>;
  draft(resourceId: string, signal?: AbortSignal): Promise<Draft>;
  versions(
    resourceId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Version>>;
  dependents(
    resourceId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Resource>>;
  sourceFiles(
    resourceId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<SourceFiles>;
  source(
    resourceId: string,
    versionId: string,
    file: FileEntry,
    signal?: AbortSignal,
  ): Promise<string>;
  create(data: S["ResourceCreate"], signal?: AbortSignal): Promise<Resource>;
  save(
    resourceId: string,
    data: S["DraftWrite"],
    signal?: AbortSignal,
  ): Promise<Draft>;
  update(
    resourceId: string,
    data: S["ResourceUpdate"],
    signal?: AbortSignal,
  ): Promise<Resource>;
  preview(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<S["ValidationPreviewDTO"]>;
  validate(
    resourceId: string,
    data: S["ValidationRequest"],
    signal?: AbortSignal,
  ): Promise<Job>;
  job(jobId: string, signal?: AbortSignal): Promise<Job>;
  receipt(jobId: string, signal?: AbortSignal): Promise<Receipt>;
  publish(
    resourceId: string,
    data: S["PublishRequest"],
    signal?: AbortSignal,
  ): Promise<Version>;
}
const query = (values: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v) p.set(k, v);
  return p.size ? "?" + p.toString() : "";
};
export class CloudResourceAdapter implements ResourceAdapter {
  readonly readOnly = false;
  constructor(readonly workspaceId: string) {}
  private base(id = "") {
    return `/workspaces/${this.workspaceId}/resources${id ? "/" + encodeURIComponent(id) : ""}`;
  }
  list = (kind?: ResourceKind, cursor?: string, signal?: AbortSignal) =>
    request<Page<Resource>>(
      this.base() + query({ kind, cursor }),
      "GET",
      undefined,
      signal,
    );
  draft = (id: string, signal?: AbortSignal) =>
    request<Draft>(this.base(id) + "/draft", "GET", undefined, signal);
  versions = (id: string, cursor?: string, signal?: AbortSignal) =>
    request<Page<Version>>(
      this.base(id) + "/versions" + query({ cursor }),
      "GET",
      undefined,
      signal,
    );
  dependents = (id: string, cursor?: string, signal?: AbortSignal) =>
    request<Page<Resource>>(
      this.base(id) + "/dependents" + query({ cursor }),
      "GET",
      undefined,
      signal,
    );
  sourceFiles = (id: string, versionId: string, signal?: AbortSignal) =>
    request<SourceFiles>(
      this.base(id) +
        "/versions/" +
        encodeURIComponent(versionId) +
        "/compiled-source",
      "GET",
      undefined,
      signal,
    );
  source = async (
    id: string,
    versionId: string,
    file: FileEntry,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      "/api/v1" +
        this.base(id) +
        "/versions/" +
        encodeURIComponent(versionId) +
        "/compiled-source" +
        query({ path: file.path }),
      { credentials: "same-origin", signal },
    );
    if (!response.ok) {
      const body = await response.json();
      if (response.status === 401)
        window.dispatchEvent(new Event("veriq:session-expired"));
      throw new ApiError(
        body.code,
        body.message,
        response.status,
        body.requestId,
      );
    }
    const bytes = await response.arrayBuffer();
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (bytes.byteLength !== file.sizeBytes || digest !== file.sha256)
      throw new Error(
        "INVALID_ARTIFACT: generated source bytes differ from descriptor",
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  create = (data: S["ResourceCreate"], signal?: AbortSignal) =>
    request<Resource>(this.base(), "POST", data, signal);
  save = (id: string, data: S["DraftWrite"], signal?: AbortSignal) =>
    request<Draft>(this.base(id) + "/draft", "PUT", data, signal);
  update = (id: string, data: S["ResourceUpdate"], signal?: AbortSignal) =>
    request<Resource>(this.base(id), "PATCH", data, signal);
  preview = (id: string, signal?: AbortSignal) =>
    request<S["ValidationPreviewDTO"]>(
      this.base(id) + "/validation-preview",
      "GET",
      undefined,
      signal,
    );
  validate = (id: string, data: S["ValidationRequest"], signal?: AbortSignal) =>
    request<Job>(this.base(id) + "/validate", "POST", data, signal);
  job = (id: string, signal?: AbortSignal) =>
    request<Job>(
      `/workspaces/${this.workspaceId}/jobs/${id}`,
      "GET",
      undefined,
      signal,
    );
  receipt = (id: string, signal?: AbortSignal) =>
    request<Receipt>(
      `/workspaces/${this.workspaceId}/jobs/${id}/validation-receipt`,
      "GET",
      undefined,
      signal,
    );
  publish = (id: string, data: S["PublishRequest"], signal?: AbortSignal) =>
    request<Version>(this.base(id) + "/publish", "POST", data, signal);
}
export type LocalResourceSnapshot = {
  workspaceId: string;
  resources: Resource[];
  versions: Version[];
  /** Host-verified DSL-only candidates; updatedAt denotes snapshot freeze time. */
  drafts?: Draft[];
  sourceFiles: Record<string, SourceFiles>;
  readSource: (
    versionId: string,
    file: FileEntry,
    signal?: AbortSignal,
  ) => Promise<string>;
};
/** Trusted host/provider must verify the signed bundle before constructing this adapter.
 * This class does not authenticate untrusted bundles or confer trust via a boolean flag. */
export class LocalResourceAdapter implements ResourceAdapter {
  readonly readOnly = true;
  private snapshot: LocalResourceSnapshot;
  constructor(snapshot: LocalResourceSnapshot) {
    if (
      snapshot.resources.some((r) => r.workspaceId !== snapshot.workspaceId) ||
      snapshot.versions.some(
        (v) =>
          v.workspaceId !== snapshot.workspaceId ||
          !snapshot.resources.some((r) => r.id === v.resourceId),
      )
    )
      throw new Error("SNAPSHOT_WORKSPACE_MISMATCH");
    this.snapshot = {
      ...structuredClone({
        workspaceId: snapshot.workspaceId,
        resources: snapshot.resources,
        versions: snapshot.versions,
        drafts: snapshot.drafts,
        sourceFiles: snapshot.sourceFiles,
      }),
      readSource: snapshot.readSource,
    };
  }
  private check(signal?: AbortSignal) {
    signal?.throwIfAborted();
  }
  list = async (
    kind?: ResourceKind,
    _cursor?: string,
    signal?: AbortSignal,
  ) => {
    this.check(signal);
    return {
      items: structuredClone(
        this.snapshot.resources.filter((r) => !kind || r.kind === kind),
      ),
      nextCursor: null,
    };
  };
  draft = async (id: string, signal?: AbortSignal): Promise<Draft> => {
    this.check(signal);
    const frozen = this.snapshot.drafts?.find(d => d.resourceId === id);
    if (frozen) return structuredClone(frozen);
    const resource = this.snapshot.resources.find((r) => r.id === id);
    const v = this.snapshot.versions.find(
      (v) => v.id === resource?.latestVersionId && v.resourceId === id,
    );
    if (!v) throw new Error("SNAPSHOT_VERSION_NOT_FOUND");
    return {
      resourceId: id,
      revision: v.versionNo,
      content: structuredClone(v.content),
      updatedAt: v.publishedAt,
      documentHash: v.sha256,
    };
  };
  versions = async (id: string, _cursor?: string, signal?: AbortSignal) => {
    this.check(signal);
    return {
      items: structuredClone(
        this.snapshot.versions.filter((v) => v.resourceId === id),
      ),
      nextCursor: null,
    };
  };
  dependents = async (id: string, _cursor?: string, signal?: AbortSignal) => {
    this.check(signal);
    const ids = new Set(
      this.snapshot.versions
        .filter((v) => v.resourceId === id)
        .map((v) => v.id),
    );
    const referenced = (content: ResourceDocumentV1): boolean => {
      const doc = content.document;
      const refs: string[] = [];
      if (content.kind === "CASE")
        refs.push(
          content.document.catalogVersionId,
          content.document.fixtureVersionId ?? "",
          content.document.datasetVersionId ?? "",
        );
      if (content.kind === "SUITE")
        for (const c of content.document.cases)
          refs.push(c.versionId, c.datasetVersionId ?? "");
      const assertions = "assertions" in doc ? [...doc.assertions] : [];
      if ("steps" in doc)
        for (const step of doc.steps) {
          if (step.action === "callFlow") refs.push(step.versionId);
          assertions.push(
            ...(step.beforeAssertions ?? []),
            ...(step.afterAssertions ?? []),
          );
        }
      for (const a of assertions)
        if (a.type === "template") refs.push(a.versionId);
      return refs.some((ref) => ids.has(ref));
    };
    return {
      items: structuredClone(
        this.snapshot.resources.filter((r) =>
          this.snapshot.versions.some(
            (v) =>
              v.resourceId === r.id &&
              referenced(v.content as ResourceDocumentV1),
          ),
        ),
      ),
      nextCursor: null,
    };
  };
  sourceFiles = async (id: string, version: string, signal?: AbortSignal) => {
    this.check(signal);
    this.requireVersion(id, version);
    const files = this.snapshot.sourceFiles[version];
    if (!files) throw new Error("SOURCE_NOT_AVAILABLE");
    return structuredClone(files);
  };
  source = async (
    id: string,
    version: string,
    file: FileEntry,
    signal?: AbortSignal,
  ) => {
    this.check(signal);
    this.requireVersion(id, version);
    const member = this.snapshot.sourceFiles[version]?.files.find(
      (f) =>
        f.path === file.path &&
        f.sha256 === file.sha256 &&
        f.sizeBytes === file.sizeBytes,
    );
    if (!member) throw new Error("SOURCE_NOT_AVAILABLE");
    return this.snapshot.readSource(version, structuredClone(member), signal);
  };
  private requireVersion(id: string, version: string) {
    if (
      !this.snapshot.versions.some(
        (v) => v.resourceId === id && v.id === version,
      )
    )
      throw new Error("SNAPSHOT_VERSION_NOT_FOUND");
  }
  private denied = async (): Promise<never> => {
    throw new Error("LOCAL_SNAPSHOT_READ_ONLY");
  };
  create = this.denied;
  save = this.denied;
  update = this.denied;
  preview = this.denied;
  validate = this.denied;
  job = this.denied;
  receipt = this.denied;
  publish = this.denied;
}
