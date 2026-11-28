import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, type _electron } from "../../apps/desktop/tests/fixtures";
import type { ChildProcess } from "node:child_process";

const command = promisify(execFile);
type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
const processes = new WeakMap<Desktop, ChildProcess>();

/**
 * Linux 桌面测试退出仍经过生产原生确认，先登记所属主窗口再向其模态框发送按键，不能用框架 close 绕过确认；
 * 确认失败原样报告，既不强杀未知后台，也不替换 dialog 返回值；最终仍等待 Electron 实际退出及标准流关闭。
 */
export async function closeTestDesktop(electron: Desktop, intent: "cleanup" | "quit" = "cleanup"): Promise<void> {
    let child = processes.get(electron);
    if (!child) {
        try {
            child = electron.process();
            processes.set(electron, child);
        } catch {
            throw new Error("TEST_DESKTOP_PROCESS_IDENTITY_UNAVAILABLE");
        }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
        if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("TEST_DESKTOP_ABNORMAL_EXIT");
        if (intent === "quit") throw new Error("TEST_DESKTOP_QUIT_REQUIRES_LIVE_PROCESS");
        return;
    }
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const nativeId = await electron.evaluate(({ BrowserWindow }) => {
        const owners = BrowserWindow.getAllWindows().filter(
            (item) => item.webContents.getURL() === "veriq://app/index.html",
        );
        if (owners.length !== 1) throw new Error("TEST_DESKTOP_MAIN_WINDOW_REQUIRED");
        return owners[0]!.getNativeWindowHandle().readUInt32LE().toString();
    });
    const closing = electron.close();
    void closing.catch(() => {});
    await expect
        .poll(() =>
            command("python", [resolve("../../tests/e2e/native_confirm.py"), nativeId]).then(
                () => true,
                () => false,
            ),
        )
        .toBe(true);
    await closing;
    const result = await closed;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
}
