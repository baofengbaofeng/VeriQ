import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

/** 浏览器能力来自可信安装路径的实际版本探测，已知 headless shell 永远不能成为可见浏览器；这个判断只确认分发物类型与钉选版本，目标 OS 的真实可见窗口仍须单独验收。 */
/** 可见模式探测把安装路径、可执行权限、实际版本和已知分发形态分别判断，任何一项不满足都返回不可用；它只能证明安装候选具备启动资格，不能替代目标系统真实显示窗口的验收。
 * 未配置路径与配置了错误路径使用不同说明，帮助用户分辨未安装和损坏分发。
 * 文件名中含 headless 或 shell 时，不能把同一个二进制标成完整可见浏览器。
 * 完整模式只接受已知 Chrome 或 Chromium 可执行文件名。
 * basename 检查不暴露目录，也不接受 renderer 自己提交一个二进制路径。
 * X_OK 检查先于执行，权限错误不会被误报为版本不兼容。
 * 版本查询仅使用固定 --version 参数，不执行 shell 命令字符串。
 * 五秒查询上限防止损坏的可执行文件让整个后台状态一直等待。
 * 八 KiB 输出限制足够容纳版本信息，避免异常程序向宿主发送无界输出。
 * 正则提取四段版本号，不从可执行文件名猜测真实版本。
 * 匹配值来自本发行锁定的 Playwright 浏览器，不使用 Electron 的 UI Chromium。
 * 已知 shell 能运行无头测试，但即使版本正确也不能启用可见选项。
 * 失败返回不含异常堆栈和本机绝对路径的能力摘要。
 * 检测结果中的 source 用来说明能力来源，不能作为批准引擎的信任证明。
 * 签名包和生产引擎仍在执行入口由原有 Runtime 再次核验。
 */
export async function probeBrowser(
    executable: string | undefined,
    headed: boolean,
): Promise<{ available: boolean; version?: string; source: string }> {
    if (!executable) return { available: false, source: "Not configured" };
    const name = basename(executable).toLowerCase();
    const shell = name.includes("headless") || name.includes("shell");
    if (headed && shell)
        return { available: false, source: "Headless shell cannot provide visible windows" };
    if (headed && !["chrome", "chrome.exe", "chromium", "chromium.exe"].includes(name))
        return { available: false, source: "Unrecognized headed browser distribution" };
    try {
        await access(executable, constants.X_OK);
        const result = await promisify(execFile)(executable, ["--version"], {
            timeout: 5000,
            maxBuffer: 8192,
        });
        const version = /\b(\d+\.\d+\.\d+\.\d+)\b/.exec(result.stdout)?.[1];
        return {
            available: version === "158.0.8127.18",
            ...(version ? { version } : {}),
            source: shell ? "Installed headless shell" : "Configured Chromium distribution",
        };
    } catch {
        return { available: false, source: "Executable version probe failed" };
    }
}
