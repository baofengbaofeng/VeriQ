/**
 * 认证页集合：登录、首次安装建管理员、申请重置与持 token 确认新密码；确认页成功后立刻清除 location.hash 令牌。
 * 全部走 api.login/initialize/reset*；成功后 refresh 或导航到 /login。
 */

import { useState, useContext, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
/**
 * 邮箱密码登录表单：调用 api.login 后 auth.refresh，失败由 useAction 写入 Notice。
 * 已登录用户由路由层 Navigate 到 /account，本组件不重复判断。
 */
export function SignIn() {
    const a = useAction(),
        auth = useContext(Auth);
    return (
        <Panel title="Sign in to VeriQ">
            <p>Access your account and workspaces.</p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.run(async () => {
                        await api.login({ email: v.email, password: v.password });
                        await auth.refresh();
                    });
                }}
            >
                <Field name="email" label="Email" type="email" />
                <Field name="password" label="Password" type="password" />
                <button data-testid="login-submit" disabled={a.busy}>
                    {a.busy ? "Signing in…" : "Sign in"}
                </button>
            </form>
            <Notice error={a.error} />
            <Link to="/reset">Forgot password?</Link>
        </Panel>
    );
}
/**
 * 首次安装：用 installationSecret 创建系统管理员，成功后 setupComplete 并跳转登录。重复初始化由服务端拒绝。
 * 仅在 setup.initialized=false 时由路由展示；密码最少 12 字符。
 */
export function Setup() {
    const a = useAction(),
        nav = useNavigate(),
        auth = useContext(Auth);
    return (
        <Panel title="Set up VeriQ">
            <p>
                Create the first system administrator using the installation secret from your
                operator.
            </p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.run(async () => {
                        await api.initialize({
                            installationSecret: v.installationSecret,
                            email: v.email,
                            displayName: v.displayName,
                            password: v.password,
                        });
                        auth.setupComplete();
                        nav("/login");
                    });
                }}
            >
                <Field name="installationSecret" label="Installation secret" type="password" />
                <Field name="email" label="Administrator email" type="email" />
                <Field name="displayName" label="Display name" />
                <Field
                    name="password"
                    label="Password (at least 12 characters)"
                    type="password"
                    minLength={12}
                />
                <button data-testid="setup-submit" disabled={a.busy}>
                    {a.busy ? "Creating administrator…" : "Create administrator"}
                </button>
            </form>
            <Notice error={a.error} />
        </Panel>
    );
}
/**
 * 提交邮箱触发 api.resetRequest；无论账号是否存在都显示中性成功提示以防枚举。不区分邮箱是否注册；成功文案保持中性以防止邮箱枚举攻击。
 * 实际重置链接由管理员签发或邮件投递，本页不展示令牌。
 */
export function ResetRequest() {
    const a = useAction();
    return (
        <Panel title="Reset your password">
            <p>
                Ask your system administrator for a short-lived reset link. If email delivery is
                available, reset instructions will be sent to eligible accounts.
            </p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.run(async () => {
                        await api.resetRequest(v.email);
                        a.setMessage(
                            "If this account is eligible, your administrator can provide reset instructions.",
                        );
                    });
                }}
            >
                <Field name="email" label="Email" type="email" />
                <button data-testid="reset-request-submit" disabled={a.busy}>
                    {a.busy ? "Requesting…" : "Request password reset"}
                </button>
            </form>
            <Notice error={a.error} message={a.message} />
            <Link to="/login">Back to sign in</Link>
        </Panel>
    );
}
/**
 * 从 location.hash 读取一次性 token 后立即清 hash，再调用 resetConfirm 设置新密码。
 * 缺少 token 时仅告警；成功后 refresh 会话以便进入账户。
 */
export function ResetConfirm() {
    const auth = useContext(Auth);
    const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
    const a = useAction();
    useEffect(() => {
        history.replaceState(null, "", location.pathname);
    }, []);
    return (
        <Panel title="Choose a new password">
            {!token ? (
                <p role="alert">
                    This reset link is missing its token. Ask your administrator for a new link.
                </p>
            ) : (
                <form
                    onSubmit={(e) => {
                        const v = values(e);
                        void a.run(async () => {
                            await api.resetConfirm({ token, newPassword: v.newPassword });
                            await auth.refresh();
                            a.setMessage(
                                "Password updated. Your previous sessions have been revoked. Sign in with your new password.",
                            );
                        });
                    }}
                >
                    <Field
                        name="newPassword"
                        label="New password (at least 12 characters)"
                        type="password"
                        minLength={12}
                    />
                    <button data-testid="reset-confirm-submit" disabled={a.busy || !!a.message}>
                        {a.busy ? "Updating…" : "Update password"}
                    </button>
                </form>
            )}
            <Notice error={a.error} message={a.message} />
            <Link to="/login">Sign in</Link>
        </Panel>
    );
}
