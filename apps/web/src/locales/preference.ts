/**
 * 语言偏好只允许已提供词条的中文或英文，读取失败时回退浏览器首选语言而不阻断应用启动；此模块没有 React、业务实例或事件
 * 监听依赖，供各独立翻译实例在首次初始化时取得一致语言。
 */
export type AppLanguage = "zh" | "en";
/**
 * 浏览器可能上报 zh-CN 等地区变体，应用只持久化精确的 zh 或 en；其他浏览器语言统一使用英文资源，不接受任意输入成为动态
 * 命名空间或本地文件路径。
 */
export function normalizeLanguage(value: string): AppLanguage {
    return /^zh(?:-|$)/i.test(value) ? "zh" : "en";
}
/**
 * 只有已校验的偏好才能覆盖浏览器语言，隐私模式禁止 localStorage 时保持内存体验；读取语言不会访问服务端、账户凭据或
 * Cookie，也不写入任意未经支持的语言值。
 */
export function initialLanguage(): AppLanguage {
    if (typeof window !== "undefined") {
        try {
            const saved = window.localStorage.getItem("veriq.language");
            if (saved === "zh" || saved === "en") return saved;
        } catch {
            // 被浏览器策略阻止的非敏感偏好存储只影响刷新后的记忆能力，不改变任何身份和授权状态；回退当前浏览器语言仍可
            // 保证整个应用及各编辑器实例首屏使用同一套词条。
        }
    }
    return normalizeLanguage(typeof navigator === "undefined" ? "en" : navigator.language);
}
