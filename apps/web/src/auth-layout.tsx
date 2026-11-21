/**
 * 认证页共用布局：左侧深色品牌面板与右侧表单区组成独立全屏分栏，脱离应用外壳的侧栏与头部；右上角保留主题与语言切换。
 * AuthCard 提供带一级标题的认证卡片，替代通用 Panel 让登录/初始化/重置页面获得统一的窄栏宽度与满宽提交按钮。
 */

import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";
import { tx, useAppLocale } from "./locale";
import { LanguageDropdown } from "./locale-ui";
import { ThemeToggle } from "./theme-toggle";
import logoDark from "../../../assets/branding/verifyquality-logo-dark.svg";
/**
 * 认证卡片：渲染一级标题（tabIndex=-1 供跳转链接聚焦）与调用方表单内容，样式由 auth.css 的 vq-auth-card 承载。
 * title 沿用 Panel 语义——调用方传入已翻译文本，此处再次 tx 因别名映射保持幂等。
 */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="vq-auth-card">
            <h1 tabIndex={-1}>{tx(title)}</h1>
            {children}
        </section>
    );
}
/**
 * 认证布局：左深色品牌面板（白色 logo + 标语，装饰纯 CSS）在窄屏隐藏；右栏顶部放主题与语言控件，正文居中承载认证路由。
 */
export function AuthLayout() {
    useAppLocale();
    return (
        <div className="vq-auth">
            <aside className="vq-auth-panel">
                <img className="vq-auth-logo" src={logoDark} alt="VeriQ" />
                <p className="vq-auth-tagline">{tx("Reproducible verification, reliable software quality.")}</p>
            </aside>
            <main id="main-content" className="vq-auth-main" tabIndex={-1}>
                <div className="vq-auth-tools">
                    <ThemeToggle />
                    <LanguageDropdown />
                </div>
                <div className="vq-auth-content">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
