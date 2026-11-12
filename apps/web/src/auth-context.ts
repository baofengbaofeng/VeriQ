/**
 * 跨路由共享的登录态 React Context：持有 User、refresh 与安装完成后的 setupComplete。
 * 默认值仅作 Provider 外的占位；真实状态由 main.tsx 的 App 注入。
 */

import { createContext } from "react";
import type { User } from "./api";
/**
 * 登录态契约：user 为空表示未登录；refresh 重新拉取 session+account；setupComplete 标记已初始化。
 * 各受保护页面用 useContext(Auth) 决定 Navigate 到 /login 或渲染业务 UI。
 */
export type AuthState = {
    user: User | null;
    refresh: () => Promise<void>;
    setupComplete: () => void;
};
/**
 * AuthState 的 createContext 实例，供 SignIn/Account/各功能页读取同一会话而不重复请求。
 * Provider 必须包裹 Routes；会话过期事件会把 user 置空以触发重登。
 */
export const Auth = createContext<AuthState>({
    user: null,
    refresh: async () => {},
    setupComplete: () => {},
});
