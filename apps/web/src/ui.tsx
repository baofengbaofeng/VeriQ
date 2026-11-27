/**
 * 跨页面复用的轻量 UI 原语负责告警、原生表单字段、异步动作反馈和带标题的 Panel 容器，组件沿用全局 style.css 并让各页面
 * 继续拥有其业务数据。
 * 不绑定 Workspace；错误文案优先展示 ApiError.message。
 */

import { useState, useCallback, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { ApiError } from "./api";
import { tx } from "./locale";
import { Input, Field as FormField } from "./components";
import { useOperationFeedback } from "./operation-feedback";

type CompleteAction = (message: ReactNode, onDismiss?: () => void) => boolean;
type WaitingAction = { waitingFrom: HTMLElement | null; signal?: AbortSignal };
/**
 * 按 role=alert/status 分别展示传入的错误和成功消息，使登录、账户与管理员表单拥有一致且可被辅助技术识别的反馈区域，并
 * 保持消息文本由调用页面决定。
 * 仅渲染传入字符串，不做 i18n；调用方负责把 ApiError 转成可读文本。
 */
export function Notice({ error, message }: { error?: string; message?: string }) {
    return (
        <>
            {error && <p role="alert">{tx(error)}</p>}
            {message && <p role="status">{tx(message)}</p>}
        </>
    );
}
/**
 * 带 label 的非受控输入字段保留浏览器必填及长度校验，并按字段类型选择 maxLength 与 autocomplete；hint 为短
 * 提示直接内联展示，longHint 折叠为「?」图标悬停展示，使普通认证与账户表单获得一致的操作提示。字段结构复用组件库的
 * Field 与 Input，避免重复实现标签、提示与聚焦样式。
 * 用于认证、账户与管理表单；资源 DSL 编辑请改用 features/resources/fields 的 RHF 字段。
 */
export function Field({
    name,
    label,
    type = "text",
    minLength,
    hint,
    longHint,
}: {
    name: string;
    label: string;
    type?: string;
    minLength?: number;
    hint?: string;
    longHint?: string;
}) {
    return (
        <FormField label={label} htmlFor={name} hint={hint} longHint={longHint} required>
            <Input
                id={name}
                name={name}
                type={type}
                required
                minLength={minLength}
                maxLength={type === "password" ? 1024 : type === "email" ? 254 : 160}
                autoComplete={
                    type === "password"
                        ? name === "password"
                            ? "current-password"
                            : "new-password"
                        : name === "email"
                          ? "username"
                          : "off"
                }
            />
        </FormField>
    );
}
/**
 * 统一管理查询和写入的异步状态，只有当前挂载中的最新动作能够发布结果，调用方在服务端确认写入后决定成功文案。
 */
export function useAction() {
    const feedback = useOperationFeedback();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const mounted = useRef(false),
        generation = useRef(0);
    const disposeWaiting = useRef<() => void>();
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            generation.current += 1;
            disposeWaiting.current?.();
        };
    }, []);
    /**
     * 每次动作立即执行。仅当前代次可发布已确认结果，查询继续以就地错误来保留重试；结果已确认后的刷新异常归查询区处理。
     * 结果关闭时仅在相同动作仍有归属的情况下继续交付，离开页面或启动新动作后不会恢复旧界面。
     */
    const execute = useCallback(
        async (fn: (complete: CompleteAction) => Promise<void>, dialog: boolean, options?: WaitingAction) => {
            if (!mounted.current || options?.signal?.aborted) return;
            const request = ++generation.current;
            const current = () => mounted.current && generation.current === request;
            disposeWaiting.current?.();
            const trigger = options?.waitingFrom ?? document.activeElement;
            let waitingClosed = false;
            const waiting =
                options && trigger instanceof HTMLElement
                    ? feedback.showPending("Working…", {
                          trigger,
                          onClose: () => {
                              waitingClosed = true;
                          },
                      })
                    : undefined;
            const dispose = () => {
                waiting?.dismiss();
                options?.signal?.removeEventListener("abort", dispose);
                if (disposeWaiting.current === dispose) disposeWaiting.current = undefined;
            };
            if (waiting) {
                disposeWaiting.current = dispose;
                options?.signal?.addEventListener("abort", dispose, { once: true });
            }
            setBusy(true);
            setError("");
            let succeeded = false;
            try {
                await fn((message, onDismiss) => {
                    if (!dialog || succeeded || !current() || options?.signal?.aborted || waitingClosed) return false;
                    succeeded = true;
                    // 等待提示可在原弹窗内显示成功结果，若调用方须在关闭后交付内容，则保留独立成功弹窗的关闭回调。
                    if (waiting && !onDismiss) {
                        waiting.complete("success", message);
                    } else {
                        waiting?.dismiss();
                        feedback.showSuccess(
                            message,
                            onDismiss &&
                                (() => {
                                    if (current() && !options?.signal?.aborted) onDismiss();
                                }),
                        );
                    }
                    return true;
                });
            } catch (e) {
                if (!current() || options?.signal?.aborted || (e instanceof DOMException && e.name === "AbortError"))
                    return;
                const message = e instanceof ApiError ? e.message : "Unable to reach VeriQ. Please try again.";
                if (!dialog || succeeded) setError(message);
                else if (waiting) waiting.complete("failure", message);
                else feedback.showFailure(message);
            } finally {
                dispose();
                if (current()) setBusy(false);
            }
        },
        [feedback],
    );
    const run = useCallback((fn: () => Promise<void>) => execute(fn, false), [execute]);
    const submit = useCallback(
        (fn: (complete: CompleteAction) => Promise<void>, options?: WaitingAction) => execute(fn, true, options),
        [execute],
    );
    return { busy, error, run, submit };
}
/**
 * 阻止浏览器默认提交并在本次提交时读取 FormData，转成普通认证及管理表单使用的字符串记录，保留非受控字段的当前值而不在
 * 输入过程中发起请求或提交状态。不校验字段；必填与长度由 Field 的原生
 * required/minLength 承担。
 */
export function values(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}
/**
 * 面板保留用于路由聚焦的一级标题。有页面级操作时将其与标题并排，事件、授权和操作状态仍由页面拥有。
 */
export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
    const heading = <h1 tabIndex={-1}>{tx(title)}</h1>;
    return (
        <section className="panel">
            {action ? (
                <div className="vq-page-heading">
                    {heading}
                    {action}
                </div>
            ) : (
                heading
            )}
            {children}
        </section>
    );
}
