/**
 * 认证页集合：登录、首次安装建管理员、申请重置与持 token 确认新密码；确认页成功后立刻清除 location.hash 令牌。
 * 全部走 api.login/initialize/reset*；成功后 refresh 或导航到 /login。
 */

import { tx, useAppLocale } from "../locale";
import { useState, useContext, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Auth } from "../auth-context";
import { Notice, Field, useAction, values, Panel } from "../ui";
/**
 * 邮箱密码登录表单：调用 api.login 后 auth.refresh，失败由 useAction 写入 Notice。已登录用户由路由层 Navigate 到
 * /account，本组件不重复判断。
 */
export function SignIn() {
    useAppLocale();
    const a = useAction(),
        auth = useContext(Auth);
    return (
        <Panel title={tx("Sign in to VeriQ")}>
            <p>{tx("Access your account and workspaces.")}</p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.run(async () => {
                        await api.login({ email: v.email, password: v.password });
                        await auth.refresh();
                    });
                }}
            >
                <Field name="email" label={tx("Email")} type="email" />
                <Field name="password" label={tx("Password")} type="password" />
                <button type="submit" data-testid="login-submit" disabled={a.busy}>
                    {a.busy ? tx("Signing in…") : tx("Sign in")}
                </button>
            </form>
            <Notice error={a.error} />
            <Link to="/reset">{tx("Forgot password?")}</Link>
        </Panel>
    );
}
/**
 * 首次安装：用 installationSecret 创建系统管理员，成功后 setupComplete 并跳转登录。重复初始化由服务端拒绝。仅在
 * setup.initialized=false 时由路由展示；密码最少 12 字符。
 */
export function Setup() {
    useAppLocale();
    const a = useAction(),
        nav = useNavigate(),
        auth = useContext(Auth);
    return (
        <Panel title={tx("Set up VeriQ")}>
            <p>{tx("Create the first system administrator using the installation secret from your operator.")}</p>
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
                <Field
                    name="installationSecret"
                    label={tx("Installation secret")}
                    type="password"
                    longHint={tx("由部署 VeriQ 的运维人员提供，仅用于首次创建系统管理员。")}
                />
                <Field name="email" label={tx("Administrator email")} type="email" />
                <Field name="displayName" label={tx("Display name")} />
                <Field name="password" label={tx("Password (at least 12 characters)")} type="password" minLength={12} />
                <button type="submit" data-testid="setup-submit" disabled={a.busy}>
                    {a.busy ? tx("Creating administrator…") : tx("Create administrator")}
                </button>
            </form>
            <Notice error={a.error} />
        </Panel>
    );
}
/**
 * 提交邮箱触发 api.resetRequest；无论账号是否存在都显示中性成功提示以防枚举。不区分邮箱是否注册；成功文案保持中性以防
 * 止邮箱枚举攻击。实际重置链接由管理员签发或邮件投递，本页不展示令牌。
 */
export function ResetRequest() {
    useAppLocale();
    const a = useAction();
    return (
        <Panel title={tx("Reset your password")}>
            <p>
                {tx(
                    "Ask your system administrator for a short-lived reset link. If email delivery is available, res" +
                        "et instructions will be sent to eligible accounts.",
                )}
            </p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.run(async () => {
                        await api.resetRequest(v.email);
                        a.setMessage("If this account is eligible, your administrator can provide reset instructions.");
                    });
                }}
            >
                <Field name="email" label={tx("Email")} type="email" />
                <button type="submit" data-testid="reset-request-submit" disabled={a.busy}>
                    {a.busy ? tx("Requesting…") : tx("Request password reset")}
                </button>
            </form>
            <Notice error={a.error} message={a.message} />
            <Link to="/login">{tx("Back to sign in")}</Link>
        </Panel>
    );
}
/**
 * 从 location.hash 读取一次性 token 后立即清 hash，再调用 resetConfirm 设置新密码。缺少 token 时仅告警；成功后
 * refresh 会话以便进入账户。
 */
export function ResetConfirm() {
    useAppLocale();
    const auth = useContext(Auth);
    const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
    const a = useAction();
    useEffect(() => {
        history.replaceState(null, "", location.pathname);
    }, []);
    return (
        <Panel title={tx("Choose a new password")}>
            {!token ? (
                <p role="alert">{tx("This reset link is missing its token. Ask your administrator for a new link.")}</p>
            ) : (
                <form
                    onSubmit={(e) => {
                        const v = values(e);
                        void a.run(async () => {
                            await api.resetConfirm({ token, newPassword: v.newPassword });
                            await auth.refresh();
                            a.setMessage(
                                "Password updated. Your previous sessions have been revoked. Sign in with your new p" +
                                    "assword.",
                            );
                        });
                    }}
                >
                    <Field
                        name="newPassword"
                        label={tx("New password (at least 12 characters)")}
                        type="password"
                        minLength={12}
                    />
                    <button type="submit" data-testid="reset-confirm-submit" disabled={a.busy || !!a.message}>
                        {a.busy ? tx("Updating…") : tx("Update password")}
                    </button>
                </form>
            )}
            <Notice error={a.error} message={a.message} />
            <Link to="/login">{tx("Sign in")}</Link>
        </Panel>
    );
}
