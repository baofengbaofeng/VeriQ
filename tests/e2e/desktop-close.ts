import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, type _electron } from "../../apps/desktop/tests/fixtures";
import { desktopCloseObservation } from "./desktop-close-observation";
import type { ChildProcess } from "node:child_process";

const command = promisify(execFile);
type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
let observationOwner = 0;

export function observeDesktopProcess(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        throw new Error("TEST_DESKTOP_LIVE_CHILD_REQUIRED");
    const observe = (event: "exit" | "close") =>
        once(child, event).then(([code, signal]) => {
            if (code !== 0 || signal !== null) throw new Error("TEST_DESKTOP_ABNORMAL_EXIT");
        });
    const exited = observe("exit"),
        closed = observe("close");
    void exited.catch(() => {});
    void closed.catch(() => {});
    return { child, exited, closed };
}

type ProcessFacts = ReturnType<typeof observeDesktopProcess>;
const processes = new WeakMap<Desktop, ProcessFacts>();

export function trackDesktop(electron: Desktop) {
    let facts = processes.get(electron);
    if (!facts) {
        const child = electron.process();
        if (!child) throw new Error("TEST_DESKTOP_PROCESS_IDENTITY_UNAVAILABLE");
        facts = observeDesktopProcess(child);
        processes.set(electron, facts);
    }
    return facts;
}

/**
 * 原生确认和同一子进程正常退出后允许重开界面；标准流以及原框架关闭操作有独立回执，后台停止以后仍须全部通过。
 */
export function desktopCloseReceipts(
    facts: ProcessFacts,
    request: Promise<{ confirmed: Promise<void>; framework: Promise<void> }>,
) {
    const framework = request.then((result) => result.framework);
    const exited = new Promise<void>((resolve, reject) => {
        void Promise.all([request.then((result) => result.confirmed), facts.exited]).then(() => resolve(), reject);
        void framework.catch(reject);
    });
    const drained = Promise.all([exited, framework, facts.closed]).then(() => {});
    void drained.catch(() => {});
    return { exited, drained };
}

/**
 * Linux 桌面测试退出仍经过生产原生确认，先登记所属主窗口再向其模态框发送按键，不能用框架 close 绕过确认；
 * 确认失败原样报告，既不强杀未知后台，也不替换 dialog 返回值；最终仍等待 Electron 实际退出及标准流关闭。
 */
export function startTestDesktopClose(electron: Desktop, intent: "cleanup" | "quit") {
    const facts = trackDesktop(electron);
    const { child } = facts;
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
    const request = async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
            record("already-exited");
            throw new Error("TEST_DESKTOP_QUIT_REQUIRES_LIVE_PROCESS");
        }
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
        if (child.exitCode !== null || child.signalCode !== null)
            throw new Error("TEST_DESKTOP_QUIT_REQUIRES_LIVE_PROCESS");
        let frameworkFailed = false;
        const framework = electron.close().then(
            () => record("framework-closed"),
            (error) => {
                frameworkFailed = true;
                throw error;
            },
        );
        record("close-called");
        const confirmed = expect
            .poll(() => {
                if (frameworkFailed || child.exitCode !== null || child.signalCode !== null)
                    throw new Error("TEST_DESKTOP_CONFIRMATION_UNAVAILABLE");
                return command("python", [resolve("../../tests/e2e/native_confirm.py"), native.nativeId]).then(
                    () => {
                        record("native-confirm-sent");
                        return true;
                    },
                    () => {
                        record("native-confirm-failed");
                        return false;
                    },
                );
            })
            .toBe(true);
        return { confirmed, framework };
    };
    const receipts = desktopCloseReceipts(facts, request());
    // 原回执在启动时已经同步登记；此处的时间线仅旁路写入，不能把日志缺失当作进程退出或标准流关闭。
    void facts.exited.then(
        () => record("child-exit"),
        () => record("child-exit"),
    );
    void facts.closed.then(
        () => record("child-close"),
        () => record("child-close"),
    );
    void receipts.drained.then(
        () => record("close-proven"),
        () => {
            if (child.exitCode === null && child.signalCode === null)
                void electron
                    .evaluate(desktopCloseObservation, { ...observation, action: "remove" as const })
                    .catch(() => {});
        },
    );
    return receipts;
}

const ordinary = new WeakMap<Desktop, Promise<void>>();
export function closeTestDesktop(electron: Desktop): Promise<void> {
    let drained = ordinary.get(electron);
    if (!drained) {
        drained = startTestDesktopClose(electron, "cleanup").drained;
        ordinary.set(electron, drained);
    }
    return drained;
}
