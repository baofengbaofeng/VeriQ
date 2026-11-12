/**
 * 跨页面复用的轻量 UI 原语：告警、表单字段、异步动作状态与带标题的 Panel 容器。样式类名依赖全局 style.css。
 * 不绑定 Workspace；错误文案优先展示 ApiError.message。
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "./api";
/**
 * 按 role=alert/status 展示 error 与成功 message，供登录、账户与管理表单复用同一反馈槽。
 * 仅渲染传入字符串，不做 i18n；调用方负责把 ApiError 转成可读文本。
 */
export function Notice({ error, message }: { error?: string; message?: string }) {
    return (
        <>
            {error && (
                <p role="alert" data-testid="error">
                    {error}
                </p>
            )}
            {message && (
                <p role="status" data-testid="success">
                    {message}
                </p>
            )}
        </>
    );
}
/**
 * 带 label/data-testid 的受控原生 input，按 type 限制 maxLength 与 autocomplete 策略。
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
 * 封装 busy/error/message 与 run()：串行执行异步动作，捕获 ApiError 并在 finally 清除 busy。
 * 页面用其驱动提交按钮 disabled 与 Notice，避免各表单各自维护一套加载状态。
 */
export function useAction() {
    const [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [message, setMessage] = useState("");
    return {
        busy,
        error,
        message,
        setMessage,
        run: async (fn: () => Promise<void>) => {
            setBusy(true);
            setError("");
            setMessage("");
            try {
                await fn();
            } catch (e) {
                setError(
                    e instanceof ApiError ? e.message : "Unable to reach VeriQ. Please try again.",
                );
            } finally {
                setBusy(false);
            }
        },
    };
}
/**
 * 阻止默认提交并把 FormData 转为 Record<string,string>，供 SignIn/Setup 等非 RHF 表单读取。
 * 不校验字段；必填与长度由 Field 的原生 required/minLength 承担。
 */
export function values(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}
/**
 * 统一 section.panel + h1 标题壳，包裹登录、账户、管理与多数功能页的主内容区。子树可再嵌套二级标题；子树仍可继续嵌套 h2 等二级标题区块。
 * 不负责鉴权或 Workspace 选择；子节点自行处理 Navigate 与数据加载。
 */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="panel">
            <h1>{title}</h1>
            {children}
        </section>
    );
}
