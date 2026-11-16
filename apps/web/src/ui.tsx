/**
 * 跨页面复用的轻量 UI 原语负责告警、原生表单字段、异步动作反馈和带标题的 Panel 容器，组件沿用全局 style.css 并让各页面
 * 继续拥有其业务数据。
 * 不绑定 Workspace；错误文案优先展示 ApiError.message。
 */

import { useState, useCallback, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { ApiError } from "./api";
/**
 * 按 role=alert/status 分别展示传入的错误和成功消息，使登录、账户与管理员表单拥有一致且可被辅助技术识别的反馈区域，并
 * 保持消息文本由调用页面决定。
 * 仅渲染传入字符串，不做 i18n；调用方负责把 ApiError 转成可读文本。
 */
export function Notice({ error, message }: { error?: string; message?: string }) {
    return (
        <>
            {error && (
                <p role="alert" data-testid="error">
                    {tx(error)}
                </p>
            )}
            {message && (
                <p role="status" data-testid="success">
                    {tx(message)}
                </p>
            )}
        </>
    );
}
/**
 * 带 label/data-testid 的非受控原生 input 保留浏览器必填及长度校验，并按字段类型选择 maxLength 与 autocomplete，使普通
 * 认证表单直接读取用户当前输入。
 * 用于认证与账户表单；资源 DSL 编辑请改用 features/resources/fields 的 RHF 字段。
 */
export function Field({
    name,
    label,
    type = "text",
    minLength,
}: {
    name: string;
    label: string;
    type?: string;
    minLength?: number;
}) {
    return (
        <label>
            {label}
            <input
                name={name}
                data-testid={name}
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
        </label>
    );
}
/**
 * 封装 busy/error/message 与引用稳定的 run，执行每次传入的异步操作并处理失败；只有当前挂载中的最新动作能够发布忙碌或错
 * 误状态，调用方仍负责业务结果所有权。
 * 页面用其驱动提交按钮 disabled 与 Notice，避免各表单各自维护一套加载状态。
 */
export function useAction() {
    const [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [message, setMessage] = useState("");
    const mounted = useRef(false),
        generation = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            generation.current += 1;
        };
    }, []);
    /**
     * 每次调用仍立即执行本次传入的操作而不排队，代次仅决定谁能发布动作状态；较早完成或卸载后的错误与 finally 不得清除
     * 较新操作的忙碌状态或错误提示。
     */
    const run = useCallback(async (fn: () => Promise<void>): Promise<void> => {
        const request = ++generation.current;
        const current = () => mounted.current && generation.current === request;
        if (!current()) return;
        setBusy(true);
        setError("");
        setMessage("");
        try {
            await fn();
        } catch (e) {
            if (current())
                setError(
                    e instanceof ApiError ? e.message : "Unable to reach VeriQ. Please try again.",
                );
        } finally {
            if (current()) setBusy(false);
        }
    }, []);
    return { busy, error, message, setMessage, run };
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
 * 统一 section.panel + h1 标题壳，包裹登录、账户、管理与多数功能页的主内容区。子树可再嵌套二级标题；子树仍可继续嵌套
 * h2 等二级标题区块。不负责鉴权或 Workspace 选择；子节点自行处理 Navigate
 * 与数据加载。
 */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="panel">
            <h1 tabIndex={-1}>{tx(title)}</h1>
            {children}
        </section>
    );
}
