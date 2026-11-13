/**
 * 离线 Bundle 传输适配：Cloud 走 Workspace 作用域 HTTP，Local 委托桌面宿主窄桥。幂等键由页面每次导出新生成。
 * 下载禁止跟随跨源 redirect；超过 64MiB 拒绝以保护渲染进程内存。
 */

import type { PlatformComponents } from "@veriq/contracts";
import { request, ApiError, binaryRequest } from "../../api";
type S = PlatformComponents["schemas"];
/**
 * BundleDTO 别名：描述已签发离线包的元数据与下载句柄，不含明文凭证。下载前需确认用户有该空间权限；下载前必须确认当前用户具备该空间权限。
 * 列表与导出结果均返回此类型；实际字节流由 download 单独获取。
 */
export type Bundle = S["BundleDTO"];
/**
 * 视图可依赖的 Bundle 读写接口：list/export/download；凭证与验签留在宿主或服务端。Local 与 Cloud 必须保持方法签名一致。
 * export 必须传入幂等键，防止网络重试产生重复包。
 */
export interface BundleAdapter {
    /** 桌面安装操作把已发布包直接交给宿主下载与验签，不向渲染进程交付任意路径或归档字节；浏览器未提供此入口时仍沿用原有的显式文件下载流程。 */
    install?(id: string, signal?: AbortSignal): Promise<void>;
    list(
        cursor?: string,
        signal?: AbortSignal,
    ): Promise<{ items: Bundle[]; nextCursor: string | null }>;
    export(selection: S["BundleCreate"], key: string, signal?: AbortSignal): Promise<Bundle>;
    download(id: string, signal?: AbortSignal): Promise<Blob>;
}
/**
 * 构造时固定 workspaceId，路径 /workspaces/{id}/bundles；download 用 fetch+blob。
 * 401 时广播会话过期；过大 blob 抛 BUNDLE_TOO_LARGE。
 */
export class CloudBundleAdapter implements BundleAdapter {
    constructor(readonly workspaceId: string) {}
    private base() {
        return `/workspaces/${this.workspaceId}/bundles`;
    }
    list = (cursor?: string, signal?: AbortSignal) =>
        request<{ items: Bundle[]; nextCursor: string | null }>(
            this.base() + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
            "GET",
            undefined,
            signal,
        );
    export = (selection: S["BundleCreate"], key: string, signal?: AbortSignal) =>
        request<Bundle>(this.base(), "POST", selection, signal, {
            "Idempotency-Key": key,
        });
    async download(id: string, signal?: AbortSignal) {
        const response = await binaryRequest(
            `${this.base()}/${encodeURIComponent(id)}/download`,
            signal,
        );
        if (!response.ok) {
            const body = await response.json();
            if (response.status === 401) window.dispatchEvent(new Event("veriq:session-expired"));
            throw new ApiError(body.code, body.message, response.status, body.requestId);
        }
        const blob = await response.blob();
        if (blob.size > 64 * 1024 * 1024) throw new Error("BUNDLE_TOO_LARGE");
        return blob;
    }
}
/**
 * 桌面宿主提供的窄桥包装：渲染进程不直接读密钥或任意 IPC，仅转发 BundleAdapter 方法。不在此层做大小二次截断。
 * 验签与凭证保留在 main；本类不做额外缓存。
 */
export class LocalBundleAdapter implements BundleAdapter {
    constructor(private host: BundleAdapter) {}
    list = (cursor?: string, signal?: AbortSignal) => this.host.list(cursor, signal);
    export = (selection: S["BundleCreate"], key: string, signal?: AbortSignal) =>
        this.host.export(selection, key, signal);
    download = (id: string, signal?: AbortSignal) => this.host.download(id, signal);
}
