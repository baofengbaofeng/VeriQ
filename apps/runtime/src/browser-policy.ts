import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { readPrivate, updatePrivate } from "./offline/config.ts";

export type BrowserMode = "headless" | "headed";

/**
 * 浏览器模式只由可信 Runtime 宿主设置且默认无头，显式配置必须精确匹配枚举；作业快照与资源内容不能覆盖本机显示策略。
 */
export function browserMode(value: unknown): BrowserMode {
    if (value === undefined) return "headless";
    if (value !== "headless" && value !== "headed") throw new Error("INVALID_BROWSER_MODE");
    return value;
}

/**
 * 分发形态复用桌面现有的窄名称规则，已知无头专用文件始终不具备有头资格；官方完整 Chrome 的 Mac 名称也属于支持的
 * 发行形态，名称只作类型筛选，真实发行仍须完成独立版本、库存与哈希校验。
 */
export function browserDistribution(executable: string): "headless-shell" | "headed" | "unknown" {
    const name = basename(executable).toLowerCase();
    if (name.includes("headless") || name.includes("shell")) return "headless-shell";
    return ["chrome", "chrome.exe", "chromium", "chromium.exe", "google chrome for testing"].includes(name)
        ? "headed"
        : "unknown";
}

/**
 * 有头配置同时校验候选名称与解引用后的真实目标，拒绝普通 chrome 别名遮蔽无头专用文件；返回物理路径供实际启动复用，
 * 无头模式保持原候选范围，分发类型检查不能替代固定发行库存与内容哈希授权。
 */
export async function requireBrowserExecutableMode(
    executable: string,
    mode: BrowserMode = "headless",
): Promise<string> {
    if (browserMode(mode) === "headless") return executable;
    if (browserDistribution(executable) !== "headed") throw new Error("HEADED_BROWSER_REQUIRED");
    const physical = await realpath(executable);
    if (browserDistribution(physical) !== "headed") throw new Error("HEADED_BROWSER_REQUIRED");
    return physical;
}

/**
 * 私有档案保存执行端的浏览器选择，只有显式新值才更新；缺少启动选项时重用已保存值，损坏配置或权限错误始终失败关闭。
 */
export async function runtimeBrowserMode(directory: string, explicit?: unknown): Promise<BrowserMode> {
    if (explicit !== undefined) {
        const mode = browserMode(explicit);
        await updatePrivate(directory, "runtime-browser.json", () => ({ browserMode: mode }));
        return mode;
    }
    let stored: unknown;
    try {
        stored = await readPrivate(directory, "runtime-browser.json");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "headless";
        throw error;
    }
    if (
        !stored ||
        typeof stored !== "object" ||
        Array.isArray(stored) ||
        Object.keys(stored).length !== 1 ||
        !("browserMode" in stored) ||
        stored.browserMode === undefined
    )
        throw new Error("INVALID_BROWSER_MODE");
    return browserMode(stored.browserMode);
}
