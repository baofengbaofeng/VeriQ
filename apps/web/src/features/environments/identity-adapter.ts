/**
 * 环境身份适配：Workspace 下 credentials 与 auth-adapters 的列表、创建、轮换与吊销。
 * CloudIdentityAdapter 路径均含 workspaceId；密钥仅出现在 POST 体并立即丢弃本地副本。
 */

import type {
    PlatformComponents,
    AuthAdapterConfigV1,
    JsonObject,
} from "@veriq/contracts";
import { request } from "../../api";
type S = PlatformComponents["schemas"];
/**
 * CredentialDTO 摘要：引用名、版本与允许身份，不含 secret 明文。列表分页 cursor 可选；列表通过可选 cursor 在 Workspace 内分页。
 * 列表展示与吊销目标均用此类型。
 */
export type CredentialSummary = S["CredentialDTO"];
/**
 * AuthAdapterDTO 摘要：适配器配置版本元数据，供环境字段下拉固定引用。configuration 已由服务端校验。
 * revoke 后不可再被新环境草稿引用。
 */
export type AdapterSummary = S["AuthAdapterDTO"];
/**
 * IdentityManager 依赖的接口：credentials/adapters/createAdapter/credential/revoke*。
 * 桌面可替换实现，但不得把密钥写入可序列化快照。
 */
export interface IdentityAdapter {
    credentials(
        cursor?: string,
        signal?: AbortSignal,
    ): Promise<S["CredentialListDTO"]>;
    adapters(
        cursor?: string,
        signal?: AbortSignal,
    ): Promise<S["AuthAdapterListDTO"]>;
    createAdapter(
        configuration: AuthAdapterConfigV1,
        signal?: AbortSignal,
    ): Promise<AdapterSummary>;
    revokeAdapter(id: string, signal?: AbortSignal): Promise<AdapterSummary>;
    credential(
        secretRef: string,
        value: JsonObject,
        allowedIdentityIds: string[],
        rotate: boolean,
        signal?: AbortSignal,
    ): Promise<CredentialSummary>;
    revokeCredential(
        ref: string,
        id: string,
        signal?: AbortSignal,
    ): Promise<CredentialSummary>;
}
/**
 * HTTP 实现：/workspaces/{id}/credentials 与 auth-adapters；rotate 标志控制新版本。
 * 构造绑定单一 workspaceId，防止跨空间轮换凭证。
 */
export class CloudIdentityAdapter implements IdentityAdapter {
    constructor(private workspaceId: string) {}
    private base(path: string) {
        return `/workspaces/${this.workspaceId}/${path}`;
    }
    credentials = (cursor?: string, signal?: AbortSignal) =>
        request<S["CredentialListDTO"]>(
            this.base("credentials") +
                (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            "GET",
            undefined,
            signal,
        );
    adapters = (cursor?: string, signal?: AbortSignal) =>
        request<S["AuthAdapterListDTO"]>(
            this.base("auth-adapters") +
                (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
            "GET",
            undefined,
            signal,
        );
    createAdapter = (configuration: AuthAdapterConfigV1, signal?: AbortSignal) =>
        request<AdapterSummary>(
            this.base("auth-adapters"),
            "POST",
            { configuration },
            signal,
        );
    revokeAdapter = (id: string, signal?: AbortSignal) =>
        request<AdapterSummary>(
            this.base(`auth-adapters/${encodeURIComponent(id)}/revoke`),
            "POST",
            {},
            signal,
        );
    credential = (
        secretRef: string,
        value: JsonObject,
        allowedIdentityIds: string[],
        rotate: boolean,
        signal?: AbortSignal,
    ) =>
        request<CredentialSummary>(
            this.base(
                rotate
                    ? `credentials/${encodeURIComponent(secretRef)}/versions`
                    : "credentials",
            ),
            "POST",
            { ...(rotate ? {} : { secretRef }), value, allowedIdentityIds },
            signal,
        );
    revokeCredential = (ref: string, id: string, signal?: AbortSignal) =>
        request<CredentialSummary>(
            this.base(
                `credentials/${encodeURIComponent(ref)}/versions/${encodeURIComponent(id)}/revoke`,
            ),
            "POST",
            {},
            signal,
        );
}
