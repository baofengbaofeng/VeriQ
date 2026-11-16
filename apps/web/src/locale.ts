/** 全站语言以独立 i18next 实例拥有展示状态，偏好只允许中文或英文并回退浏览器语言；生命周期桥接复用既有资源和 AI 实例，
 * 语言切换不会重建 Workspace、表单、Monaco 或请求控制器。
 */
import i18next, { type i18n } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { editorI18n } from "./features/resources/i18n";
import { aiI18n } from "./features/ai/i18n";
import { commonMessages } from "./locales/common";
import { accountsMessages } from "./locales/accounts";
import { workspacesMessages } from "./locales/workspaces";
import { runtimesMessages } from "./locales/runtimes";
import { plansMessages } from "./locales/plans";
import { editorMessages } from "./locales/editor";
import { interactionMessages } from "./locales/interaction";

import {
    initialLanguage,
    normalizeLanguage as language,
    type AppLanguage,
} from "./locales/preference";
export type { AppLanguage } from "./locales/preference";

const preferenceKey = "veriq.language";
const messages = {
    ...commonMessages,
    ...accountsMessages,
    ...workspacesMessages,
    ...runtimesMessages,
    ...plansMessages,
    ...editorMessages,
    ...interactionMessages,
};
const aliases = new Map<string, string>();
const zh: Record<string, string> = {};
const en: Record<string, string> = {};
for (const [key, pair] of Object.entries(messages)) {
    zh[key] = pair[0];
    en[key] = pair[1];
    aliases.set(key, key);
    aliases.set(pair[0], key);
    aliases.set(pair[1], key);
}

/** 独立应用词条实例不依赖最后初始化的全局 react-i18next 单例，所有共享页面明确引用它；源码文本键禁用点号和冒号分隔，避
 * 免URL、提示句或技术名称被当作嵌套路径解析。
 */
export const appI18n: i18n = i18next.createInstance();
void appI18n.init({
    resources: { zh: { app: zh }, en: { app: en } },
    lng: initialLanguage(),
    fallbackLng: "en",
    supportedLngs: ["zh", "en"],
    ns: ["app"],
    defaultNS: "app",
    interpolation: { escapeValue: false },
    initImmediate: false,
});

let consumers = 0;
let unsubscribe: (() => void) | undefined;
let synchronizing = false;
function synchronize(next: AppLanguage): void {
    if (synchronizing) return;
    synchronizing = true;
    try {
        // 三个实例只同步语言代码，各自命名空间、词条和组件订阅保持独立；同值不再 changeLanguage，事件反馈也被同步锁阻止
        // ，因此不会出现两个实例相互覆盖或无限循环。
        for (const instance of [appI18n, editorI18n, aiI18n]) {
            if (instance.language !== next) void instance.changeLanguage(next);
        }
        if (typeof document !== "undefined")
            document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
        if (typeof window !== "undefined") {
            try {
                window.localStorage.setItem(preferenceKey, next);
            } catch {
                // 用户主动选择仍立即生效，即使宿主没有可写 localStorage；不使用 Cookie 或服务端账户字段代替语言偏好，也
                // 不把存储失败变成登录或业务页面错误。
            }
        }
    } finally {
        synchronizing = false;
    }
}
function acquireBridge(): () => void {
    consumers += 1;
    if (consumers === 1) {
        synchronize(language(appI18n.language));
        const changed = (next: string) => synchronize(language(next));
        for (const instance of [appI18n, editorI18n, aiI18n])
            instance.on("languageChanged", changed);
        const stored = (event: StorageEvent) => {
            if (event.key === preferenceKey && (event.newValue === "zh" || event.newValue === "en"))
                synchronize(event.newValue);
        };
        if (typeof window !== "undefined") window.addEventListener("storage", stored);
        unsubscribe = () => {
            for (const instance of [appI18n, editorI18n, aiI18n])
                instance.off("languageChanged", changed);
            if (typeof window !== "undefined") window.removeEventListener("storage", stored);
        };
    }
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        consumers -= 1;
        if (consumers === 0) {
            unsubscribe?.();
            unsubscribe = undefined;
        }
    };
}

/** 用户切换语言只接受支持的值，并把新值同步给现有命名空间及受限持久化偏好；该入口不重新加载网页、不更改组件 key、不清空
 * 表单和查询，因此未提交字段及报告订阅保持原有归属。
 */
export function setAppLanguage(next: string): void {
    if (next === "zh" || next === "en") synchronize(next);
}

/** 每个实际翻译组件订阅应用实例，并按引用计数拥有语言桥接；桌面单独嵌入共享页面同样获得完整初始化和卸载清理，不需要导入
 * Web 路由入口，也不会永久保留模块级事件监听器。
 */
export function useAppLocale() {
    const translation = useTranslation("app", { i18n: appI18n });
    useEffect(acquireBridge, []);
    return { language: language(translation.i18n.language), setLanguage: setAppLanguage };
}

/** 文案转换只查询明确登记的展示词条，并保留 JSX 文本两端有意义的空格与动态插值；未知内容原样返回，已有反馈消息可经中英
 * 文别名再次转换，而用户资源标识和请求正文不经过此函数。
 */
export function tx(source: string, values?: Record<string, unknown>): string {
    const key = source.trim();
    const canonical = aliases.get(key);
    if (!canonical) return source;
    const text = String(
        appI18n.t(canonical, {
            ...values,
            ns: "app",
            keySeparator: false,
            nsSeparator: false,
            returnObjects: false,
        }),
    );
    return (source.match(/^\s*/)?.[0] ?? "") + text + (source.match(/\s*$/)?.[0] ?? "");
}
