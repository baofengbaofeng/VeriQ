import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, type _electron } from "../../apps/desktop/tests/fixtures";
import { desktopCloseObservation } from "./desktop-close-observation";
import type { ChildProcess } from "node:child_process";

const command = promisify(execFile);
type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
const processes = new WeakMap<Desktop, ChildProcess>();
let observationOwner = 0;

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
    const observation = {
        directory: resolve("../..", process.env.VERIQ_DESKTOP_EVIDENCE ?? ".superpowers/sdd/veriq-1/evidence/t19"),
        owner: ++observationOwner,
    };
    const record = (phase: NonNullable<Parameters<typeof desktopCloseObservation>[1]["phase"]>) =>
        desktopCloseObservation(undefined, {
            ...observation,
            action: "write",
            phase,
            intent,
            pid: child.pid,
            code: child.exitCode,
            signal: child.signalCode,
            stdoutDestroyed: child.stdout?.destroyed,
            stderrDestroyed: child.stderr?.destroyed,
            stdoutReadable: child.stdout?.readable,
            stderrReadable: child.stderr?.readable,
        });
    record("entry");
    if (child.exitCode !== null || child.signalCode !== null) {
        record("already-exited");
        if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("TEST_DESKTOP_ABNORMAL_EXIT");
        if (intent === "quit") throw new Error("TEST_DESKTOP_QUIT_REQUIRES_LIVE_PROCESS");
        return;
    }
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const onExit = () => record("child-exit");
    const onClose = () => record("child-close");
    child.once("exit", onExit);
    child.once("close", onClose);
    try {
        const native = await electron.evaluate(({ BrowserWindow }) => {
            const owners = BrowserWindow.getAllWindows().filter(
                (item) => item.webContents.getURL() === "veriq://app/index.html",
            );
            const [owner] = owners;
            if (owners.length !== 1 || !owner) throw new Error("TEST_DESKTOP_MAIN_WINDOW_REQUIRED");
            return {
                nativeId: owner.getNativeWindowHandle().readUInt32LE().toString(),
                windowId: owner.id,
            };
        });
        await electron
            .evaluate(desktopCloseObservation, {
                ...observation,
                windowId: native.windowId,
                action: "install" as const,
            })
            .catch(() => {});
        const closing = electron.close();
        record("close-called");
        void closing.catch(() => {});
        await expect
            .poll(() =>
                command("python", [resolve("../../tests/e2e/native_confirm.py"), native.nativeId]).then(
                    () => {
                        record("native-confirm-sent");
                        return true;
                    },
                    () => {
                        record("native-confirm-failed");
                        return false;
                    },
                ),
            )
            .toBe(true);
        record("await-framework-close");
        await closing;
        record("framework-closed");
        record("await-child-close");
        const result = await closed;
        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        record("close-proven");
    } finally {
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
        if (child.exitCode === null && child.signalCode === null)
            void electron
                .evaluate(desktopCloseObservation, { ...observation, action: "remove" as const })
                .catch(() => {});
    }
}
