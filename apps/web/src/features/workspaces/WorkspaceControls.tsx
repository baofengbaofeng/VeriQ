/**
 * 顶栏使用原生成员空间选择器和现有 Sheet。创建操作绑定当前登录身份，账户卸载后忽略旧结果，空间切换不打断请求。
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api";
import { Sheet } from "../../components";
import { tx } from "../../locale";
import { useWorkspaceDirectory } from "./WorkspaceDirectory";

/**
 * 选择与创建都提交给同一个目录，创建失败仍保留当前表单；成功响应提供新实体，不依赖其出现在第一页。
 */
export function WorkspaceControls() {
    const { workspace, items, choose, created, hasMore, more, loadingMore } = useWorkspaceDirectory();
    const [lifetime] = useState(() => new AbortController());
    const signal = lifetime.signal;
    useEffect(() => () => lifetime.abort(), [lifetime]);
    const commit = useRef(created);
    useLayoutEffect(() => {
        commit.current = created;
    }, [created]);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const request = useRef(0);
    const trigger = useRef<HTMLButtonElement>(null);
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const token = ++request.current;
        const current = () => token === request.current && !signal.aborted;
        setBusy(true);
        setError("");
        try {
            const result = await api.createWorkspace(
                { key: String(values.get("key")), name: String(values.get("name")) },
                signal,
            );
            if (!current()) return;
            setBusy(false);
            setOpen(false);
            commit.current(result);
        } catch (failure) {
            if (current()) {
                setError(failure instanceof ApiError ? failure.message : "Unable to reach VeriQ. Please try again.");
                setBusy(false);
            }
        }
    }
    return (
        <>
            <select
                className="vq-workspace-picker"
                aria-label={tx("Workspace")}
                value={workspace?.id ?? ""}
                onChange={(event) => choose(event.target.value)}
            >
                <option value="" disabled>
                    {tx("Select Workspace")}
                </option>
                {items.map((item) => (
                    <option key={item.id} value={item.id}>
                        {item.name}
                        {item.archived ? ` (${tx("Archived")})` : ""}
                    </option>
                ))}
            </select>
            <button
                className="vq-add-workspace"
                ref={trigger}
                type="button"
                onClick={() => {
                    setError("");
                    setBusy(false);
                    setOpen(true);
                }}
            >
                {tx("Add workspace")}
            </button>
            {hasMore && (
                <button type="button" disabled={loadingMore} onClick={more}>
                    {tx("More Workspaces")}
                </button>
            )}
            <Sheet
                open={open}
                title={tx("Add workspace")}
                fallbackFocus={trigger}
                onOpenChange={(next) => {
                    if (!next) request.current += 1;
                    setOpen(next);
                }}
            >
                <form className="vq-workspace-form" onSubmit={(event) => void submit(event)}>
                    <label>
                        {tx("Key")}
                        <input name="key" required pattern={String.raw`[A-Za-z_][A-Za-z0-9_.\-]*`} maxLength={160} />
                    </label>
                    <label>
                        {tx("Name")}
                        <input name="name" required maxLength={160} />
                    </label>
                    {error && <p role="alert">{tx(error)}</p>}
                    <button type="submit" disabled={busy}>
                        {tx("Create Workspace")}
                    </button>
                </form>
            </Sheet>
        </>
    );
}
