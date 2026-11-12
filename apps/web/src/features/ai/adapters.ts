/**
 * AI 功能适配：在 Workspace 下管理 Provider、预览上下文、发起生成与审核/取消。无模型凭证时连接测试应失败关闭。
 * Cloud 前缀 /workspaces/{id}/ai；生成结果永不自动发布到资源草稿。
 */

import type { PlatformComponents } from "@veriq/contracts";
import { request } from "../../api";
type S = PlatformComponents["schemas"];
/**
 * ProviderDTO：模型端点、预算与单价配置摘要；密钥仅服务端持有，前端只见脱敏字段。月度预算字段单位为美元；月度预算字段以美元计且密钥永不下发前端。
 * save/test 经 AiAdapter；禁用后不得再发起新的 generation。
 */
export type Provider = S["ProviderDTO"];
/**
 * GenerationDTO：一次生成的状态、预算预留与诊断；历史分页与详情共用此形状。取消会释放未消费的预算预留；取消操作会释放尚未消费完的预算预留额度。
 * 审核/取消会写回同一 DTO；UI 不得把输出直接写入 Resource 发布路径。
 */
export type Generation = S["GenerationDTO"];
/**
 * 发起预览或生成的请求体：目标资源版本、提示与隐私过滤后的上下文引用。禁止附带原始 Trace 或截图字节；请求体禁止夹带原始 Trace 或截图二进制。
 * preview 返回 AiContextDTO；generate 创建持久 Generation 并占用月度预算。
 */
export type GenerationRequest = S["GenerationRequest"];
/**
 * AI 页与桌面宿主共用的接口：providers/save/test/preview/generate/history/review/cancel。
 * resource() 用于解析所选资源元数据；密钥读写不在此接口暴露。
 */
export interface AiAdapter {
    resource(id: string, signal?: AbortSignal): Promise<S["ResourceDTO"]>;
    providers(
        cursor?: string,
        signal?: AbortSignal,
    ): Promise<S["ProviderDTOPageEnvelope"]["data"]>;
    save(
        data: S["ProviderWrite"],
        id?: string,
        signal?: AbortSignal,
    ): Promise<Provider>;
    remove(id: string, signal?: AbortSignal): Promise<unknown>;
    test(
        id: string,
        requestId: string,
        signal?: AbortSignal,
    ): Promise<Generation>;
    preview(
        data: GenerationRequest,
        signal?: AbortSignal,
    ): Promise<S["AiContextDTO"]>;
    generate(data: GenerationRequest, signal?: AbortSignal): Promise<Generation>;
    history(
        cursor?: string,
        signal?: AbortSignal,
    ): Promise<S["GenerationDTOPageEnvelope"]["data"]>;
    get(id: string, signal?: AbortSignal): Promise<Generation>;
    review(
        id: string,
        data: S["GenerationReview"],
        signal?: AbortSignal,
    ): Promise<Generation>;
    cancel(id: string, signal?: AbortSignal): Promise<Generation>;
}
/**
 * HTTP 实现：所有路径嵌入构造时的 workspaceId，防止跨空间读写 Provider 或 Generation。
 * connection-tests 与 generations 均走 POST；删除 Provider 用 DELETE。
 */
export class CloudAiAdapter implements AiAdapter {
    constructor(readonly workspaceId: string) {}
    resource = (id: string, signal?: AbortSignal) =>
        request<S["ResourceDTO"]>(
            "/workspaces/" + this.workspaceId + "/resources/" + id,
            "GET",
            undefined,
            signal,
        );
    private base = () => "/workspaces/" + this.workspaceId + "/ai";
    providers = (cursor?: string, signal?: AbortSignal) =>
        request<S["ProviderDTOPageEnvelope"]["data"]>(
            this.base() +
                "/providers" +
                (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            "GET",
            undefined,
            signal,
        );
    save = (data: S["ProviderWrite"], id?: string, signal?: AbortSignal) =>
        request<Provider>(
            this.base() + "/providers" + (id ? "/" + id : ""),
            id ? "PUT" : "POST",
            data,
            signal,
        );
    remove = (id: string, signal?: AbortSignal) =>
        request(this.base() + "/providers/" + id, "DELETE", undefined, signal);
    test = (id: string, requestId: string, signal?: AbortSignal) =>
        request<Generation>(
            this.base() + "/providers/" + id + "/connection-tests",
            "POST",
            { requestId },
            signal,
        );
    preview = (data: GenerationRequest, signal?: AbortSignal) =>
        request<S["AiContextDTO"]>(this.base() + "/context", "POST", data, signal);
    generate = (data: GenerationRequest, signal?: AbortSignal) =>
        request<Generation>(this.base() + "/generations", "POST", data, signal);
    history = (cursor?: string, signal?: AbortSignal) =>
        request<S["GenerationDTOPageEnvelope"]["data"]>(
            this.base() +
                "/generations" +
                (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            "GET",
            undefined,
            signal,
        );
    get = (id: string, signal?: AbortSignal) =>
        request<Generation>(
            this.base() + "/generations/" + id,
            "GET",
            undefined,
            signal,
        );
    review = (id: string, data: S["GenerationReview"], signal?: AbortSignal) =>
        request<Generation>(
            this.base() + "/generations/" + id + "/review",
            "POST",
            data,
            signal,
        );
    cancel = (id: string, signal?: AbortSignal) =>
        request<Generation>(
            this.base() + "/generations/" + id + "/cancel",
            "POST",
            undefined,
            signal,
        );
}
/**
 * 把桌面可信 typed bridge 适配为 AiAdapter；渲染层不读密钥、不发起任意 IPC。桥接错误原样上抛给 Notice。
 * 方法一一委托 bridge，便于 AiWorkspaceView 在 Web/Desktop 间切换。
 */
export class LocalAiAdapter implements AiAdapter {
    constructor(private readonly bridge: AiAdapter) {}
    resource: AiAdapter["resource"] = (...args) => this.bridge.resource(...args);
    providers: AiAdapter["providers"] = (...args) =>
        this.bridge.providers(...args);
    save: AiAdapter["save"] = (...args) => this.bridge.save(...args);
    remove: AiAdapter["remove"] = (...args) => this.bridge.remove(...args);
    test: AiAdapter["test"] = (...args) => this.bridge.test(...args);
    preview: AiAdapter["preview"] = (...args) => this.bridge.preview(...args);
    generate: AiAdapter["generate"] = (...args) => this.bridge.generate(...args);
    history: AiAdapter["history"] = (...args) => this.bridge.history(...args);
    get: AiAdapter["get"] = (...args) => this.bridge.get(...args);
    review: AiAdapter["review"] = (...args) => this.bridge.review(...args);
    cancel: AiAdapter["cancel"] = (...args) => this.bridge.cancel(...args);
}
