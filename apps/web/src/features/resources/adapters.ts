/**
 * 资源草稿/版本/校验/发布适配：Cloud 绑定 Workspace HTTP，Local 消费宿主已验签快照。发布后版本不可变。
 * 生成的 TS 源码按 sha256/size 校验；视图只依赖 ResourceAdapter 接口。
 */

import type {
    FileEntry,
    PlatformComponents,
    ResourceDocumentV1,
    ResourceKind,
} from "@veriq/contracts";
import { request, ApiError } from "../../api";
type S = PlatformComponents["schemas"];
/**
 * ResourceDTO：空间内资源元数据（kind/key/归档状态），列表与依赖图节点共用。key 在空间内唯一；resource key 在同一 Workspace 内必须唯一。
 * workspaceId 必须与适配器一致；归档后只读除非 restore。
 */
export type Resource = S["ResourceDTO"];
/**
 * DraftDTO：可编辑 DSL 文档与 revision；保存冲突时保留本地内容并提示采用远端修订号。revision 用于乐观并发控制。
 * 校验/发布前必须已保存；JSON 模式未 apply 时禁止提交。
 */
export type Draft = S["DraftDTO"];
/**
 * ResourceVersionDTO：不可变已发布版本，含内容摘要与编译产物描述符。content 摘要供差异预览；content 摘要只用于版本差异预览不写回。
 * sourceFiles/source 只读打开生成 TS；不可在此接口回写。
 */
export type Version = S["ResourceVersionDTO"];
/**
 * JobDTO：托管 Runtime 上的编译校验作业状态；queued 不代表通过。轮询间隔由编辑器控制；queued 状态绝不表示编译校验已经通过。
 * 轮询 job() 直至完成再取 receipt。
 */
export type Job = S["JobDTO"];
/**
 * ValidationReceiptDTO：校验通过/失败的结构化回执，驱动编辑器诊断列表。诊断列表按严重级别排序展示；诊断条目按严重级别排序后呈现给编辑者。
 * 发布围栏依赖成功回执；失败不得 publish。
 */
export type Receipt = S["ValidationReceiptDTO"];
/**
 * 游标分页信封 {items,nextCursor}，资源列表/版本/依赖共用此泛型形状。items 可为异构 ResourceDTO。
 * nextCursor 为空表示没有更多页。
 */
export type Page<T> = { items: T[]; nextCursor: string | null };
/**
 * CompiledSourceDTO：已发布版本的生成文件清单（path/size/sha256），供 Monaco 只读打开。
 * 实际字节经 source() 下载并校验摘要。
 */
export type SourceFiles = S["CompiledSourceDTO"];
/**
 * 编辑器可依赖的唯一资源接口；传输、凭证与签名快照信任由宿主实现。readOnly 由实现类固定；readOnly 标志由 Cloud/Local 实现类写死。
 * readOnly=true 时禁止 create/save/validate/publish。
 */
export interface ResourceAdapter {
    readonly readOnly: boolean;
    list(kind?: ResourceKind, cursor?: string, signal?: AbortSignal): Promise<Page<Resource>>;
    draft(resourceId: string, signal?: AbortSignal): Promise<Draft>;
    versions(resourceId: string, cursor?: string, signal?: AbortSignal): Promise<Page<Version>>;
    dependents(resourceId: string, cursor?: string, signal?: AbortSignal): Promise<Page<Resource>>;
    sourceFiles(resourceId: string, versionId: string, signal?: AbortSignal): Promise<SourceFiles>;
    source(
        resourceId: string,
        versionId: string,
        file: FileEntry,
        signal?: AbortSignal,
    ): Promise<string>;
    create(data: S["ResourceCreate"], signal?: AbortSignal): Promise<Resource>;
    save(resourceId: string, data: S["DraftWrite"], signal?: AbortSignal): Promise<Draft>;
    update(resourceId: string, data: S["ResourceUpdate"], signal?: AbortSignal): Promise<Resource>;
    preview(resourceId: string, signal?: AbortSignal): Promise<S["ValidationPreviewDTO"]>;
    validate(resourceId: string, data: S["ValidationRequest"], signal?: AbortSignal): Promise<Job>;
    job(jobId: string, signal?: AbortSignal): Promise<Job>;
    receipt(jobId: string, signal?: AbortSignal): Promise<Receipt>;
    publish(resourceId: string, data: S["PublishRequest"], signal?: AbortSignal): Promise<Version>;
}
const query = (values: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v) p.set(k, v);
    return p.size ? "?" + p.toString() : "";
};
/**
 * 路径 /workspaces/{id}/resources* 与 jobs；source 下载后做 SHA-256 与大小核对。
 * 构造固定 workspaceId，杜绝跨空间草稿读写。
 */
export class CloudResourceAdapter implements ResourceAdapter {
    readonly readOnly = false;
    constructor(readonly workspaceId: string) {}
    private base(id = "") {
        return `/workspaces/${this.workspaceId}/resources${id ? "/" + encodeURIComponent(id) : ""}`;
    }
    list = (kind?: ResourceKind, cursor?: string, signal?: AbortSignal) =>
        request<Page<Resource>>(this.base() + query({ kind, cursor }), "GET", undefined, signal);
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
            this.base(id) + "/versions/" + encodeURIComponent(versionId) + "/compiled-source",
            "GET",
            undefined,
            signal,
        );
    source = async (id: string, versionId: string, file: FileEntry, signal?: AbortSignal) => {
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
            if (response.status === 401) window.dispatchEvent(new Event("veriq:session-expired"));
            throw new ApiError(body.code, body.message, response.status, body.requestId);
        }
        const bytes = await response.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        if (bytes.byteLength !== file.sizeBytes || digest !== file.sha256)
            throw new Error("INVALID_ARTIFACT: generated source bytes differ from descriptor");
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
        request<Job>(`/workspaces/${this.workspaceId}/jobs/${id}`, "GET", undefined, signal);
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
/**
 * 桌面离线快照：resources/versions/可选 drafts 与 sourceFiles，外加宿主 readSource 回调。
 * drafts 的 updatedAt 表示冻结时间；宿主须先验签再构造适配器。
 */
export type LocalResourceSnapshot = {
    workspaceId: string;
    resources: Resource[];
    versions: Version[];
    /** Host-verified DSL-only candidates; updatedAt denotes snapshot freeze time. */
    drafts?: Draft[];
    sourceFiles: Record<string, SourceFiles>;
    readSource: (versionId: string, file: FileEntry, signal?: AbortSignal) => Promise<string>;
};
/**
 * 只读 ResourceAdapter：校验快照内 workspaceId 一致，写方法抛错或空操作。sourceFiles 键为 versionId。
 * source 委托 snapshot.readSource；不可变版本列表供差异视图使用。
 */
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
    list = async (kind?: ResourceKind, _cursor?: string, signal?: AbortSignal) => {
        this.check(signal);
        return {
            items: structuredClone(this.snapshot.resources.filter((r) => !kind || r.kind === kind)),
            nextCursor: null,
        };
    };
    draft = async (id: string, signal?: AbortSignal): Promise<Draft> => {
        this.check(signal);
        const frozen = this.snapshot.drafts?.find((d) => d.resourceId === id);
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
            items: structuredClone(this.snapshot.versions.filter((v) => v.resourceId === id)),
            nextCursor: null,
        };
    };
    dependents = async (id: string, _cursor?: string, signal?: AbortSignal) => {
        this.check(signal);
        const ids = new Set(
            this.snapshot.versions.filter((v) => v.resourceId === id).map((v) => v.id),
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
            for (const a of assertions) if (a.type === "template") refs.push(a.versionId);
            return refs.some((ref) => ids.has(ref));
        };
        return {
            items: structuredClone(
                this.snapshot.resources.filter((r) =>
                    this.snapshot.versions.some(
                        (v) => v.resourceId === r.id && referenced(v.content as ResourceDocumentV1),
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
    source = async (id: string, version: string, file: FileEntry, signal?: AbortSignal) => {
        this.check(signal);
        this.requireVersion(id, version);
        const member = this.snapshot.sourceFiles[version]?.files.find(
            (f) =>
                f.path === file.path && f.sha256 === file.sha256 && f.sizeBytes === file.sizeBytes,
        );
        if (!member) throw new Error("SOURCE_NOT_AVAILABLE");
        return this.snapshot.readSource(version, structuredClone(member), signal);
    };
    private requireVersion(id: string, version: string) {
        if (!this.snapshot.versions.some((v) => v.resourceId === id && v.id === version))
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
