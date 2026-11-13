import { _electron } from "../../apps/desktop/tests/fixtures";
import { readFile, appendFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
const command = promisify(execFile);

/** 故障目标只从真实 Electron 唯一应用窗口取得，不接受 renderer 传入 PID；测试用 pidfd 向该 UI renderer 注入异常死亡，产品恢复处理器仍负责加载原应用，不能由测试主动 reload 或停止后台来制造通过。 */
export async function terminateRenderer(electron: Desktop, root: string, evidence: string) {
    if (process.platform !== "linux") throw new Error("RENDERER_FAULT_LINUX_REQUIRED");
    const target = await electron.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1 || windows[0]!.webContents.getURL() !== "veriq://app/index.html")
            throw new Error("RENDERER_FAULT_APP_WINDOW_REQUIRED");
        const window = windows[0]!;
        return {
            mainPid: process.pid,
            rendererPid: window.webContents.getOSProcessId(),
            windowId: window.id,
            contentsId: window.webContents.id,
            executable: process.execPath,
        };
    });
    const start = async (pid: number) => {
        const raw = await readFile(`/proc/${pid}/stat`, "utf8");
        return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]!;
    };
    const request = {
        mainPid: target.mainPid,
        rendererPid: target.rendererPid,
        uid: process.getuid!(),
        mainStart: await start(target.mainPid),
        rendererStart: await start(target.rendererPid),
        executable: await realpath(target.executable),
    };
    const observer = await electron.evaluateHandle(({ BrowserWindow }, target) => {
        const window = BrowserWindow.fromId(target.windowId);
        if (
            !window ||
            window.webContents.id !== target.contentsId ||
            window.webContents.getOSProcessId() !== target.rendererPid ||
            window.webContents.getURL() !== "veriq://app/index.html"
        )
            throw new Error("RENDERER_FAULT_TARGET_CHANGED");
        const contents = window.webContents;
        let resolveGone: (value: { reason: string; exitCode: number }) => void;
        let resolveLoaded: () => void;
        const gone = new Promise<{ reason: string; exitCode: number }>((resolve) => {
            resolveGone = resolve;
        });
        const loaded = new Promise<void>((resolve) => {
            resolveLoaded = resolve;
        });
        const onGone = (_event: unknown, details: { reason: string; exitCode: number }) =>
            resolveGone({ reason: details.reason, exitCode: details.exitCode });
        const onLoaded = () => resolveLoaded();
        contents.prependListener("render-process-gone", onGone);
        contents.once("did-finish-load", onLoaded);
        const dispose = () => {
            contents.removeListener("render-process-gone", onGone);
            contents.removeListener("did-finish-load", onLoaded);
            contents.removeListener("destroyed", dispose);
        };
        contents.once("destroyed", dispose);
        return {
            async wait() {
                const [details] = await Promise.all([gone, loaded]);
                return {
                    ...details,
                    mainPid: process.pid,
                    windowId: window.id,
                    contentsId: contents.id,
                    rendererPid: contents.getOSProcessId(),
                    url: contents.getURL(),
                };
            },
            dispose,
        };
    }, target);
    const restored = observer.evaluate(async (observation) => observation.wait());
    void restored.catch(() => {});
    const failures: unknown[] = [];
    try {
        const environment = { ...process.env };
        delete environment.DEBUG;
        const result = await command(
            join(root, "apps/srv/.venv/bin/python"),
            [join(root, "tests/e2e/renderer_fault.py"), JSON.stringify(request)],
            { env: environment, timeout: 5000, maxBuffer: 8192 },
        );
        const proof: unknown = JSON.parse(result.stdout);
        if (
            !proof ||
            typeof proof !== "object" ||
            !("rendererPid" in proof) ||
            proof.rendererPid !== target.rendererPid ||
            !("mainPid" in proof) ||
            proof.mainPid !== target.mainPid ||
            !("uid" in proof) ||
            proof.uid !== request.uid ||
            !("signal" in proof) ||
            proof.signal !== "SIGKILL" ||
            !("exitObserved" in proof) ||
            proof.exitObserved !== true ||
            !("pidfdBound" in proof) ||
            proof.pidfdBound !== true
        )
            throw new Error("RENDERER_FAULT_EXIT_PROOF_INVALID");
        await appendFile(
            join(evidence, "renderer-fault.log"),
            JSON.stringify({ phase: "injected", ...proof }) + "\n",
        );
        const recovered = await restored;
        if (
            !["killed", "crashed"].includes(recovered.reason) ||
            recovered.mainPid !== target.mainPid ||
            recovered.windowId !== target.windowId ||
            recovered.contentsId !== target.contentsId ||
            recovered.rendererPid <= 1 ||
            recovered.rendererPid === target.rendererPid ||
            recovered.url !== "veriq://app/index.html"
        )
            throw new Error("RENDERER_FAULT_RECOVERY_INVALID");
        await appendFile(
            join(evidence, "renderer-fault.log"),
            JSON.stringify({
                phase: "recovered",
                oldRendererPid: target.rendererPid,
                ...recovered,
            }) + "\n",
        );
    } catch (error) {
        failures.push(error);
    } finally {
        const removal = observer
            .evaluate((observation) => observation.dispose())
            .finally(() => observer.dispose());
        void removal.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                removal,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("RENDERER_FAULT_OBSERVER_CLEANUP_PENDING")),
                        3000,
                    );
                }),
            ]);
        } catch (error) {
            failures.push(error);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, "RENDERER_FAULT_AND_CLEANUP_FAILED");
}
