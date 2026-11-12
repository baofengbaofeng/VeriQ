/**
 * 本文件 apps/web/src/features/environments/IdentityManager.tsx 实现 VeriQ Web/共享 UI 界面能力并导出公开组件与辅助函数
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 */

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
/** Receives an authorized host transport; secret values never enter Query or document state. */
/**
 * 公开符号 IdentityManager（function）定义 apps/web/src/features/environments/IdentityManager.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
    const [controller] = useState(() => new AbortController()),
        scope = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const [busy, setBusy] = useState(false),
        [error, setError] = useState<Error | null>(null),
        [success, setSuccess] = useState("");
    const client = useQueryClient();
    useEffect(
        () => () => {
            controller.abort();
            credential.reset();
            auth.reset();
        },
        [controller],
    );
    const credentials = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "credential-summaries"],
        queryFn: ({ pageParam, signal: qs }) =>
            adapter.credentials(pageParam, AbortSignal.any([scope, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const adapters = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "auth-adapters"],
        queryFn: ({ pageParam, signal: qs }) =>
            adapter.adapters(pageParam, AbortSignal.any([scope, qs])),
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
        <section data-testid="identity-manager">
            <h2>环境身份与凭证 / Environment identities and credentials</h2>
            <p>
                创建新的固定版本；原文不会回显。修改环境引用后需重新校验发布 / Create immutable
                versions; values are never returned. Republish environments after changing
                references.
            </p>
            {error && <ErrorState error={error} />}
            {success && <p role="status">{success}</p>}
            <Section title="认证适配器 / Authentication adapters">
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
                            if (issues.length)
                                throw new Error(
                                    issues.map((i) => i.path + ": " + i.message).join("\n"),
                                );
                            const saved = await adapter.createAdapter(configuration, scope);
                            scope.throwIfAborted();
                            setSuccess("已创建适配器 / Adapter created: " + saved.versionId);
                            await refresh();
                        }),
                    )}
                >
                    <label>
                        类型 / Type
                        <select {...auth.register("kind")}>
                            <option>HTTP_BEARER</option>
                            <option>HTTP_SESSION</option>
                        </select>
                    </label>
                    <label>
                        身份路径 / Identity path
                        <input
                            data-testid="adapter-identity-path"
                            {...auth.register("identityPath", { required: true })}
                        />
                    </label>
                    <label>
                        身份 Pointer / Identity pointer
                        <input
                            data-testid="adapter-identity-pointer"
                            {...auth.register("identityPointer", { required: true })}
                        />
                    </label>
                    {authKind === "HTTP_SESSION" && (
                        <label>
                            登录路径 / Login path
                            <input {...auth.register("loginPath", { required: true })} />
                        </label>
                    )}
                    <Button type="submit" data-testid="adapter-create" disabled={busy}>
                        创建适配器版本 / Create adapter version
                    </Button>
                </form>
                {adapters.isPending && <p role="status">正在加载 / Loading…</p>}
                {adapters.error && (
                    <ErrorState error={adapters.error} retry={() => void adapters.refetch()} />
                )}
                <div data-testid="adapter-list">
                    {adapters.data?.pages
                        .flatMap((p) => p.items)
                        .map((a) => (
                            <article className="vq-item" key={a.versionId}>
                                <p>
                                    {a.configuration.kind} · {a.versionId} ·{" "}
                                    {a.revoked ? "REVOKED" : "ACTIVE"}
                                </p>
                                <p>
                                    {a.configuration.identityPath} ·{" "}
                                    {a.configuration.identityPointer}
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
                                    撤销 / Revoke
                                </Button>
                            </article>
                        ))}
                </div>
                {adapters.isSuccess && !adapters.data.pages.some((p) => p.items.length) && (
                    <p>尚无适配器 / No adapters.</p>
                )}
                {adapters.hasNextPage && (
                    <Button onClick={() => void adapters.fetchNextPage()}>
                        更多适配器 / More adapters
                    </Button>
                )}
            </Section>
            <Section title="凭证固定版本 / Credential versions">
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
                                    throw new Error(
                                        "至少指定一个允许身份 / At least one allowed identity required",
                                    );
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
                                clearSecret();
                            }
                        }),
                    )}
                >
                    <label>
                        创建或轮换 / Operation
                        <select data-testid="credential-mode" {...credential.register("mode")}>
                            <option value="create">创建引用 / Create reference</option>
                            <option value="rotate">新版本 / New version</option>
                        </select>
                    </label>
                    <label>
                        引用 key / Secret ref
                        <input
                            data-testid="credential-ref"
                            required
                            {...credential.register("secretRef", {
                                required: true,
                                pattern: /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/,
                            })}
                        />
                    </label>
                    <label>
                        允许身份（每行一个）/ Allowed identities
                        <textarea
                            data-testid="credential-identities"
                            required
                            {...credential.register("identities", { required: true })}
                        />
                    </label>
                    <label>
                        凭证类型 / Credential type
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
                            Bearer token
                            <input
                                data-testid="credential-token"
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
                                用户名 / Username
                                <input
                                    autoComplete="off"
                                    {...credential.register("username", {
                                        required: kind === "HTTP_SESSION",
                                    })}
                                />
                            </label>
                            <label>
                                密码 / Password
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
                    <Button type="submit" data-testid="credential-create" disabled={busy}>
                        保存凭证新版本 / Save credential version
                    </Button>
                </form>
                {credentials.isPending && <p role="status">正在加载 / Loading…</p>}
                {credentials.error && (
                    <ErrorState
                        error={credentials.error}
                        retry={() => void credentials.refetch()}
                    />
                )}
                <div data-testid="credential-list">
                    {credentials.data?.pages
                        .flatMap((p) => p.items)
                        .map((c) => (
                            <article className="vq-item" key={c.versionId}>
                                <p>
                                    {c.secretRef} · {c.versionId} ·{" "}
                                    {c.revoked ? "REVOKED" : "ACTIVE"}
                                </p>
                                <p>允许身份 / Allowed: {c.allowedIdentityIds.join(", ")}</p>
                                <Button
                                    tone="danger"
                                    disabled={busy || c.revoked}
                                    onClick={() =>
                                        run(async () => {
                                            await adapter.revokeCredential(
                                                c.secretRef,
                                                c.versionId,
                                                scope,
                                            );
                                            scope.throwIfAborted();
                                            await refresh();
                                        })
                                    }
                                >
                                    撤销 / Revoke
                                </Button>
                            </article>
                        ))}
                </div>
                {credentials.isSuccess && !credentials.data.pages.some((p) => p.items.length) && (
                    <p>尚无凭证 / No credentials.</p>
                )}
                {credentials.hasNextPage && (
                    <Button onClick={() => void credentials.fetchNextPage()}>
                        更多凭证 / More credentials
                    </Button>
                )}
            </Section>
        </section>
    );
}
