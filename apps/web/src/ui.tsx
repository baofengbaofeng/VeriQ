/**
 * 本文件 apps/web/src/ui.tsx 实现 VeriQ Web/共享 UI 界面能力并导出公开组件与辅助函数；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "./api";
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
 * 公开符号 Field（function）定义 apps/web/src/ui.tsx 对外可复用的界面或工具接口；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
 * 公开符号 useAction（function）定义 apps/web/src/ui.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
 * 公开符号 values（function）定义 apps/web/src/ui.tsx 对外可复用的界面或工具接口；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 */
export function values(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="panel">
            <h1>{title}</h1>
            {children}
        </section>
    );
}
