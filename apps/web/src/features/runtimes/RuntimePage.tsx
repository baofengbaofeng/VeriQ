/**
 * Runtime 管理页：在选定 Workspace 下列出设备、审批登记、配置授权/信任与服务账号令牌。离线 Agent 心跳状态只读展示。
 * 数据经 runtimeApi 与 api.workspaces；切换空间清空本地表单状态。
 */

import { useContext, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, runtimeApi, type Runtime, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Notice, Panel, useAction, values } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";

/**
 * 组合工作区选择器与 Runtime/服务账号面板，调用 inspect/approve/grants/trust/revoke/issueToken。
 * 凭证投递开关走 delivery；吊销后列表刷新且不可再领取该空间作业。
 */
export function RuntimePage() {
    const { user } = useContext(Auth),
        { selected, select } = useWorkspace();
    const workspaces = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!user,
    });
    const items = workspaces.data?.pages.flatMap((p) => p.items) ?? [];
    useEffect(() => {
        if (!selected && items.length) select(items[0]!.id);
    }, [selected, items[0]?.id]);
    if (!user) return <Navigate to="/login" />;
    const workspace = items.find((w) => w.id === selected);
    return (
        <Panel title="Runtimes">
            <p>
                Register a device and choose who may use it. Registration alone does not start a
                worker.
            </p>
            {workspaces.isPending && <p role="status">Loading Workspaces…</p>}
            {workspaces.error && (
                <>
                    <Notice error={workspaces.error.message} />
                    <button onClick={() => void workspaces.refetch()}>Retry Workspaces</button>
                </>
            )}
            {workspaces.isSuccess && !items.length && (
                <p>Create or join a Workspace before registering a device.</p>
            )}
            {!!items.length && (
                <label>
                    Workspace
                    <select
                        data-testid="runtime-workspace"
                        value={selected}
                        onChange={(e) => select(e.target.value)}
                    >
                        {items.map((w) => (
                            <option key={w.id} value={w.id}>
                                {w.name}
                                {w.archived ? " (Archived)" : ""}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {workspaces.hasNextPage && (
                <button
                    disabled={workspaces.isFetchingNextPage}
                    onClick={() => void workspaces.fetchNextPage()}
                >
                    Load more Workspaces
                </button>
            )}
            {workspace && <RuntimeWorkspace key={user.id + workspace.id} workspace={workspace} />}
        </Panel>
    );
}

function RuntimeWorkspace({ workspace }: { workspace: Workspace }) {
    const { signal } = useWorkspace(),
        client = useQueryClient(),
        a = useAction();
    const [code, setCode] = useState(""),
        [preview, setPreview] = useState<Awaited<ReturnType<typeof runtimeApi.inspect>> | null>(
            null,
        ),
        [sharing, setSharing] = useState("private"),
        [users, setUsers] = useState<string[]>([]);
    const runtimes = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "runtimes"],
        queryFn: ({ pageParam, signal }) => runtimeApi.list(workspace.id, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const refresh = () => client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    const writable = !workspace.archived && workspace.role !== "VIEWER";
    return (
        <>
            {writable && (
                <section aria-label="Approve device">
                    <h2>Approve a device</h2>
                    <p>
                        Run VeriQ login on your device, then enter its approval code. Confirm that
                        you recognize the device before approving.
                    </p>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            setPreview(null);
                            void a.run(async () => {
                                setPreview(await runtimeApi.inspect(code, signal));
                            });
                        }}
                    >
                        <label>
                            Approval code
                            <input
                                data-testid="enrollment-code"
                                value={code}
                                pattern="[A-Z2-7]{12}"
                                required
                                maxLength={12}
                                onChange={(e) => {
                                    setCode(e.target.value.toUpperCase());
                                    setPreview(null);
                                }}
                                autoComplete="off"
                            />
                        </label>
                        <button data-testid="enrollment-inspect" disabled={a.busy}>
                            Inspect device
                        </button>
                    </form>
                    {preview && (
                        <form
                            data-testid="enrollment-preview"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void a.run(async () => {
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
                                    await refresh();
                                    a.setMessage(
                                        "Device approved. Return to the device to finish registration.",
                                    );
                                });
                            }}
                        >
                            <h3>{preview.name}</h3>
                            <p>
                                Reported: {preview.capabilities.os} / {preview.capabilities.arch};
                                engine {preview.capabilities.engineVersion}; browsers{" "}
                                {preview.capabilities.browsers.join(", ") || "none"}
                            </p>
                            <label>
                                Sharing
                                <select
                                    value={sharing}
                                    onChange={(e) => setSharing(e.target.value)}
                                >
                                    <option value="private">Private — only me</option>
                                    <option value="workspace">Share with this Workspace</option>
                                    <option value="members">Share with selected members</option>
                                </select>
                            </label>
                            {sharing === "members" && (
                                <MemberShares
                                    ws={workspace.id}
                                    selected={users}
                                    onChange={setUsers}
                                />
                            )}
                            <button
                                data-testid="enrollment-approve"
                                disabled={a.busy || (sharing === "members" && !users.length)}
                            >
                                Approve device
                            </button>
                        </form>
                    )}
                    <Notice error={a.error} message={a.message} />
                </section>
            )}
            <h2>Registered devices</h2>
            <button onClick={() => void runtimes.refetch()}>Refresh devices</button>
            {runtimes.isPending && <p role="status">Loading Runtimes…</p>}
            {runtimes.error && <Notice error={runtimes.error.message} />}
            {runtimes.isSuccess && !runtimes.data.pages.some((p) => p.items.length) && (
                <p>No registered Runtimes in this Workspace.</p>
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
                        canDeliver={
                            !workspace.archived && ["OWNER", "ADMIN"].includes(workspace.role)
                        }
                    />
                ))}
            {runtimes.hasNextPage && (
                <button
                    disabled={runtimes.isFetchingNextPage}
                    onClick={() => void runtimes.fetchNextPage()}
                >
                    Load more devices
                </button>
            )}
            {["OWNER", "ADMIN"].includes(workspace.role) && (
                <ServiceAccounts workspace={workspace} />
            )}
        </>
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
    const members = useInfiniteQuery({
        queryKey: ["workspace", ws, "runtime-share-members"],
        queryFn: ({ pageParam, signal }) => api.members(ws, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    return (
        <fieldset>
            <legend>Members allowed to use this device</legend>
            {members.isPending && <p role="status">Loading members…</p>}
            {members.error && <Notice error={members.error.message} />}
            {members.data?.pages
                .flatMap((p) => p.items)
                .filter((m) => m.status === "ACTIVE" && !m.userDisabled)
                .map((m) => (
                    <label key={m.userId}>
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
                <button type="button" onClick={() => void members.fetchNextPage()}>
                    Load more members
                </button>
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
    const { user } = useContext(Auth),
        { signal } = useWorkspace(),
        a = useAction();
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
        <article data-testid={`runtime-${runtime.id}`}>
            <h3>{runtime.name}</h3>
            <p>
                {runtime.location} ·{" "}
                {runtime.ownerType === "USER" ? "Personal device" : "Service account device"} ·{" "}
                {runtime.status}
            </p>
            <p data-testid="current-trust">Current trust: {runtime.trustStatus}</p>
            <p>
                Reported capabilities: {runtime.capabilities.os} / {runtime.capabilities.arch};
                engine {runtime.capabilities.engineVersion};{" "}
                {runtime.capabilities.browsers.join(", ") || "no browsers"}. These reports do not
                approve an engine release.
            </p>
            <p>
                {runtime.sharedWithWorkspace
                    ? "Shared with Workspace"
                    : runtime.sharedWithUserIds.length
                      ? "Shared with selected members"
                      : "Private"}
                . Platform credential delivery:{" "}
                {runtime.allowCredentialDelivery ? "allowed" : "disabled"}.
            </p>
            <p>
                Worker is {runtime.status === "REVOKED" ? "revoked" : "offline"}. Execution history
                becomes available after runs exist; current trust does not rewrite past results.
            </p>
            {runtime.canManage && writable && runtime.status !== "REVOKED" && (
                <>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void a.run(async () => {
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
                                await refresh();
                                a.setMessage("Sharing updated. Trust approval has been reset.");
                            });
                        }}
                    >
                        <label>
                            <input
                                data-testid="share-workspace"
                                type="checkbox"
                                checked={shared}
                                onChange={(e) => setShared(e.target.checked)}
                            />
                            Share with the Workspace
                        </label>
                        <MemberShares
                            ws={runtime.workspaceId}
                            selected={users}
                            onChange={setUsers}
                        />
                        <button data-testid="save-grants" disabled={a.busy}>
                            Save sharing
                        </button>
                    </form>
                    <button
                        data-testid="revoke-runtime"
                        disabled={a.busy}
                        onClick={() =>
                            void a.run(async () => {
                                await runtimeApi.revoke(runtime.workspaceId, runtime.id, signal);
                                await refresh();
                                a.setMessage("Runtime revoked. New device operations are denied.");
                            })
                        }
                    >
                        Revoke device
                    </button>
                </>
            )}
            {user?.systemAdmin &&
                !archived &&
                runtime.status !== "REVOKED" &&
                (runtime.sharedWithWorkspace || runtime.sharedWithUserIds.length > 0) && (
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void a.run(async () => {
                                await runtimeApi.trust(
                                    runtime.workspaceId,
                                    runtime.id,
                                    { trustStatus: trust, allowCredentialDelivery: false },
                                    signal,
                                );
                                await refresh();
                                a.setMessage("Current trust updated.");
                            });
                        }}
                    >
                        <label>
                            Current trust
                            <select
                                data-testid="trust-status"
                                value={trust}
                                onChange={(e) => {
                                    setTrust(e.target.value as "MANAGED" | "USER_REGISTERED");
                                    if (e.target.value !== "MANAGED") setDelivery(false);
                                }}
                            >
                                <option value="USER_REGISTERED">User registered</option>
                                <option value="MANAGED">Managed</option>
                            </select>
                        </label>
                        <button data-testid="save-trust" disabled={a.busy}>
                            Save trust
                        </button>
                    </form>
                )}
            {canDeliver &&
                runtime.status !== "REVOKED" &&
                (runtime.sharedWithWorkspace || runtime.sharedWithUserIds.length > 0) && (
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void a.run(async () => {
                                await runtimeApi.delivery(
                                    runtime.workspaceId,
                                    runtime.id,
                                    delivery,
                                    signal,
                                );
                                await refresh();
                                a.setMessage("Workspace credential delivery updated.");
                            });
                        }}
                    >
                        <h4>Workspace credential delivery</h4>
                        <p>
                            Workspace owners and administrators may approve delivery after hardware
                            trust is managed. Updating hardware trust clears this approval.
                        </p>
                        <label>
                            <input
                                data-testid="credential-delivery"
                                type="checkbox"
                                checked={delivery}
                                disabled={runtime.trustStatus !== "MANAGED"}
                                onChange={(e) => setDelivery(e.target.checked)}
                            />
                            Allow platform credential delivery
                        </label>
                        <button
                            data-testid="save-delivery"
                            disabled={a.busy || runtime.trustStatus !== "MANAGED"}
                        >
                            Save credential delivery
                        </button>
                    </form>
                )}
            <Notice error={a.error} message={a.message} />
        </article>
    );
}

function ServiceAccounts({ workspace }: { workspace: Workspace }) {
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
            <h2>Deployment service accounts</h2>
            <p>
                Use a one-time registration token with VeriQ enroll-service. Registration does not
                grant managed trust.
            </p>
            {!workspace.archived && (
                <form
                    onSubmit={(e) => {
                        const v = values(e);
                        void a.run(async () => {
                            await runtimeApi.createAccount(workspace.id, v.name, signal);
                            await accounts.refetch();
                            a.setMessage("Service account created.");
                        });
                    }}
                >
                    <label>
                        Name
                        <input name="name" required maxLength={160} />
                    </label>
                    <button disabled={a.busy}>Create service account</button>
                </form>
            )}
            {accounts.isPending && <p role="status">Loading service accounts…</p>}
            {accounts.error && <Notice error={accounts.error.message} />}
            {accounts.isSuccess && !accounts.data.pages.some((p) => p.items.length) && (
                <p>No deployment service accounts.</p>
            )}
            {accounts.data?.pages
                .flatMap((p) => p.items)
                .map((account) => (
                    <article key={account.id}>
                        <h3>{account.name}</h3>
                        <p>{account.disabled ? "Disabled" : "Enabled"}</p>
                        {!account.disabled && !workspace.archived && (
                            <>
                                <button
                                    disabled={a.busy}
                                    onClick={() =>
                                        void a.run(async () => {
                                            setToken(
                                                (
                                                    await runtimeApi.issueToken(
                                                        workspace.id,
                                                        account.id,
                                                        signal,
                                                    )
                                                ).token,
                                            );
                                        })
                                    }
                                >
                                    Issue enrollment token
                                </button>
                                <button
                                    disabled={a.busy}
                                    onClick={() =>
                                        void a.run(async () => {
                                            await runtimeApi.disableAccount(
                                                workspace.id,
                                                account.id,
                                                signal,
                                            );
                                            setToken("");
                                            await accounts.refetch();
                                            a.setMessage(
                                                "Service account disabled; its devices can no longer authenticate.",
                                            );
                                        })
                                    }
                                >
                                    Disable service account
                                </button>
                            </>
                        )}
                    </article>
                ))}
            {accounts.hasNextPage && (
                <button onClick={() => void accounts.fetchNextPage()}>
                    Load more service accounts
                </button>
            )}
            {token && (
                <div>
                    <label>
                        One-time enrollment token
                        <input readOnly value={token} autoComplete="off" />
                    </label>
                    <p>
                        Expires in ten minutes. Pass through standard input, never a command
                        argument.
                    </p>
                    <button onClick={() => setToken("")}>Dismiss token</button>
                </div>
            )}
            <Notice error={a.error} message={a.message} />
        </section>
    );
}
