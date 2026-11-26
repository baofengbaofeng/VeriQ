/**
 * Runtime 管理页：在选定 Workspace 下列出设备、审批登记、配置授权/信任与服务账号令牌。离线 Agent 心跳状态只读展示。
 * 数据经 runtimeApi 与 api.workspaces；切换空间清空本地表单状态。
 */

import { tx, useAppLocale } from "../../locale";
import { useContext, useEffect, useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, runtimeApi, type Runtime, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Button, Field, Select, SelectItem } from "../../components";
import { Notice, Panel, useAction, values } from "../../ui";
import { useWorkspaceDirectory, WorkspaceStatus } from "../workspaces/WorkspaceDirectory";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import "./runtimes.css";

/**
 * 将顶栏目录确认的空间交给设备与服务账号面板，权限判断与设备信任操作继续使用当前工作区的身份。
 */
export function RuntimePage() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { workspace } = useWorkspaceDirectory();
    if (!user) return <Navigate to="/login" />;
    return (
        <Panel title={tx("Runtimes")}>
            <WorkspaceStatus />
            <p>{tx("Register a device and choose who may use it. Registration alone does not start a worker.")}</p>
            {workspace && <RuntimeWorkspace key={user.id + workspace.id} workspace={workspace} />}
        </Panel>
    );
}

function RuntimeWorkspace({ workspace }: { workspace: Workspace }) {
    useAppLocale();
    const { signal } = useWorkspace(),
        client = useQueryClient(),
        a = useAction();
    const [code, setCode] = useState(""),
        [preview, setPreview] = useState<Awaited<ReturnType<typeof runtimeApi.inspect>> | null>(null),
        [sharing, setSharing] = useState("private"),
        [users, setUsers] = useState<string[]>([]);
    const inspectGeneration = useRef(0);
    const sharingId = useId();
    const runtimes = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "runtimes"],
        queryFn: ({ pageParam, signal }) => runtimeApi.list(workspace.id, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const refresh = () => client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    const writable = !workspace.archived && workspace.role !== "VIEWER";
    return (
        <div className="vq-runtime-workspace">
            {writable && (
                <section aria-label={tx("Approve device")}>
                    <h2>{tx("Approve a device")}</h2>
                    <p>
                        {tx(
                            "Run VeriQ login on your device, then enter its approval code. Confirm that you recogniz" +
                                "e the device before approving.",
                        )}
                    </p>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            setPreview(null);
                            const generation = ++inspectGeneration.current;
                            void a.submit(async () => {
                                // 用户可以在检查期间继续修改登记码，因此旧请求即使成功也不能恢复已清空的预览或审批入口
                                // ；空间切换仍由现有 signal 取消，不改变平台审批和权限协议。
                                try {
                                    const candidate = await runtimeApi.inspect(code, signal);
                                    if (!signal?.aborted && generation === inspectGeneration.current)
                                        setPreview(candidate);
                                } catch (error) {
                                    if (!signal?.aborted && generation === inspectGeneration.current) throw error;
                                }
                            });
                        }}
                    >
                        <Field
                            label={tx("Approval code")}
                            hint={tx("Enter the twelve characters from the device.")}
                            required
                        >
                            <input
                                value={code}
                                pattern="[A-Z2-7]{12}"
                                required
                                maxLength={12}
                                onChange={(e) => {
                                    inspectGeneration.current += 1;
                                    setCode(e.target.value.toUpperCase());
                                    setPreview(null);
                                }}
                                autoComplete="off"
                            />
                        </Field>
                        <Button type="submit" tone="primary" size="regular" disabled={a.busy}>
                            {tx("Inspect device")}
                        </Button>
                    </form>
                    {preview && (
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                void a.submit(
                                    async (complete) => {
                                        await runtimeApi.approve(
                                            preview.id,
                                            {
                                                userCode: code,
                                                workspaceId: workspace.id,
                                                private: sharing === "private",
                                                sharedWithUserIds: sharing === "members" ? users : [],
                                            },
                                            signal,
                                        );
                                        setPreview(null);
                                        setCode("");
                                        complete("Device approved. Return to the device to finish registration.");
                                        await refresh();
                                    },
                                    { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                                );
                            }}
                        >
                            <h3>{preview.name}</h3>
                            <p>
                                {tx("Reported: ")}
                                {preview.capabilities.os} / {preview.capabilities.arch}
                                {tx("; engine ")}
                                {preview.capabilities.engineVersion}
                                {tx("; browsers")} {preview.capabilities.browsers.join(", ") || tx("none")}
                            </p>
                            <Field
                                label={tx("Sharing")}
                                htmlFor={sharingId}
                                hint={tx("Choose who may run tests on this device.")}
                                required
                            >
                                <Select
                                    id={sharingId}
                                    appearance="default-dropdown"
                                    value={sharing}
                                    onValueChange={setSharing}
                                    required
                                >
                                    <SelectItem value="private">{tx("Private — only me")}</SelectItem>
                                    <SelectItem value="workspace">{tx("Share with this Workspace")}</SelectItem>
                                    <SelectItem value="members">{tx("Share with selected members")}</SelectItem>
                                </Select>
                            </Field>
                            {sharing === "members" && (
                                <MemberShares ws={workspace.id} selected={users} onChange={setUsers} />
                            )}
                            <Button
                                type="submit"
                                tone="primary"
                                size="regular"
                                disabled={a.busy || (sharing === "members" && !users.length)}
                            >
                                {tx("Approve device")}
                            </Button>
                        </form>
                    )}
                    <Notice error={a.error} />
                </section>
            )}
            <header className="vq-runtime-toolbar">
                <h2>{tx("Registered devices")}</h2>
                <Button size="compact" tone="secondary" onClick={() => void runtimes.refetch()}>
                    {tx("Refresh devices")}
                </Button>
            </header>
            {runtimes.isPending && <p role="status">{tx("Loading Runtimes…")}</p>}
            {runtimes.error && <Notice error={runtimes.error.message} />}
            {runtimes.isSuccess && !runtimes.data.pages.some((p) => p.items.length) && (
                <p>{tx("No registered Runtimes in this Workspace.")}</p>
            )}
            {runtimes.data?.pages
                .flatMap((p) => p.items)
                .map((runtime) => (
                    <RuntimeCard
                        key={runtime.id}
                        runtime={runtime}
                        refresh={refresh}
                        writable={writable}
                        archived={workspace.archived}
                        canDeliver={!workspace.archived && ["OWNER", "ADMIN"].includes(workspace.role)}
                    />
                ))}
            {runtimes.hasNextPage && (
                <Button
                    tone="secondary"
                    size="compact"
                    disabled={runtimes.isFetchingNextPage}
                    onClick={() => void runtimes.fetchNextPage()}
                >
                    {tx("Load more devices")}
                </Button>
            )}
            {["OWNER", "ADMIN"].includes(workspace.role) && <ServiceAccounts workspace={workspace} />}
        </div>
    );
}

function MemberShares({
    ws,
    selected,
    onChange,
}: {
    ws: string;
    selected: string[];
    onChange: (users: string[]) => void;
}) {
    useAppLocale();
    const members = useInfiniteQuery({
        queryKey: ["workspace", ws, "runtime-share-members"],
        queryFn: ({ pageParam, signal }) => api.members(ws, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    return (
        <fieldset>
            <legend>{tx("Members allowed to use this device")}</legend>
            {members.isPending && <p role="status">{tx("Loading members…")}</p>}
            {members.error && <Notice error={members.error.message} />}
            {members.data?.pages
                .flatMap((p) => p.items)
                .filter((m) => m.status === "ACTIVE" && !m.userDisabled)
                .map((m) => (
                    <label className="check" key={m.userId}>
                        <input
                            type="checkbox"
                            checked={selected.includes(m.userId)}
                            onChange={(e) =>
                                onChange(
                                    e.target.checked
                                        ? [...selected, m.userId]
                                        : selected.filter((id) => id !== m.userId),
                                )
                            }
                        />
                        {m.displayName} ({m.email})
                    </label>
                ))}
            {members.hasNextPage && (
                <Button size="compact" tone="secondary" onClick={() => void members.fetchNextPage()}>
                    {tx("Load more members")}
                </Button>
            )}
        </fieldset>
    );
}

function RuntimeCard({
    runtime,
    refresh,
    writable,
    archived,
    canDeliver,
}: {
    runtime: Runtime;
    refresh: () => Promise<unknown>;
    writable: boolean;
    archived: boolean;
    canDeliver: boolean;
}) {
    useAppLocale();
    const { user } = useContext(Auth),
        { signal } = useWorkspace(),
        a = useAction();
    const trustId = useId();
    const [shared, setShared] = useState(runtime.sharedWithWorkspace),
        [users, setUsers] = useState(runtime.sharedWithUserIds),
        [trust, setTrust] = useState<"MANAGED" | "USER_REGISTERED">(
            runtime.trustStatus === "MANAGED" ? "MANAGED" : "USER_REGISTERED",
        ),
        [delivery, setDelivery] = useState(runtime.allowCredentialDelivery);
    useEffect(() => {
        setShared(runtime.sharedWithWorkspace);
        setUsers(runtime.sharedWithUserIds);
        setTrust(runtime.trustStatus === "MANAGED" ? "MANAGED" : "USER_REGISTERED");
        setDelivery(runtime.allowCredentialDelivery);
    }, [runtime]);
    return (
        <article>
            <h3>{runtime.name}</h3>
            <p>
                {runtime.location} ·{" "}
                {runtime.ownerType === "USER" ? tx("Personal device") : tx("Service account device")} · {runtime.status}
            </p>
            <p>
                {tx("Current trust: ")}
                {runtime.trustStatus}
            </p>
            <p>
                {tx("Reported capabilities: ")}
                {runtime.capabilities.os} / {runtime.capabilities.arch}
                {tx("; engine ")}
                {runtime.capabilities.engineVersion}; {runtime.capabilities.browsers.join(", ") || tx("no browsers")}
                {tx(". These reports do not approve an engine release.")}
            </p>
            <p>
                {runtime.sharedWithWorkspace
                    ? tx("Shared with Workspace")
                    : runtime.sharedWithUserIds.length
                      ? tx("Shared with selected members")
                      : tx("Private")}
                {tx(". Platform credential delivery:")}{" "}
                {runtime.allowCredentialDelivery ? tx("allowed") : tx("disabled")}.
            </p>
            <p>
                {tx("Worker is ")}
                {runtime.status === "REVOKED" ? tx("revoked") : tx("offline")}
                {tx(
                    ". Execution history becomes available after runs exist; current trust does not rewrite past res" +
                        "ults.",
                )}
            </p>
            {runtime.canManage && writable && runtime.status !== "REVOKED" && (
                <>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void a.submit(
                                async (complete) => {
                                    await runtimeApi.grants(
                                        runtime.workspaceId,
                                        runtime.id,
                                        {
                                            workspaceId: runtime.workspaceId,
                                            userIds: users,
                                            sharedWithWorkspace: shared,
                                        },
                                        signal,
                                    );
                                    complete("Sharing updated. Trust approval has been reset.");
                                    await refresh();
                                },
                                { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                            );
                        }}
                    >
                        <label className="check">
                            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
                            {tx("Share with the Workspace")}
                        </label>
                        <MemberShares ws={runtime.workspaceId} selected={users} onChange={setUsers} />
                        <Button type="submit" size="regular" tone="primary" disabled={a.busy}>
                            {tx("Save sharing")}
                        </Button>
                    </form>
                    <Button
                        size="compact"
                        tone="danger"
                        disabled={a.busy}
                        onClick={(event) =>
                            void a.submit(
                                async (complete) => {
                                    await runtimeApi.revoke(runtime.workspaceId, runtime.id, signal);
                                    complete("Runtime revoked. New device operations are denied.");
                                    await refresh();
                                },
                                { waitingFrom: event.currentTarget, signal },
                            )
                        }
                    >
                        {tx("Revoke device")}
                    </Button>
                </>
            )}
            {user?.systemAdmin &&
                !archived &&
                runtime.status !== "REVOKED" &&
                (runtime.sharedWithWorkspace || runtime.sharedWithUserIds.length > 0) && (
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void a.submit(
                                async (complete) => {
                                    await runtimeApi.trust(
                                        runtime.workspaceId,
                                        runtime.id,
                                        { trustStatus: trust, allowCredentialDelivery: false },
                                        signal,
                                    );
                                    complete("Current trust updated.");
                                    await refresh();
                                },
                                { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                            );
                        }}
                    >
                        <Field
                            label={tx("Current trust")}
                            htmlFor={trustId}
                            hint={tx("Changing hardware trust clears approval for credential delivery.")}
                            required
                        >
                            <Select
                                id={trustId}
                                appearance="default-dropdown"
                                value={trust}
                                onValueChange={(next) => {
                                    if (next !== "MANAGED" && next !== "USER_REGISTERED") return;
                                    setTrust(next);
                                    if (next !== "MANAGED") setDelivery(false);
                                }}
                                required
                            >
                                <SelectItem value="USER_REGISTERED">{tx("User registered")}</SelectItem>
                                <SelectItem value="MANAGED">{tx("Managed")}</SelectItem>
                            </Select>
                        </Field>
                        <Button type="submit" size="regular" tone="primary" disabled={a.busy}>
                            {tx("Save trust")}
                        </Button>
                    </form>
                )}
            {canDeliver &&
                runtime.status !== "REVOKED" &&
                (runtime.sharedWithWorkspace || runtime.sharedWithUserIds.length > 0) && (
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void a.submit(
                                async (complete) => {
                                    await runtimeApi.delivery(runtime.workspaceId, runtime.id, delivery, signal);
                                    complete("Workspace credential delivery updated.");
                                    await refresh();
                                },
                                { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                            );
                        }}
                    >
                        <h4>{tx("Workspace credential delivery")}</h4>
                        <p>
                            {tx(
                                "Workspace owners and administrators may approve delivery after hardware trust is ma" +
                                    "naged. Updating hardware trust clears this approval.",
                            )}
                        </p>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={delivery}
                                disabled={runtime.trustStatus !== "MANAGED"}
                                onChange={(e) => setDelivery(e.target.checked)}
                            />
                            {tx("Allow platform credential delivery")}
                        </label>
                        <Button
                            type="submit"
                            size="regular"
                            tone="primary"
                            disabled={a.busy || runtime.trustStatus !== "MANAGED"}
                        >
                            {tx("Save credential delivery")}
                        </Button>
                    </form>
                )}
            <Notice error={a.error} />
        </article>
    );
}

function ServiceAccounts({ workspace }: { workspace: Workspace }) {
    useAppLocale();
    const { signal } = useWorkspace(),
        a = useAction();
    const [token, setToken] = useState("");
    const accounts = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "service-accounts"],
        queryFn: ({ pageParam, signal }) => runtimeApi.accounts(workspace.id, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    return (
        <section>
            <h2>{tx("Deployment service accounts")}</h2>
            <p>
                {tx(
                    "Use a one-time registration token with VeriQ enroll-service. Registration does not grant manage" +
                        "d trust.",
                )}
            </p>
            {!workspace.archived && (
                <form
                    onSubmit={(e) => {
                        const v = values(e);
                        void a.submit(
                            async (complete) => {
                                await runtimeApi.createAccount(workspace.id, v.name, signal);
                                complete("Service account created.");
                                await accounts.refetch();
                            },
                            { waitingFrom: (e.nativeEvent as SubmitEvent).submitter, signal },
                        );
                    }}
                >
                    <Field label={tx("Name")} hint={tx("Use a name that identifies the deployment account.")} required>
                        <input name="name" required maxLength={160} />
                    </Field>
                    <Button type="submit" size="regular" tone="primary" disabled={a.busy}>
                        {tx("Create service account")}
                    </Button>
                </form>
            )}
            {accounts.isPending && <p role="status">{tx("Loading service accounts…")}</p>}
            {accounts.error && <Notice error={accounts.error.message} />}
            {accounts.isSuccess && !accounts.data.pages.some((p) => p.items.length) && (
                <p>{tx("No deployment service accounts.")}</p>
            )}
            {accounts.data?.pages
                .flatMap((p) => p.items)
                .map((account) => (
                    <article key={account.id}>
                        <h3>{account.name}</h3>
                        <p>{account.disabled ? tx("Disabled") : tx("Enabled")}</p>
                        {!account.disabled && !workspace.archived && (
                            <>
                                <Button
                                    size="compact"
                                    tone="primary"
                                    disabled={a.busy}
                                    onClick={() =>
                                        void a.submit(async () => {
                                            const result = await runtimeApi.issueToken(
                                                workspace.id,
                                                account.id,
                                                signal,
                                            );
                                            if (!signal?.aborted) setToken(result.token);
                                        })
                                    }
                                >
                                    {tx("Issue enrollment token")}
                                </Button>
                                <Button
                                    size="compact"
                                    tone="danger"
                                    disabled={a.busy}
                                    onClick={(event) =>
                                        void a.submit(
                                            async (complete) => {
                                                await runtimeApi.disableAccount(workspace.id, account.id, signal);
                                                setToken("");
                                                complete(
                                                    "Service account disabled; its devices can no longer authenticate.",
                                                );
                                                await accounts.refetch();
                                            },
                                            { waitingFrom: event.currentTarget, signal },
                                        )
                                    }
                                >
                                    {tx("Disable service account")}
                                </Button>
                            </>
                        )}
                    </article>
                ))}
            {accounts.hasNextPage && (
                <Button size="compact" tone="secondary" onClick={() => void accounts.fetchNextPage()}>
                    {tx("Load more service accounts")}
                </Button>
            )}
            <Dialog.Root open={!!token} onOpenChange={(open) => !open && setToken("")}>
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <Dialog.Title>{tx("Enrollment token issued")}</Dialog.Title>
                        <Dialog.Description>
                            {tx("Expires in ten minutes. Pass through standard input, never a command argument.")}
                        </Dialog.Description>
                        <label>
                            {tx("One-time enrollment token")}
                            <input readOnly value={token} autoComplete="off" />
                        </label>
                        <Dialog.Close asChild>
                            <Button size="regular" tone="secondary">
                                {tx("Dismiss token")}
                            </Button>
                        </Dialog.Close>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
            <Notice error={a.error} />
        </section>
    );
}
