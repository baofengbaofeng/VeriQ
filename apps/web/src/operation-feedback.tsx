/**
 * 操作结果由 Web、桌面与独立挂载入口共用，触发组件卸载时仍可显示已经确认的结果，多次完成按到达顺序逐个确认。
 */
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { tx, useAppLocale } from "./locale";
import "./operation-feedback.css";

/**
 * 调用者在当前操作完成后发布安全摘要，弹窗不读取请求正文、凭证值或运行时秘密，也不推断未完成的操作是否成功。
 */
type OperationFeedback = {
    showSuccess: (message: ReactNode, onDismiss?: () => void) => void;
    showFailure: (message: ReactNode) => void;
    showPending: (message: ReactNode, options: PendingOptions) => PendingOperation;
};
type TerminalVariant = "success" | "failure";
type PendingOptions = { trigger: HTMLElement; onClose: () => void };
type OperationRetry = { message: ReactNode; onRetry: () => void };
/**
 * 句柄只更新仍在队列里的操作；重试读取复用该条目，保留原来触发按钮的焦点和同一个模态窗口。
 */
export type PendingOperation = {
    update: (message: ReactNode) => void;
    complete: (variant: TerminalVariant, message: ReactNode, retry?: OperationRetry) => void;
    dismiss: () => void;
};
type OperationResult = {
    id: symbol;
    variant: TerminalVariant | "pending";
    message: ReactNode;
    onDismiss?: () => void;
    pending?: PendingOptions;
    retry?: OperationRetry;
};
const OperationFeedbackContext = createContext<OperationFeedback | null>(null);

/**
 * 返回引用稳定的结果发布入口，未接入共享弹窗时立即暴露挂载错误，避免表单在没有用户反馈的情况下完成写入。
 */
export function useOperationFeedback() {
    const feedback = useContext(OperationFeedbackContext);
    if (!feedback) throw new Error("Operation feedback requires its application provider.");
    return feedback;
}

/**
 * 同一个焦点圈定按顺序呈现已提交的结果。最后一个结果关闭后，将焦点还给仍可操作的原控件或新页面主区。
 */
export function OperationFeedbackProvider({ children }: { children: ReactNode }) {
    useAppLocale();
    const [results, setResults] = useState<OperationResult[]>([]);
    const acknowledge = useRef<HTMLButtonElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const afterDismiss = useRef<(() => void)[]>([]);
    const feedback = useMemo<OperationFeedback>(() => {
        const append = (entry: Omit<OperationResult, "id">) => {
            const result = { ...entry, id: Symbol() };
            setResults((queue) => [...queue, result]);
            return result.id;
        };
        return {
            showSuccess: (message, onDismiss) => {
                append({ variant: "success", message, onDismiss });
            },
            showFailure: (message) => {
                append({ variant: "failure", message });
            },
            showPending: (message, options) => {
                const id = append({ variant: "pending", message, pending: options });
                // 同一等待条目原地转为结果，关闭后到达的响应不能重新开窗或改写同队列里的其他操作反馈。
                const ownsPending = (entry: OperationResult) => entry.id === id && entry.variant === "pending";
                return {
                    update: (message) =>
                        setResults((queue) =>
                            queue.map((entry) => (ownsPending(entry) ? { ...entry, message } : entry)),
                        ),
                    complete: (variant, message, retry) =>
                        setResults((queue) =>
                            queue.map((entry) => (ownsPending(entry) ? { ...entry, variant, message, retry } : entry)),
                        ),
                    dismiss: () =>
                        setResults((queue) =>
                            queue.filter((entry) => !ownsPending(entry) && !(entry.id === id && entry.retry)),
                        ),
                };
            },
        };
    }, []);
    const current = results[0];
    const success = current?.variant === "success";
    const waiting = current?.variant === "pending";
    const retry = current?.variant === "failure" ? current.retry : undefined;

    return (
        <OperationFeedbackContext.Provider value={feedback}>
            {children}
            <Dialog.Root
                open={!!current}
                onOpenChange={(open) => {
                    if (open || !current) return;
                    if (current.onDismiss) afterDismiss.current.push(current.onDismiss);
                    if (waiting) current.pending?.onClose();
                    setResults((queue) => queue.filter((entry) => entry.id !== current.id));
                }}
            >
                {current && (
                    <Dialog.Portal>
                        <Dialog.Overlay className="vq-operation-overlay" />
                        <Dialog.Content
                            className="vq-operation-result"
                            data-result={current.variant}
                            onPointerDownOutside={(event) => event.preventDefault()}
                            onOpenAutoFocus={(event) => {
                                event.preventDefault();
                                const previous = current.pending?.trigger ?? document.activeElement;
                                returnFocus.current = previous instanceof HTMLElement ? previous : null;
                                acknowledge.current?.focus();
                            }}
                            onCloseAutoFocus={(event) => {
                                event.preventDefault();
                                const previous = returnFocus.current;
                                if (
                                    previous?.isConnected &&
                                    previous !== document.body &&
                                    !previous.matches(":disabled")
                                ) {
                                    previous.focus({ preventScroll: true });
                                }
                                if (document.activeElement === document.body) {
                                    document
                                        .querySelector<HTMLElement>("main h1[tabindex='-1'], main[tabindex='-1']")
                                        ?.focus({ preventScroll: true });
                                }
                                returnFocus.current = null;
                                // 结果队列清空且 Radix 归还焦点后，再启动后续抽屉，避免两个模态同时争用焦点与访问范围。
                                const continuations = afterDismiss.current.splice(0);
                                for (const continuation of continuations) continuation();
                            }}
                        >
                            {!waiting && (
                                <Dialog.Close type="button" className="vq-operation-close" aria-label={tx("Close")}>
                                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
                                        <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" />
                                    </svg>
                                </Dialog.Close>
                            )}
                            <div className="vq-operation-mark" aria-hidden="true">
                                <svg width="42" height="42" viewBox="0 0 42 42" fill="none" aria-hidden="true">
                                    <circle
                                        cx="21"
                                        cy="21"
                                        r="17"
                                        stroke="currentColor"
                                        strokeWidth="2.5"
                                        strokeDasharray={waiting ? "75 32" : undefined}
                                    />
                                    {!waiting && (
                                        <path
                                            d={success ? "m13 21 5 5 11-11" : "m15 15 12 12m0-12L15 27"}
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    )}
                                </svg>
                            </div>
                            <Dialog.Title>
                                {tx(
                                    waiting
                                        ? "Operation in progress"
                                        : success
                                          ? "Operation succeeded"
                                          : "Operation failed",
                                )}
                            </Dialog.Title>
                            <Dialog.Description asChild>
                                <div
                                    className="vq-operation-message"
                                    aria-live={current.pending ? "polite" : undefined}
                                >
                                    {typeof current.message === "string" ? tx(current.message) : current.message}
                                </div>
                            </Dialog.Description>
                            <div className="vq-operation-actions">
                                {retry && (
                                    <button
                                        type="button"
                                        className="vq-operation-acknowledge vq-operation-retry"
                                        onClick={() => {
                                            acknowledge.current?.focus();
                                            setResults((queue) =>
                                                queue.map((entry) =>
                                                    entry.id === current.id
                                                        ? {
                                                              ...entry,
                                                              variant: "pending",
                                                              message: retry.message,
                                                              retry: undefined,
                                                          }
                                                        : entry,
                                                ),
                                            );
                                            retry.onRetry();
                                        }}
                                    >
                                        {tx("Retry")}
                                    </button>
                                )}
                                <Dialog.Close type="button" ref={acknowledge} className="vq-operation-acknowledge">
                                    {tx(waiting ? "Close" : "OK")}
                                </Dialog.Close>
                            </div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </Dialog.Root>
        </OperationFeedbackContext.Provider>
    );
}
