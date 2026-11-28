import { _electron, chromium } from "../../apps/desktop/tests/fixtures";
import { readFile, appendFile, realpath, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { constants } from "node:fs";

type Desktop = Awaited<ReturnType<typeof _electron.launch>>;
const command = promisify(execFile);

/**
 * 角色源只暴露 Electron 官方窗口和进程指标的必要字段，不读取 renderer 自报标签或 Linux 可改写的进程标题；实际
 * Electron 模块可直接满足这个窄接口，拒绝测试可以提供受控指标而无需创建或终止进程。
 */
export interface RendererRoleSource {
    BrowserWindow: {
        getAllWindows(): {
            id: number;
            webContents: { id: number; getURL(): string; getOSProcessId(): number };
        }[];
    };
    app: { getAppMetrics(): { pid: number; type: string; creationTime: number }[] };
}

/**
 * 快照把唯一应用窗、webContents、宿主 PID 和官方 Browser/Tab 创建时间绑定成一次故障目标，第二次采样必须逐字段保持同一
 * 身份；这些信息只来自可信主进程，不能作为业务 renderer 的通用参数入口。
 */
export type RendererTarget = {
    mainPid: number;
    rendererPid: number;
    windowId: number;
    contentsId: number;
    executable: string;
    mainCreationTime: number;
    rendererCreationTime: number;
};

/**
 * 同步读取官方进程角色并拒绝缺失、重复、错误类型或无效创建时间，前后快照变化也必须在调用信号辅助器之前失败；
 * 此函数可在 Electron main 内序列化执行，不解析 proc 标题或接受替代角色字符串。
 */
export function rendererTarget(source: RendererRoleSource, previous?: RendererTarget): RendererTarget {
    const windows = source.BrowserWindow.getAllWindows();
    if (windows.length !== 1 || windows[0]!.webContents.getURL() !== "veriq://app/index.html")
        throw new Error("RENDERER_FAULT_APP_WINDOW_REQUIRED");
    const window = windows[0]!;
    const rendererPid = window.webContents.getOSProcessId();
    if (!Number.isSafeInteger(rendererPid) || rendererPid <= 1 || rendererPid === process.pid)
        throw new Error("RENDERER_FAULT_PID_INVALID");
    const metrics = source.app.getAppMetrics();
    const main = metrics.filter((metric) => metric.pid === process.pid);
    const renderer = metrics.filter((metric) => metric.pid === rendererPid);
    if (main.length !== 1 || renderer.length !== 1 || main[0]!.type !== "Browser" || renderer[0]!.type !== "Tab")
        throw new Error("RENDERER_FAULT_METRIC_ROLE_MISMATCH");
    if (![main[0]!.creationTime, renderer[0]!.creationTime].every((time) => Number.isFinite(time) && time > 0))
        throw new Error("RENDERER_FAULT_METRIC_TIME_INVALID");
    const target = {
        mainPid: process.pid,
        rendererPid,
        windowId: window.id,
        contentsId: window.webContents.id,
        executable: process.execPath,
        mainCreationTime: main[0]!.creationTime,
        rendererCreationTime: renderer[0]!.creationTime,
    };
    if (
        previous &&
        (target.mainPid !== previous.mainPid ||
            target.rendererPid !== previous.rendererPid ||
            target.windowId !== previous.windowId ||
            target.contentsId !== previous.contentsId ||
            target.executable !== previous.executable ||
            target.mainCreationTime !== previous.mainCreationTime ||
            target.rendererCreationTime !== previous.rendererCreationTime)
    )
        throw new Error("RENDERER_FAULT_METRIC_IDENTITY_CHANGED");
    return target;
}

/**
 * 恢复证明冻结故障前的 DevTools target，同时只携带已经由主进程验证的新 renderer；它不是可由页面提交的重连参数入口。
 */
export type RendererRecovery = {
    mainPid: number;
    windowId: number;
    contentsId: number;
    oldRendererPid: number;
    rendererPid: number;
    targetId: string;
    url: string;
};

/**
 * Chromium 端口文件只允许两行有界 ASCII 结构，主机由测试固定为回环；任何 URL、额外字段或超界端口都返回有限错误码。
 */
export function parseRendererEndpoint(raw: Buffer): string {
    const browserPath = "/devtools/browser/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    const record = new RegExp(`^([1-9][0-9]{0,4})\\n(${browserPath})\\n?$`, "i");
    const match = raw.length <= 512 && record.exec(raw.toString("utf8"));
    if (!match || Number(match[1]) > 65535) throw new Error("RENDERER_DEVTOOLS_ENDPOINT_INVALID");
    return `ws://127.0.0.1:${match[1]}${match[2]}`;
}

type BindingSource = {
    BrowserWindow: { getAllWindows(): { id: number; webContents: { id: number } }[] };
    webContents: {
        fromDevToolsTargetId: (targetId: string) =>
            | {
                  id: number;
                  getURL(): string;
                  getOSProcessId(): number;
                  getOrCreateDevToolsTargetId(): string;
              }
            | undefined;
    };
};

/**
 * 新驱动页面必须由官方 target 反查到原窗口与 webContents，并保持同主进程和已验证的新 renderer；身份不符不接受候选页面。
 */
export function verifyRendererBinding(source: BindingSource, proof: RendererRecovery): RendererRecovery | null {
    const contents = source.webContents.fromDevToolsTargetId(proof.targetId);
    const windows =
        contents &&
        source.BrowserWindow.getAllWindows().filter(
            (window) => window.id === proof.windowId && window.webContents.id === contents.id,
        );
    const window = windows?.length === 1 ? windows[0] : undefined;
    if (
        process.pid !== proof.mainPid ||
        proof.url !== "veriq://app/index.html" ||
        !/^[a-f0-9]{32}$/i.test(proof.targetId) ||
        !contents ||
        !window ||
        window.id !== proof.windowId ||
        contents.id !== proof.contentsId ||
        contents.getOSProcessId() !== proof.rendererPid ||
        contents.getURL() !== proof.url ||
        contents.getOrCreateDevToolsTargetId() !== proof.targetId ||
        proof.rendererPid <= 1 ||
        proof.rendererPid === proof.oldRendererPid
    )
        return null;
    return { ...proof };
}

/**
 * 端点只读本轮自有档案的固定文件，规范路径和实际读取容量均受检查，辅助器不主动记录地址。
 * 框架原有调试策略仍由套件配置控制，此处不修改全局日志环境。
 */
async function rendererEndpoint(profile: string): Promise<string> {
    const path = join(profile, "electron", "DevToolsActivePort");
    if ((await realpath(path)) !== path) throw new Error("RENDERER_DEVTOOLS_ENDPOINT_INVALID");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 512 || typeof process.getuid !== "function" || stat.uid !== process.getuid())
            throw new Error("RENDERER_DEVTOOLS_ENDPOINT_INVALID");
        const bytes = Buffer.alloc(513);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        return parseRendererEndpoint(bytes.subarray(0, bytesRead));
    } finally {
        await file.close();
    }
}

/**
 * 恢复后只重建驱动会话，新页面仍须匹配故障前 target、原窗口及可信主进程身份；自有连接负责断开。
 */
export async function reconnectRenderer(electron: Desktop, profile: string, proof: RendererRecovery, evidence: string) {
    let endpoint: string;
    try {
        const nativeUserData = await electron.evaluate(({ app }) => app.getPath("userData"));
        if ((await realpath(nativeUserData)) !== (await realpath(join(profile, "electron"))))
            throw new Error("RENDERER_DEVTOOLS_ENDPOINT_INVALID");
        endpoint = await rendererEndpoint(profile);
    } catch {
        throw new Error("RENDERER_DEVTOOLS_ENDPOINT_INVALID");
    }
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const connecting = chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5000 });
    let disconnection: Promise<void> | undefined;
    const disconnect = () => {
        if (disconnection) return disconnection;
        const closing = (browser ? Promise.resolve(browser) : connecting).then(
            (connected) => connected.close(),
            () => {},
        );
        void closing.catch(() => {});
        let deadline: ReturnType<typeof setTimeout> | undefined;
        disconnection = Promise.race([
            closing,
            new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(() => reject(new Error("RENDERER_DRIVER_DISCONNECT_FAILED")), 5000);
            }),
        ])
            .catch(() => {
                throw new Error("RENDERER_DRIVER_DISCONNECT_FAILED");
            })
            .finally(() => {
                if (deadline) clearTimeout(deadline);
            });
        return disconnection;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    const attach = async () => {
        browser = await connecting;
        const candidates = browser
            .contexts()
            .flatMap((context) => context.pages())
            .filter((page) => page.url() === proof.url);
        if (candidates.length !== 1) throw new Error("RENDERER_DRIVER_IDENTITY_CHANGED");
        const page = candidates[0]!;
        const session = await page.context().newCDPSession(page);
        try {
            const result = await session.send("Target.getTargetInfo");
            if (
                result.targetInfo.targetId !== proof.targetId ||
                result.targetInfo.type !== "page" ||
                result.targetInfo.url !== proof.url
            )
                throw new Error("RENDERER_DRIVER_IDENTITY_CHANGED");
            if (!(await electron.evaluate(verifyRendererBinding, proof)))
                throw new Error("RENDERER_DRIVER_IDENTITY_CHANGED");
        } finally {
            await session.detach();
        }
        if (abandoned || !browser.isConnected()) throw new Error("RENDERER_DRIVER_CONNECT_FAILED");
        await appendFile(
            join(evidence, "renderer-fault.log"),
            JSON.stringify({ phase: "driver-rebound", ...proof }) + "\n",
        );
        return { page, disconnect };
    };
    try {
        return await Promise.race([
            attach(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("RENDERER_DRIVER_CONNECT_FAILED")), 5000);
            }),
        ]);
    } catch (error) {
        abandoned = true;
        const primary = new Error(
            error instanceof Error && error.message === "RENDERER_DRIVER_IDENTITY_CHANGED"
                ? "RENDERER_DRIVER_IDENTITY_CHANGED"
                : "RENDERER_DRIVER_CONNECT_FAILED",
        );
        try {
            await disconnect();
        } catch (cleanup) {
            throw new AggregateError([primary, cleanup], "RENDERER_DRIVER_ATTACH_AND_DISCONNECT_FAILED");
        }
        throw primary;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 故障目标只从真实 Electron 唯一应用窗口取得，不接受 renderer 传入 PID；测试用 pidfd 向该 UI renderer 注入异常死亡，
 * 产品恢复处理器仍负责加载原应用，不能由测试主动 reload 或停止
 * 后台来制造通过。
 */
export async function terminateRenderer(electron: Desktop, root: string, evidence: string): Promise<RendererRecovery> {
    if (process.platform !== "linux") throw new Error("RENDERER_FAULT_LINUX_REQUIRED");
    const target = await electron.evaluate(rendererTarget, undefined);
    const targetId = await electron.evaluate(({ webContents }, target) => {
        const contents = webContents.fromId(target.contentsId);
        if (
            !contents ||
            contents.getOSProcessId() !== target.rendererPid ||
            contents.getURL() !== "veriq://app/index.html"
        )
            throw new Error("RENDERER_FAULT_TARGET_CHANGED");
        return contents.getOrCreateDevToolsTargetId();
    }, target);
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
    let recovery: RendererRecovery | undefined;
    try {
        // 第二次官方角色/创建时间核对发生在 gone/load 监听已装好之后，信号辅助器尚未启动；角色漂移不会进入 Python，
        // 也不以先前有效快照为由继续终止已变化的目标。
        await electron.evaluate(rendererTarget, target);
        await appendFile(
            join(evidence, "renderer-fault.log"),
            JSON.stringify({
                phase: "role-verified",
                targetId,
                mainPid: target.mainPid,
                rendererPid: target.rendererPid,
                mainRole: "Browser",
                rendererRole: "Tab",
                mainCreationTime: target.mainCreationTime,
                rendererCreationTime: target.rendererCreationTime,
            }) + "\n",
        );
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
        await appendFile(join(evidence, "renderer-fault.log"), JSON.stringify({ phase: "injected", ...proof }) + "\n");
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
        recovery = {
            mainPid: recovered.mainPid,
            windowId: recovered.windowId,
            contentsId: recovered.contentsId,
            oldRendererPid: target.rendererPid,
            rendererPid: recovered.rendererPid,
            targetId,
            url: recovered.url,
        };
        if (!(await electron.evaluate(verifyRendererBinding, recovery)))
            throw new Error("RENDERER_FAULT_RECOVERY_INVALID");
        await appendFile(
            join(evidence, "renderer-fault.log"),
            JSON.stringify({
                phase: "recovered",
                targetId,
                oldRendererPid: target.rendererPid,
                ...recovered,
            }) + "\n",
        );
    } catch (error) {
        failures.push(error);
    } finally {
        const removal = observer.evaluate((observation) => observation.dispose()).finally(() => observer.dispose());
        void removal.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                removal,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("RENDERER_FAULT_OBSERVER_CLEANUP_PENDING")), 3000);
                }),
            ]);
        } catch (error) {
            failures.push(error);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "RENDERER_FAULT_AND_CLEANUP_FAILED");
    if (!recovery) throw new Error("RENDERER_FAULT_RECOVERY_INVALID");
    return recovery;
}
