/**
 * 身份与凭证管理面板：列出/创建认证适配器与凭证轮换，密钥经适配器直达服务端。轮换成功后刷新版本摘要；轮换成功后立即刷
 * 新适配器与凭证版本摘要。
 * 接收已授权 host transport；secret 值不进入 React Query 或文档 state。
 */

import { tx, useAppLocale } from "../../locale";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { validateSchema, type JsonObject, type AuthAdapterConfigV1 } from "@veriq/contracts";
import { Button, Section } from "@veriq/ui";
import type { IdentityAdapter } from "./identity-adapter";
import { ErrorState } from "../resources/ResourcePage";
type CredentialForm = {
    secretRef: string;
    identities: string;
    mode: string;
    kind: string;
    token: string;
    username: string;
    password: string;
};
type AdapterForm = {
    kind: "HTTP_BEARER" | "HTTP_SESSION";
    identityPath: string;
    identityPointer: string;
    loginPath: string;
};
/**
 * 身份面板只在当前已授权空间内持有表单与请求状态，服务端保存后读取不可变版本摘要；组件真正卸载时中止自身请求并清空两份
 * 表单，避免旧空间的凭证继续保留。成功后刷新摘要列表；失败展示 ApiError，不回显提交的密钥。
 */
export function IdentityManager({
    adapter,
    workspaceId,
    signal,
}: {
    adapter: IdentityAdapter;
    workspaceId: string;
    signal?: AbortSignal;
}) {
    useAppLocale();
    const credential = useForm<CredentialForm>({
        defaultValues: {
            secretRef: "",
            identities: "",
            mode: "create",
            kind: "HTTP_BEARER",
            token: "",
            username: "",
            password: "",
        },
        shouldUnregister: true,
    });
    const auth = useForm<AdapterForm>({
        defaultValues: {
            kind: "HTTP_BEARER",
            identityPath: "/identity",
            identityPointer: "/id",
            loginPath: "/login",
        },
    });
    // 两个 reset 方法由各自的 React Hook Form 控制器稳定持有，清理只依赖这些方法与当前生命周期控制器，认证类型变化引起
    // 的普通重渲染不会清空未提交凭证或中止仍有效的请求。
    const { reset: resetCredential } = credential;
    const { reset: resetAuth } = auth;
    const [controller] = useState(() => new AbortController()),
        scope = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const [busy, setBusy] = useState(false),
        [error, setError] = useState<Error | null>(null),
        [success, setSuccess] = useState("");
    const client = useQueryClient();
    useEffect(
        () => () => {
            controller.abort();
            resetCredential();
            resetAuth();
        },
        [controller, resetCredential, resetAuth],
    );
    const credentials = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "credential-summaries"],
        queryFn: ({ pageParam, signal: qs }) => adapter.credentials(pageParam, AbortSignal.any([scope, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const adapters = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "auth-adapters"],
        queryFn: ({ pageParam, signal: qs }) => adapter.adapters(pageParam, AbortSignal.any([scope, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const run = (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        setSuccess("");
        void fn()
            .catch((e) => {
                if (!scope.aborted) setError(e);
            })
            .finally(() => {
                if (!scope.aborted) setBusy(false);
            });
    };
    const refresh = () => client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    const clearSecret = () => {
        credential.setValue("token", "");
        credential.setValue("username", "");
        credential.setValue("password", "");
    };
    const kind = credential.watch("kind"),
        authKind = auth.watch("kind");
    return (
        <section>
            <h2>{tx("环境身份与凭证 / Environment identities and credentials")}</h2>
            <p>
                {tx(
                    "创建新的固定版本；原文不会回显。修改环境引用后需重新校验发布 / Create immuta" +
                        "ble versions; values are never returned. Republis" +
                        "h environments after changing references.",
                )}
            </p>
            {error && <ErrorState error={error} />}
            {success && <p role="status">{success}</p>}
            <Section title={tx("认证适配器 / Authentication adapters")}>
                <form
                    className="vq-create"
                    onSubmit={auth.handleSubmit((data) =>
                        run(async () => {
                            const configuration: AuthAdapterConfigV1 =
                                data.kind === "HTTP_SESSION"
                                    ? data
                                    : {
                                          kind: data.kind,
                                          identityPath: data.identityPath,
                                          identityPointer: data.identityPointer,
                                      };
                            const issues = validateSchema("AuthAdapterConfigV1", configuration);
                            if (issues.length) throw new Error(issues.map((i) => i.path + ": " + i.message).join("\n"));
                            const saved = await adapter.createAdapter(configuration, scope);
                            scope.throwIfAborted();
                            setSuccess("已创建适配器 / Adapter created: " + saved.versionId);
                            await refresh();
                        }),
                    )}
                >
                    <label>
                        {tx("类型 / Type")}
                        <select {...auth.register("kind")}>
                            <option>HTTP_BEARER</option>
                            <option>HTTP_SESSION</option>
                        </select>
                    </label>
                    <label>
                        {tx("身份路径 / Identity path")}
                        <input {...auth.register("identityPath", { required: true })} />
                    </label>
                    <label>
                        {tx("身份 Pointer / Identity pointer")}
                        <input {...auth.register("identityPointer", { required: true })} />
                    </label>
                    {authKind === "HTTP_SESSION" && (
                        <label>
                            {tx("登录路径 / Login path")}
                            <input {...auth.register("loginPath", { required: true })} />
                        </label>
                    )}
                    <Button type="submit" disabled={busy}>
                        {tx("创建适配器版本 / Create adapter version")}
                    </Button>
                </form>
                {adapters.isPending && <p role="status">{tx("正在加载 / Loading…")}</p>}
                {adapters.error && <ErrorState error={adapters.error} retry={() => void adapters.refetch()} />}
                <div>
                    {adapters.data?.pages
                        .flatMap((p) => p.items)
                        .map((a) => (
                            <article className="vq-item" key={a.versionId}>
                                <p>
                                    {a.configuration.kind} · {a.versionId} · {a.revoked ? "REVOKED" : "ACTIVE"}
                                </p>
                                <p>
                                    {a.configuration.identityPath} · {a.configuration.identityPointer}
                                </p>
                                <Button
                                    tone="danger"
                                    disabled={busy || a.revoked}
                                    onClick={() =>
                                        run(async () => {
                                            await adapter.revokeAdapter(a.versionId, scope);
                                            scope.throwIfAborted();
                                            await refresh();
                                        })
                                    }
                                >
                                    {tx("撤销 / Revoke")}
                                </Button>
                            </article>
                        ))}
                </div>
                {adapters.isSuccess && !adapters.data.pages.some((p) => p.items.length) && (
                    <p>{tx("尚无适配器 / No adapters.")}</p>
                )}
                {adapters.hasNextPage && (
                    <Button onClick={() => void adapters.fetchNextPage()}>{tx("更多适配器 / More adapters")}</Button>
                )}
            </Section>
            <Section title={tx("凭证固定版本 / Credential versions")}>
                <form
                    className="vq-create"
                    autoComplete="off"
                    onSubmit={credential.handleSubmit((data) =>
                        run(async () => {
                            try {
                                const identities = data.identities
                                    .split("\n")
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                                if (!identities.length)
                                    throw new Error("至少指定一个允许身份 / At least one allowed identity required");
                                const value: JsonObject =
                                    data.kind === "HTTP_BEARER"
                                        ? { token: data.token }
                                        : { username: data.username, password: data.password };
                                const saved = await adapter.credential(
                                    data.secretRef,
                                    value,
                                    identities,
                                    data.mode === "rotate",
                                    scope,
                                );
                                scope.throwIfAborted();
                                setSuccess("已保存凭证版本 / Credential saved: " + saved.versionId);
                                await refresh();
                            } finally {
                                // 保存完成或失败后清除当前表单的密钥，空间卸载已由生命周期清理负责清空；旧请求的迟到结
                                // 算不得再向已释放表单写入状态，因此需要先确认捕获的请求范围仍然有效。
                                if (!scope.aborted) clearSecret();
                            }
                        }),
                    )}
                >
                    <label>
                        {tx("创建或轮换 / Operation")}
                        <select {...credential.register("mode")}>
                            <option value="create">{tx("创建引用 / Create reference")}</option>
                            <option value="rotate">{tx("新版本 / New version")}</option>
                        </select>
                    </label>
                    <label>
                        {tx("引用 key / Secret ref")}
                        <input
                            required
                            {...credential.register("secretRef", {
                                required: true,
                                pattern: /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/,
                            })}
                        />
                    </label>
                    <label>
                        {tx("允许身份（每行一个）/ Allowed identities")}
                        <textarea required {...credential.register("identities", { required: true })} />
                    </label>
                    <label>
                        {tx("凭证类型 / Credential type")}
                        <select
                            {...credential.register("kind")}
                            onChange={(e) => {
                                clearSecret();
                                credential.setValue("kind", e.target.value);
                            }}
                        >
                            <option>HTTP_BEARER</option>
                            <option>HTTP_SESSION</option>
                        </select>
                    </label>
                    {kind === "HTTP_BEARER" ? (
                        <label>
                            {tx("Bearer token")}
                            <input
                                type="password"
                                autoComplete="new-password"
                                {...credential.register("token", {
                                    required: kind === "HTTP_BEARER",
                                })}
                            />
                        </label>
                    ) : (
                        <>
                            <label>
                                {tx("用户名 / Username")}
                                <input
                                    autoComplete="off"
                                    {...credential.register("username", {
                                        required: kind === "HTTP_SESSION",
                                    })}
                                />
                            </label>
                            <label>
                                {tx("密码 / Password")}
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    {...credential.register("password", {
                                        required: kind === "HTTP_SESSION",
                                    })}
                                />
                            </label>
                        </>
                    )}
                    <Button type="submit" disabled={busy}>
                        {tx("保存凭证新版本 / Save credential version")}
                    </Button>
                </form>
                {credentials.isPending && <p role="status">{tx("正在加载 / Loading…")}</p>}
                {credentials.error && <ErrorState error={credentials.error} retry={() => void credentials.refetch()} />}
                <div>
                    {credentials.data?.pages
                        .flatMap((p) => p.items)
                        .map((c) => (
                            <article className="vq-item" key={c.versionId}>
                                <p>
                                    {c.secretRef} · {c.versionId} · {c.revoked ? "REVOKED" : "ACTIVE"}
                                </p>
                                <p>
                                    {tx("允许身份 / Allowed: ")}
                                    {c.allowedIdentityIds.join(", ")}
                                </p>
                                <Button
                                    tone="danger"
                                    disabled={busy || c.revoked}
                                    onClick={() =>
                                        run(async () => {
                                            await adapter.revokeCredential(c.secretRef, c.versionId, scope);
                                            scope.throwIfAborted();
                                            await refresh();
                                        })
                                    }
                                >
                                    {tx("撤销 / Revoke")}
                                </Button>
                            </article>
                        ))}
                </div>
                {credentials.isSuccess && !credentials.data.pages.some((p) => p.items.length) && (
                    <p>{tx("尚无凭证 / No credentials.")}</p>
                )}
                {credentials.hasNextPage && (
                    <Button onClick={() => void credentials.fetchNextPage()}>
                        {tx("更多凭证 / More credentials")}
                    </Button>
                )}
            </Section>
        </section>
    );
}
