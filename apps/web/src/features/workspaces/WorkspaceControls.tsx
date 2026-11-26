/**
 * 顶栏提供成员空间菜单和居中的新建对话框。创建操作绑定当前登录身份，账户卸载后忽略旧结果，空间切换不打断请求。
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Link } from "react-router-dom";
import icons from "../../admin-icons.svg?no-inline";
import { api, ApiError, type Workspace } from "../../api";
import { Button, Field, Input } from "../../components";
import { tx } from "../../locale";
import { useOperationFeedback } from "../../operation-feedback";
import { useWorkspaceDirectory } from "./WorkspaceDirectory";
import "./workspace-management.css";

/**
 * 归档工作区继续出现在当前选择和成员目录中，两处共用一个本地化名称，方便用户辨认只读空间。
 */
function workspaceLabel(item: Workspace) {
    return item.archived ? `${item.name} ${tx("(Archived)")}` : item.name;
}

/**
 * 分页只更新菜单。键盘用户提交后从第一条新记录继续浏览，移动到别处或关闭菜单则不再转移焦点。
 */
function WorkspaceMenu() {
    const { workspace, items, choose, loading, error, retry, nextCursor, more, loadingMore, pagingError } =
        useWorkspaceDirectory();
    const content = useRef<HTMLDivElement>(null);
    const action = useRef<HTMLDivElement>(null);
    const previous = useRef<{ cursor: string; ids: Set<string>; focused: boolean }>();
    const label = workspace ? workspaceLabel(workspace) : tx("Select Workspace");
    useLayoutEffect(() => {
        const pending = previous.current;
        if (!pending || loadingMore || !content.current || (pending.cursor === nextCursor && !pagingError)) return;
        previous.current = undefined;
        if (!pending.focused || pagingError) return;
        if (document.activeElement !== action.current && document.activeElement !== document.body) return;
        const next = items.find((item) => !pending.ids.has(item.id)) ?? items.at(-1);
        const row = next && content.current.querySelector<HTMLElement>(`[data-workspace-id="${next.id}"]`);
        (row || content.current).focus();
    }, [items, loadingMore, pagingError, nextCursor]);
    return (
        <DropdownMenu.Root
            modal={false}
            onOpenChange={(open) => {
                if (!open) previous.current = undefined;
            }}
        >
            <DropdownMenu.Trigger
                className="vq-workspace-picker"
                data-workspace-id={workspace?.id ?? ""}
                aria-label={`${tx("Workspace")}: ${label}`}
                title={label}
            >
                <span>{label}</span>
                <svg aria-hidden="true" width="16" height="16">
                    <use href={`${icons}#account-chevron`} />
                </svg>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    ref={content}
                    className="vq-workspace-menu"
                    align="start"
                    sideOffset={4}
                    collisionPadding={8}
                >
                    <DropdownMenu.RadioGroup value={workspace?.id ?? ""} onValueChange={choose}>
                        {items.map((item) => {
                            const optionName = workspaceLabel(item);
                            return (
                                <DropdownMenu.RadioItem
                                    key={item.id}
                                    value={item.id}
                                    data-workspace-id={item.id}
                                    className="vq-menu-item"
                                    textValue={optionName}
                                    title={optionName}
                                >
                                    <span className="vq-workspace-option-name">{optionName}</span>
                                    <DropdownMenu.ItemIndicator className="vq-workspace-check">
                                        <svg aria-hidden="true" width="14" height="14">
                                            <use href={`${icons}#check`} />
                                        </svg>
                                    </DropdownMenu.ItemIndicator>
                                </DropdownMenu.RadioItem>
                            );
                        })}
                    </DropdownMenu.RadioGroup>
                    {!items.length && !error && (
                        <span className="vq-menu-item" role="status">
                            {tx(loading ? "Loading Workspaces…" : "No Workspaces yet.")}
                        </span>
                    )}
                    {error && (
                        <DropdownMenu.Item
                            className="vq-menu-item"
                            onSelect={(event) => {
                                event.preventDefault();
                                retry();
                            }}
                        >
                            {tx("Retry Workspaces")}
                        </DropdownMenu.Item>
                    )}
                    {nextCursor && (
                        <DropdownMenu.Item
                            className="vq-menu-item"
                            ref={action}
                            aria-disabled={loadingMore}
                            onSelect={(event) => {
                                event.preventDefault();
                                if (loadingMore) return;
                                previous.current = {
                                    cursor: nextCursor,
                                    ids: new Set(items.map((item) => item.id)),
                                    focused: action.current === document.activeElement,
                                };
                                more();
                            }}
                        >
                            {tx(
                                loadingMore
                                    ? "Loading Workspaces…"
                                    : pagingError
                                      ? "Retry more workspaces"
                                      : "More Workspaces",
                            )}
                        </DropdownMenu.Item>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

/**
 * 选择与创建都提交给同一个目录，创建失败仍保留当前表单；成功响应提供新实体，不依赖其出现在第一页。
 */
export function WorkspaceControls({ visible }: { visible: boolean }) {
    const { created } = useWorkspaceDirectory();
    const feedback = useOperationFeedback();
    const [lifetime] = useState(() => new AbortController());
    const signal = lifetime.signal;
    useEffect(() => () => lifetime.abort(), [lifetime]);
    const commit = useRef(created);
    useLayoutEffect(() => {
        commit.current = created;
    }, [created]);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const request = useRef(0);
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const token = ++request.current;
        const current = () => token === request.current && !signal.aborted;
        setBusy(true);
        try {
            const result = await api.createWorkspace(
                { key: String(values.get("key")), name: String(values.get("name")) },
                signal,
            );
            if (!current()) return;
            setBusy(false);
            setOpen(false);
            commit.current(result);
            feedback.showSuccess("Workspace created");
        } catch (failure) {
            if (current()) {
                feedback.showFailure(
                    failure instanceof ApiError ? failure.message : "Unable to reach VeriQ. Please try again.",
                );
                setBusy(false);
            }
        }
    }
    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (next) {
                    setBusy(false);
                } else {
                    request.current += 1;
                }
                setOpen(next);
            }}
        >
            {visible && <WorkspaceMenu />}
            <Dialog.Trigger asChild>
                <button
                    className="vq-workspace-icon"
                    aria-label={tx("Add workspace")}
                    title={tx("Add workspace")}
                    type="button"
                >
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20">
                        <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </button>
            </Dialog.Trigger>
            <Link
                className="vq-workspace-icon"
                to="/workspaces"
                aria-label={tx("Workspace settings")}
                title={tx("Workspace settings")}
            >
                <svg aria-hidden="true" width="20" height="20">
                    <use href={`${icons}#settings`} />
                </svg>
            </Link>
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                <Dialog.Content className="vq-dialog vq-workspace-dialog">
                    <div className="vq-card-heading">
                        <Dialog.Title>{tx("Add workspace")}</Dialog.Title>
                        <Dialog.Close className="vq-sheet-close" aria-label={tx("Close")}>
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                                <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
                            </svg>
                        </Dialog.Close>
                    </div>
                    <Dialog.Description className="vq-workspace-key-hint">
                        {tx("One project is one Workspace. Membership controls access to its resources.")}
                    </Dialog.Description>
                    <form
                        className="vq-workspace-form vq-workspace-compact-form"
                        onSubmit={(event) => void submit(event)}
                    >
                        <Field htmlFor="workspace-key" label={tx("Key")} hint={tx("Workspace key guidance")} required>
                            <Input
                                id="workspace-key"
                                name="key"
                                required
                                pattern={String.raw`[A-Za-z_][A-Za-z0-9_.\-]*`}
                                maxLength={160}
                            />
                        </Field>
                        <Field
                            htmlFor="workspace-name"
                            label={tx("Name")}
                            hint={tx("Workspace name guidance")}
                            required
                        >
                            <Input id="workspace-name" name="name" required maxLength={160} />
                        </Field>
                        <div className="vq-workspace-form-actions">
                            <Dialog.Close asChild>
                                <Button size="regular" tone="secondary">
                                    {tx("Cancel")}
                                </Button>
                            </Dialog.Close>
                            <Button type="submit" size="regular" disabled={busy}>
                                {tx("Create Workspace")}
                            </Button>
                        </div>
                    </form>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
