/**
 * 工作区成员管理使用已授权的成员记录，用户选择的角色与成员状态同时提交，涉及所有者的变更由服务器再次核验。
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import type { PlatformComponents } from "@veriq/contracts";
import { api, type Workspace } from "../../api";
import { Button, Select, SelectItem } from "../../components";
import { tx } from "../../locale";
import { ConfirmDialog } from "../../locale-ui";
import { canExportWorkspaceTable, collectTablePages, DataTable, useTableView } from "../../table-view";
import { useAction } from "../../ui";
import { useWorkspace } from "./WorkspaceContext";

type Member = PlatformComponents["schemas"]["MemberDTO"];
type ActionMember = Pick<Member, "email" | "userId" | "role" | "status" | "userDisabled">;
type Management = { ws: Workspace; refresh: () => Promise<void> };
const roles = ["OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"] as const;

export function MemberActions({ ws, member, refresh }: Management & { member: ActionMember }) {
    const { signal } = useWorkspace();
    const [open, setOpen] = useState(false);
    const [role, setRole] = useState(member.role);
    const [status, setStatus] = useState(member.status);
    const action = useAction();
    const roleId = useId();
    const statusId = useId();
    if (ws.archived || (ws.role !== "OWNER" && (ws.role !== "ADMIN" || member.role === "OWNER"))) return null;
    return (
        <div className="vq-workspace-form-actions">
            <Dialog.Root
                open={open}
                onOpenChange={(next) => {
                    if (next) {
                        setRole(member.role);
                        setStatus(member.status);
                    }
                    setOpen(next);
                }}
            >
                <Dialog.Trigger asChild>
                    <Button size="compact" tone="secondary">
                        {tx("Edit membership")}
                    </Button>
                </Dialog.Trigger>
                <Dialog.Portal>
                    <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                    <Dialog.Content className="vq-dialog vq-workspace-dialog">
                        <Dialog.Title>{tx("Edit membership")}</Dialog.Title>
                        <Dialog.Description>{member.email}</Dialog.Description>
                        <form
                            className="stack"
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (
                                    action.busy ||
                                    signal?.aborted ||
                                    (role === member.role && status === member.status)
                                )
                                    return;
                                void action.submit(async (complete) => {
                                    await api.updateMember(ws.id, member.userId, { role, status }, signal);
                                    if (signal?.aborted) return;
                                    setOpen(false);
                                    complete("Membership updated");
                                    await refresh();
                                });
                            }}
                        >
                            <label htmlFor={roleId}>
                                {tx("Role")}
                                <Select
                                    id={roleId}
                                    aria-label={tx("Role")}
                                    value={role}
                                    onValueChange={(value) => {
                                        const choice = roles.find((candidate) => candidate === value);
                                        if (choice) setRole(choice);
                                    }}
                                >
                                    {roles
                                        .filter((value) => value !== "OWNER" || ws.role === "OWNER")
                                        .map((value) => (
                                            <SelectItem
                                                key={value}
                                                value={value}
                                                disabled={value === "OWNER" && member.userDisabled}
                                            >
                                                {tx(value)}
                                            </SelectItem>
                                        ))}
                                </Select>
                            </label>
                            <label htmlFor={statusId}>
                                {tx("Membership status")}
                                <Select
                                    id={statusId}
                                    aria-label={tx("Membership status")}
                                    value={status}
                                    onValueChange={(value) => {
                                        if (value === "ACTIVE" || value === "DISABLED") setStatus(value);
                                    }}
                                >
                                    <SelectItem value="ACTIVE">{tx("Active")}</SelectItem>
                                    <SelectItem value="DISABLED">{tx("Disabled")}</SelectItem>
                                </Select>
                            </label>
                            <div className="vq-workspace-form-actions">
                                <Dialog.Close asChild>
                                    <Button type="button" tone="secondary">
                                        {tx("Cancel")}
                                    </Button>
                                </Dialog.Close>
                                <Button
                                    type="submit"
                                    disabled={action.busy || (role === member.role && status === member.status)}
                                >
                                    {tx("Save member")}
                                </Button>
                            </div>
                        </form>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
            <ConfirmDialog
                title="Remove member"
                trigger="Remove member"
                confirmLabel={tx("Remove member")}
                disabled={action.busy}
                confirmAfterClose
                onConfirm={(trigger) => {
                    if (!trigger || signal?.aborted) return;
                    void action.submit(
                        async (complete) => {
                            await api.removeMember(ws.id, member.userId, signal);
                            complete("Member removed");
                            await refresh();
                        },
                        { waitingFrom: trigger, signal },
                    );
                }}
            >
                <p>{tx("Remove {{email}} from this Workspace?", { email: member.email })}</p>
            </ConfirmDialog>
        </div>
    );
}

/**
 * 普通工作区成员从成员接口取得姓名、账号状态和角色，服务器的系统账号目录只在全局管理员视图中使用。
 */
export function MemberRoster({ ws, refresh }: Management) {
    const { signal } = useWorkspace();
    const members = useQuery({
        queryKey: ["workspace-members", ws.id],
        queryFn: ({ signal: request }) =>
            collectTablePages(
                (cursor, active) => api.members(ws.id, cursor, active),
                signal ? AbortSignal.any([signal, request]) : request,
            ),
    });
    const view = useTableView(members.isSuccess ? members.data : [], {
        matches: (member, term) =>
            [member.email, member.displayName, tx(member.role)].some((value) => value.toLowerCase().includes(term)),
    });
    const manage = !ws.archived && (ws.role === "OWNER" || ws.role === "ADMIN");
    return (
        <DataTable
            label={tx("Members")}
            searchLabel={tx("Search users")}
            view={view}
            exportAllowed={canExportWorkspaceTable(ws.role)}
            busy={!members.isSuccess || members.isFetching}
            exportColumns={[
                { label: tx("Email"), value: (row) => row.email },
                { label: tx("Display name"), value: (row) => row.displayName },
                { label: tx("Role"), value: (row) => tx(row.role) },
                { label: tx("Membership status"), value: (row) => tx(row.status === "ACTIVE" ? "Active" : "Disabled") },
            ]}
        >
            {members.isError ? (
                <Button tone="secondary" onClick={() => void members.refetch()}>
                    {tx("Retry members")}
                </Button>
            ) : (
                <div className="table-scroll">
                    <table className="vq-user-table vq-workspace-table">
                        <caption className="vq-visually-hidden">{tx("Members")}</caption>
                        <thead>
                            <tr>
                                <th>{tx("Email")}</th>
                                <th>{tx("Display name")}</th>
                                <th>{tx("Role")}</th>
                                <th>{tx("Membership status")}</th>
                                {manage && <th>{tx("Actions")}</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {view.rows.map((row) => (
                                <tr key={row.userId}>
                                    <td>{row.email}</td>
                                    <td>{row.displayName}</td>
                                    <td>{tx(row.role)}</td>
                                    <td>{tx(row.status === "ACTIVE" ? "Active" : "Disabled")}</td>
                                    {manage && (
                                        <td>
                                            <MemberActions ws={ws} member={row} refresh={refresh} />
                                        </td>
                                    )}
                                </tr>
                            ))}
                            {!view.rows.length && (
                                <tr>
                                    <td colSpan={manage ? 5 : 4}>
                                        {tx(members.isPending ? "Loading users…" : "No matching users.")}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </DataTable>
    );
}
