/**
 * 认证页负责登录、首次安装和密码重置。确认页读取一次性令牌后清除地址栏片段，表单反馈使用共享结果弹窗。
 */

import { tx, useAppLocale } from "../locale";
import { useState, useContext, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Auth } from "../auth-context";
import { Button } from "../components";
import { Field, useAction, values } from "../ui";
import { AuthCard } from "../auth-layout";
/**
 * 先提交邮箱密码再刷新当前身份，失败由异步动作弹窗提示，已登录用户由路由层引导进入账户页面。
 */
export function SignIn() {
    useAppLocale();
    const a = useAction(),
        auth = useContext(Auth);
    return (
        <AuthCard title={tx("Sign in to VeriQ")}>
            <p>{tx("Access your account and workspaces.")}</p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.submit(async () => {
                        await api.login({ email: v.email, password: v.password });
                        await auth.refresh();
                    });
                }}
            >
                <Field name="email" label={tx("Email")} type="email" hint={tx("Account email guidance")} />
                <Field name="password" label={tx("Password")} type="password" hint={tx("Current password guidance")} />
                <Button type="submit" size="regular" disabled={a.busy}>
                    {a.busy ? tx("Signing in…") : tx("Sign in")}
                </Button>
            </form>
            <Link to="/reset">{tx("Forgot password?")}</Link>
        </AuthCard>
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
        <AuthCard title={tx("Set up VeriQ")}>
            <p>{tx("Create the first system administrator using the installation secret from your operator.")}</p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    void a.submit(async () => {
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
                    hint={tx("由部署 VeriQ 的运维人员提供，仅用于首次创建系统管理员。")}
                />
                <Field
                    name="email"
                    label={tx("Administrator email")}
                    type="email"
                    hint={tx("Account email guidance")}
                />
                <Field name="displayName" label={tx("Display name")} hint={tx("Name shown to other members")} />
                <Field
                    name="password"
                    label={tx("Password (at least 12 characters)")}
                    type="password"
                    minLength={12}
                    hint={tx("至少 12 个字符，建议混用字母、数字与符号。")}
                />
                <Button type="submit" size="regular" disabled={a.busy}>
                    {a.busy ? tx("Creating administrator…") : tx("Create administrator")}
                </Button>
            </form>
        </AuthCard>
    );
}
/**
 * 密码重置申请通过相同的确认文案保护邮箱注册状态，实际重置链接由管理员签发或邮件投递，令牌留在独立确认页。
 */
export function ResetRequest() {
    useAppLocale();
    const a = useAction();
    return (
        <AuthCard title={tx("Reset your password")}>
            <p>
                {tx(
                    "Ask your system administrator for a short-lived reset link. If email delivery is available, res" +
                        "et instructions will be sent to eligible accounts.",
                )}
            </p>
            <form
                onSubmit={(e) => {
                    const v = values(e);
                    const submitter = (e.nativeEvent as SubmitEvent).submitter;
                    void a.submit(
                        async (complete) => {
                            await api.resetRequest(v.email);
                            complete("If this account is eligible, your administrator can provide reset instructions.");
                        },
                        { waitingFrom: submitter },
                    );
                }}
            >
                <Field name="email" label={tx("Email")} type="email" hint={tx("Account email guidance")} />
                <Button type="submit" size="regular" disabled={a.busy}>
                    {a.busy ? tx("Requesting…") : tx("Request password reset")}
                </Button>
            </form>
            <Link to="/login">{tx("Back to sign in")}</Link>
        </AuthCard>
    );
}
/**
 * 读取一次性令牌后立即清除地址栏片段，提交成功时冻结已消费的表单并刷新会话，随后由用户返回登录。
 */
export function ResetConfirm() {
    useAppLocale();
    const auth = useContext(Auth);
    const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
    const [done, setDone] = useState(false);
    const a = useAction();
    useEffect(() => {
        history.replaceState(null, "", location.pathname);
    }, []);
    return (
        <AuthCard title={tx("Choose a new password")}>
            {!token ? (
                <p role="alert">{tx("This reset link is missing its token. Ask your administrator for a new link.")}</p>
            ) : (
                <form
                    onSubmit={(e) => {
                        const v = values(e);
                        void a.submit(async (complete) => {
                            await api.resetConfirm({ token, newPassword: v.newPassword });
                            const accepted = complete(
                                "Password updated. Your previous sessions have been revoked. Sign in with your new p" +
                                    "assword.",
                            );
                            if (accepted) setDone(true);
                            await auth.refresh();
                        });
                    }}
                >
                    <Field
                        name="newPassword"
                        label={tx("New password (at least 12 characters)")}
                        type="password"
                        minLength={12}
                        hint={tx("至少 12 个字符，建议混用字母、数字与符号。")}
                    />
                    <Button type="submit" size="regular" disabled={a.busy || done}>
                        {a.busy ? tx("Updating…") : tx("Update password")}
                    </Button>
                </form>
            )}
            <Link to="/login">{tx("Sign in")}</Link>
        </AuthCard>
    );
}
