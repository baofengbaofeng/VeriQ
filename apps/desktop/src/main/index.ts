import {
    app,
    BrowserWindow,
    ipcMain,
    protocol,
    session,
    safeStorage,
    net,
    Tray,
    Menu,
    nativeImage,
    dialog,
    shell,
} from "electron";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, open, lstat, copyFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
    loadRuntimeDistribution,
    type RuntimeDistribution,
} from "../../../runtime/src/distribution.ts";
import { isNode24Version } from "../../../runtime/src/node-version.ts";
import { DesktopAgentClient } from "../agent/client";
import { HostSession, controlOrigin } from "./session";
import { requireCookieProtection } from "./cookie-protection";
import { prepareCookieStorage } from "./cookie-migration";
import { object, parseSchema, resolveOperation } from "./policy";
import { authorizeSender } from "./scope";
import { openNativeTrace } from "./trace-window";
import { openNativeImage } from "./image-window";
import { withArtifactExport } from "./artifact-export";
import { bundledAssetPath } from "./asset-path";
import { routingOverride } from "../shared/routing";
import { assertAgentReconfigurationAllowed } from "../shared/credential-status";
import type { CloudOperation } from "../shared/operations.generated";
import type { DesktopState } from "../shared/bridge";
import {
    privateDirectory,
    readPrivate,
    updatePrivate,
} from "../../../runtime/src/offline/config.ts";

/** 主进程负责桌面窗口、普通登录网络与独立后台的连接边界，启动配置只从可信安装路径或开发启动器读取；这些进程级设置不能通过资源 DSL、资源包内容或 renderer 自选路径覆盖。
 * 模块目录用于定位随包的 preload、renderer 和独立 Agent JavaScript。
 * 默认档案位于 Electron 的用户数据目录，安装升级不应把用户证据放进程序目录。
 * 测试或可信开发启动器可显式给出独立档案，以隔离设备、Cookie 和历史。
 * 自定义档案时 Electron userData 放在其 electron 子目录。
 * 这样同档案的单实例锁、Cookie 分区和后台配置属于一致的本机身份。
 * 窗口产品名使用 VeriQ，主进程 title 使用技术进程名 veriq。
 * 应用协议在 Electron ready 之前登记为标准且安全的来源。
 * supportFetchAPI 仅让同来源的资源和 worker 正常工作，不授予任意 HTTP。
 * 全局 window 指向当前授权主窗口，证据窗口不会替换这个引用。
 * quitting 区分用户明确退出与普通关闭按钮事件。
 * 普通关闭保留后台，明确退出也只结束 UI，不顺带停止独立 Node。
 * HostSession 的 origin 与设备配置中的 origin 分开保存并各自校验。
 * 默认 loopback 仅用于本机开发，正式配置仍要求 HTTPS。
 * 代理值由有限配置接口校验，不接收包含用户名和密码的代理 URL。
 * AgentClient 从私有档案取得 socket 和 nonce，页面不会获得这两项。
 * 开发默认 Node 路径指向资源目录，安装模式改由完整发行清单派生角色路径。
 * Node 的实际版本还会在启动时核对，不能仅凭文件名 node 假设匹配。
 * 默认引擎目录与测试浏览器目录都是安装资源路径。
 * 开发可见浏览器允许单独配置，安装模式使用同一完整 Chrome，不把 headless shell 重新标记为有界面。
 * 这些配置仅决定本机执行候选，真正执行前 Runtime 仍核验发行与签名包。
 * 没有从 renderer 暴露 env、argv、任意读写文件或进程启动接口。
 */
const directory = dirname(fileURLToPath(import.meta.url));
const profile = process.env.VERIQ_DESKTOP_PROFILE ?? join(app.getPath("userData"), "profile");
if (process.env.VERIQ_DESKTOP_PROFILE) app.setPath("userData", join(profile, "electron"));
app.setName("VeriQ");
process.title = "veriq";
protocol.registerSchemesAsPrivileged([
    { scheme: "veriq", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let installed: RuntimeDistribution | undefined;
let host: HostSession;
let origin = "http://127.0.0.1:8888";
let proxy = "";
const client = new DesktopAgentClient(profile);
const node24 =
    process.env.VERIQ_DESKTOP_NODE ??
    join(process.resourcesPath, "node", process.platform === "win32" ? "node.exe" : "bin/node");
const runtime = {
    engineVersion: process.env.VERIQ_DESKTOP_ENGINE_VERSION ?? "1.0.0",
    engineDirectory: process.env.VERIQ_DESKTOP_ENGINE ?? join(process.resourcesPath, "engine"),
    browserExecutable:
        process.env.VERIQ_DESKTOP_BROWSER ?? join(process.resourcesPath, "browser", "chrome"),
    ...(process.env.VERIQ_DESKTOP_HEADED_BROWSER
        ? { headedExecutable: process.env.VERIQ_DESKTOP_HEADED_BROWSER }
        : {}),
};

/** 连接已有后台优先于拉起新进程，只有明确的不可用或首次档案缺失才进入启动路径；已损坏的描述文件与未知错误必须原样失败，避免错误重启抢占仍在执行的同一档案。
 * 先调用真实 status，成功说明该 nonce 和 socket 对应的后台能处理协议。
 * 仅看到 socket 文件存在不足以证明进程可用，因此不采用文件存在即成功。
 * 启动配置写入之前，选定 Node 必须实测为稳定24.x，安装发行还须与清单具体版本一致。
 * 版本探测使用 execFile 和参数数组，不经 shell 拼接。
 * 十秒版本探测只限制这个工具查询，不改变业务用例时限。
 * 后台配置写入使用私有原子配置接口，包含当前明确选择的控制 Origin。
 * 日志打开为追加模式，重连不会覆盖前一次后台启动的诊断。
 * 新日志的权限限制为当前用户，避免把后台诊断交给其它本机账户。
 * 独立 Node 只执行随包 agent.js，运行时不使用开发 tsx 入口。
 * detached 让后台生命周期脱离 UI 进程的正常关闭。
 * 标准输入忽略，后台不能等待一个已经退出的 UI 提供终端输入。
 * 输出和错误都写本机日志，不保留继承 GUI 驱动管道的句柄。
 * 明确代理配置通过 Node 原生代理环境变量传入。
 * 没有代理设置时不人为伪造一个不同于系统环境的网络路径。
 * unref 解除 UI 事件循环对该 child 的等待，不代表后台已经执行成功。
 * 主进程关闭自己的日志 fd，child 继续持有它已继承的句柄。
 * 启动后通过有限次数的实际状态请求等待协议可用。
 * 等待之间的短延时只用于 IPC 就绪检查，不参与业务正确性判定。
 * 最终不可用时返回 AGENT_START_FAILED，界面仍可显示其它本地信息。
 * 后台自身的档案锁负责并发启动排他，不能仅依赖 UI 的单实例锁。
 * 此处不杀死未知 PID，也不删除无法证明属于本档案的进程资源。
 */
async function ensureAgent(): Promise<void> {
    try {
        await client.call({ operation: "status" });
        return;
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !(
                ["AGENT_UNAVAILABLE", "AGENT_REQUEST_TIMEOUT"].includes(error.message) ||
                (error as NodeJS.ErrnoException).code === "ENOENT"
            )
        )
            throw error;
    }
    const agentNode = installed?.agentExecutable ?? node24;
    const version = await promisify(execFile)(agentNode, ["--version"], { timeout: 10000 });
    const actualNode = version.stdout.trim();
    if (
        !actualNode.startsWith("v") ||
        !isNode24Version(actualNode.slice(1)) ||
        (installed && actualNode !== `v${installed.nodeVersion}`)
    )
        throw new Error("INDEPENDENT_NODE24_REQUIRED");
    await updatePrivate(profile, "desktop-config.json", () => ({
        origin,
        ...(installed
            ? {
                  distributionRoot: installed.root,
                  engineDirectory: installed.engineDirectory,
                  engineVersion: installed.engineVersion,
                  browserExecutable: installed.browserExecutable,
                  headedExecutable: installed.browserExecutable,
              }
            : runtime),
    }));
    const log = await open(join(profile, "agent.log"), "a", 0o600);
    const child = spawn(
        agentNode,
        [installed?.agentEntry ?? join(directory, "agent.js"), profile],
        {
            detached: true,
            stdio: ["ignore", log.fd, log.fd],
            env: {
                ...process.env,
                ...(proxy
                    ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_USE_ENV_PROXY: "1" }
                    : {}),
            },
        },
    );
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            await client.call({ operation: "status" });
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error("AGENT_START_FAILED");
}

/** 公开状态组合普通会话的最小投影与后台的无密钥事实，后台暂时无法连接时仍允许窗口显示已配置 Origin 和 UI 版本；这里不会因为轮询而重新启动用户明确停止的后台。
 * 后台读取失败时 agent 字段缺省，页面据此显示不可用。
 * 用户信息来自 HostSession 的 PublicSession，不含 masked CSRF。
 * 工作区信息来自最近一次服务端成员校验，不由 renderer 写入角色。
 * 托盘能力反映实际是否创建 Tray 对象，不把桌面环境名称当作已显示图标证明。
 * 版本使用 Electron app 读取的本包版本，不把执行引擎版本混入 UI 版本。
 * 有条件展开字段避免把 undefined 伪装成一个存在但无效的登录对象。
 * 状态读取不触发登录恢复、设备注册或在线任务领取。
 * 控制平台离线和后台离线是两个不同事实，界面可以分别呈现。
 */
async function state(): Promise<DesktopState> {
    let agent: DesktopState["agent"];
    try {
        agent = (await client.call({ operation: "status" })) as DesktopState["agent"];
    } catch {
        agent = undefined;
    }
    return {
        origin,
        ...(host.user ? { user: host.user } : {}),
        ...(host.workspace ? { workspace: host.workspace } : {}),
        ...(agent ? { agent } : {}),
        tray: !!tray,
        version: app.getVersion(),
    };
}

/** 恢复入口总是作用于已拥有的主窗口，先显示再恢复并请求焦点，供托盘、系统激活和第二实例共用；它不创建新窗口、不建立新后台，也不改变当前执行或用户的 Workspace 选择。
 * 隐藏到托盘的窗口需要 show 才重新出现在桌面。
 * 已经最小化的窗口需要 restore 才能恢复到可交互状态。
 * focus 是对系统窗口管理器的请求，不保证抢占其它应用焦点。
 * 可选链处理启动阶段尚未创建主窗口的激活事件。
 * 证据窗口有独立生命周期，不参与这个应用恢复入口。
 */
function show() {
    window?.show();
    window?.restore();
    window?.focus();
}
/** 涉及退出、停止、解绑和原始证据的确认由主进程创建真实原生对话框，renderer 只能请求某个有限操作而不能直接提交确认结果；对话框默认选择取消，关闭对话框同样视为未授权。
 * 必须存在当前主窗口，不能在未绑定窗口身份时弹出后台确认。
 * 原生对话框绑定该窗口，测试也据此精确识别 transient 所属关系。
 * 按钮文案同时给出中英文，避免系统语言与应用语言不同导致误解。
 * defaultId 选择取消，按回车不会默认批准可能影响执行的操作。
 * cancelId 同样选择取消，Escape 或关闭都不会变成确认。
 * 只有第二个按钮的实际响应值才返回 true。
 * 业务分支负责说明具体影响，不把模糊确认当成任意未来操作的授权。
 * 该函数不接受从 renderer 传来的 response 或 confirmed 字段。
 * 确认通过后仍要执行原有权限与资源归属检查。
 * 用户取消不是后台执行失败，各调用分支按自身约定返回或 USER_CANCELLED。
 */
async function confirm(message: string) {
    if (!window) throw new Error("WINDOW_UNAVAILABLE");
    const answer = await dialog.showMessageBox(window, {
        type: "warning",
        message,
        buttons: ["取消 / Cancel", "确认 / Confirm"],
        defaultId: 0,
        cancelId: 0,
    });
    return answer.response === 1;
}

/** 本机命令白名单是 renderer 到后台之间的第二道有限能力边界，不能把后台内部的停止、证据导出或查看器保活命令原样透传；主进程先处理必须原生确认的业务动作，再连接固定档案的 Agent。
 * 输入先限制为普通对象，不能以数组或异常原型模拟操作信封。
 * operation 必须是明确列举的业务名，不接受命令行程序名。
 * 后台还会逐项核验参数，因此这个白名单不替代 Node 的校验。
 * 清理缓存可能删除离线可用资源，必须先向用户展示影响。
 * 解绑撤销的是设备身份，不等同普通员工登出。
 * 原生确认取消时不会先向后台发送删除或解绑命令。
 * 运行参数中的环境覆盖再次用有限路由解析器校验。
 * 确认内容包含实际覆盖 URL，使用户知道业务请求和凭证将发向哪里。
 * 空覆盖对象沿用签名环境，不弹出没有实际变化的确认。
 * 已经确认的覆盖值仍由 Node 校验，并由 Runtime 标记 dirty。
 * 本方法不接受本机任意文件、目录或 executable 参数。
 * 后台未启动时调用受控 ensureAgent，不能由页面选择另一套 Node。
 * 最终只转交这个经过白名单和必要原生授权的命令对象。
 * 回执错误直接返回给页面，不自动重放可能已产生副作用的请求。
 * 正在准备执行的取消使用独立 startupId，真实 Run 取消仍使用 RunID。
 */
async function local(input: unknown) {
    const command = object(input);
    const allowed = [
        "status",
        "select",
        "doctor",
        "enroll",
        "pollEnrollment",
        "device",
        "unbind",
        "trust",
        "download",
        "snapshot",
        "source",
        "credentials",
        "setCredential",
        "removeCredential",
        "run",
        "cancel",
        "report",
        "upload",
        "onlineStart",
        "onlineStop",
        "migrateCredentials",
        "recoverCredentialInitialization",
        "clearBundle",
        "recover",
    ];
    if (typeof command.operation !== "string" || !allowed.includes(command.operation))
        throw new Error("IPC_OPERATION_DENIED");
    if (
        ["clearBundle", "unbind"].includes(command.operation) &&
        !(await confirm(
            "此操作会移除本机资源或设备绑定。继续？ / Remove local data or device binding?",
        ))
    )
        throw new Error("USER_CANCELLED");
    if (command.operation === "run" && command.overrides !== undefined) {
        command.overrides = routingOverride(command.overrides);
        if (
            Object.keys(command.overrides as object).length &&
            !(await confirm(
                "本次执行将向以下本机环境路由发送业务请求及该身份的凭证，并标记为非原始环境。 / Authorize this run's business routing and credentials?\n" +
                    JSON.stringify(command.overrides, null, 2),
            ))
        )
            throw new Error("USER_CANCELLED");
    }
    await ensureAgent();
    return client.call(command);
}

/** 原始证据操作统一先取得当前用户的原生确认，再分别走本机已拥有报告或云端当前权限的读取路径；renderer 只能提交有限标识与动作，不能提交下载 URL、目标文件路径或可执行命令。
 * local 标志必须是真布尔值，不能用字符串真值选择授权路径。
 * action 只允许保存、Trace 查看和截图预览。
 * Run、Attempt 和制品标识先检查 UUID 形态，再交给实际存储做归属核验。
 * 确认框说明原始证据可能包含业务凭证，用户可以在读取前取消。
 * 取消确认不生成临时导出文件，也不打开外部应用。
 * 本机读取由 Agent 根据选定 Workspace 和 Run、Attempt、artifact 关系核验。
 * 主进程传给 Agent 的 authorized 只来自这里完成的确认，renderer 无该内部命令。
 * 本机 Trace 请求返回的是私有查看器能力，不把 Trace 字节交给业务 renderer。
 * 普通本机导出返回的路径必须直接属于当前档案的 exports 目录。
 * 主进程拒绝后台返回的其它目录，即使路径看起来是有效文件。
 * 云端读取要求当前 HostSession 已选择经过成员校验的 Workspace。
 * 云端描述与字节均由当前员工权限读取，设备下载令牌不能替代它。
 * HostSession 会校验制品大小与摘要，避免描述和下载内容不一致。
 * 每次云端导出使用随机 UUID 文件名，避免覆盖已有用户文件。
 * wx 创建标志拒绝同名已有文件，新文件权限限制为当前用户。
 * 扩展名由服务端制品种类选择，不能由 renderer 自行指定可执行后缀。
 * Trace 动作只接受 TRACE 制品，不把其它内容交给官方查看器。
 * 云端 Trace 只通过固定 exports UUID 交给后台，后台不接受任意源路径。
 * ready 回调之前官方查看器已经复制到自己的私有目录，本次 exports 源副本随后即可回收。
 * 窗口启动失败和错误制品类型同样进入清理，查看器自身仍由既定关闭流程停止。
 * 查看器结束后由对应后台任务回收其独立副本，原始云端证据不被删除。
 * 截图动作只接受 SCREENSHOT 制品，解码还由 nativeImage 独立验证。
 * 截图窗口使用已解码 PNG 数据，因此显示完成不再依赖临时文件继续存在。
 * 保存动作由原生文件选择器决定用户目标目录，页面不能指定覆盖目的地。
 * 取消保存对话框不会复制文件，但仍清理本次临时副本。
 * 保存失败同样进入 finally，不能把凭证明文导出永久遗留在缓存目录。
 * 临时清理只删除此操作生成的 source，不删除报告库中的原始证据。
 * 文件复制不把证据加入应用静态发布目录，也不改变证据访问权限。
 * 截图预览不再调用系统默认浏览器，避免不可观察的外部查看进程与副本寿命。
 * 当前原始证据大小上限由 Runtime 和 HostSession 保持，窗口不提供无界文件浏览。
 */
async function artifact(input: unknown) {
    const value = object(input, ["local", "runId", "attemptId", "artifactId", "action"]);
    if (
        typeof value.local !== "boolean" ||
        !["save", "trace", "preview"].includes(String(value.action)) ||
        ![value.runId, value.attemptId, value.artifactId].every(
            (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
        )
    )
        throw new Error("IPC_PAYLOAD_INVALID");
    if (
        !(await confirm(
            "原始证据可能包含业务凭证。仅在你有权限时保存或查看。 / Raw evidence may contain credentials. Continue?",
        ))
    )
        return;
    let source: string;
    let kind = "";
    let trace: (() => Promise<void>) | undefined;
    if (value.local) {
        const result = object(
            await client.call({
                operation: "nativeArtifact",
                runId: value.runId,
                attemptId: value.attemptId,
                artifactId: value.artifactId,
                action: value.action,
                authorized: true,
            }),
        );
        if (value.action === "trace") {
            await openNativeTrace(client, result);
            return;
        }
        if (typeof result.path !== "string" || dirname(result.path) !== join(profile, "exports"))
            throw new Error("ARTIFACT_PATH_INVALID");
        source = result.path;
        kind = String(result.kind);
    } else {
        if (!host.workspace) throw new Error("WORKSPACE_SCOPE_MISMATCH");
        const result = await host.artifact(
            host.workspace.id,
            String(value.attemptId),
            String(value.artifactId),
        );
        kind = result.artifact.kind;
        const exportId = crypto.randomUUID();
        await privateDirectory(join(profile, "exports"));
        source = join(
            profile,
            "exports",
            `${exportId}.${kind === "TRACE" ? "zip" : kind === "SCREENSHOT" ? "png" : "bin"}`,
        );
        await writeFile(source, result.bytes, { mode: 0o600, flag: "wx" });
        if (value.action === "trace")
            trace = async () => {
                if (kind !== "TRACE") throw new Error("TRACE_REQUIRED");
                await openNativeTrace(
                    client,
                    await client.call({ operation: "nativeTraceExport", exportId }),
                );
            };
    }
    return withArtifactExport(source, async () => {
        if (trace) {
            await trace();
            return;
        }
        if (value.action === "preview") {
            if (kind !== "SCREENSHOT") throw new Error("SCREENSHOT_REQUIRED");
            await openNativeImage(await readFile(source));
            return;
        }
        const destination = await dialog.showSaveDialog(window!, {
            defaultPath: `veriq-evidence-${value.artifactId}${extname(source)}`,
        });
        if (!destination.canceled && destination.filePath)
            await copyFile(source, destination.filePath);
    });
}

/** 统一 IPC 处理器先验证发送窗口、主 frame 和随包入口，再进入逐操作处理分支；同源 URL 或知道通道名称都不足以取得能力，所有网络和本机路径参数仍由所属分支独立验证。
 * 没有当前窗口时拒绝，避免启动和退出期间出现悬空授权对象。
 * 缺少真实 senderFrame 时不能用 URL 字符串补造一个主 frame。
 * 授权上下文使用当前 window.webContents，而非消息中的任意字段。
 * 操作名为 unknown，switch 之外的值统一拒绝。
 * 状态、登录、云端业务、本机业务和原生生命周期是不同分支。
 * 普通云端操作先经过固定 OpenAPI 白名单解析，再由 HostSession 再次执行校验。
 * 没有提供 fetch、request、readFile 或 spawn 这样的通用底层方法。
 * 会话对象和 CSRF 不作为响应结构返回给 renderer。
 * 流能力使用随机句柄逐块读取，不把 Electron Response 或 Session 对象跨边界传递。
 * 查看原始证据只走宿主 artifact 分支，而不是把下载 bytes 直接送到 React。
 * 生命周期分支只能影响本应用拥有的窗口和 Agent。
 * 未知动作即使带有合法业务参数，也不会回退到某个默认处理器。
 */
function installBridge() {
    ipcMain.handle("veriq:desktop", async (event, operation: unknown, input: unknown) => {
        if (!window || !event.senderFrame) throw new Error("IPC_SENDER_DENIED");
        authorizeSender(
            { id: event.sender.id, frame: event.senderFrame, url: event.senderFrame.url },
            { id: window.webContents.id, frame: window.webContents.mainFrame },
        );
        switch (operation) {
            case "state":
                return state();
            case "configure": {
                const value = object(input, ["origin", "proxy"]);
                if (typeof value.origin !== "string" || typeof value.proxy !== "string")
                    throw new Error("IPC_PAYLOAD_INVALID");
                const next = controlOrigin(value.origin);
                if (value.proxy && !/^https?:\/\/[a-z0-9.:[\]-]+:\d{1,5}$/i.test(value.proxy))
                    throw new Error("PROXY_INVALID");
                try {
                    const active = object(await client.call({ operation: "status" }));
                    assertAgentReconfigurationAllowed(active);
                } catch (error) {
                    if (
                        !(error instanceof Error) ||
                        (error.message !== "AGENT_UNAVAILABLE" &&
                            (error as NodeJS.ErrnoException).code !== "ENOENT")
                    )
                        throw error;
                }
                host.invalidate();
                origin = next;
                proxy = value.proxy;
                await session
                    .fromPartition("persist:veriq-host")
                    .clearStorageData({ storages: ["cookies"] });
                await session
                    .fromPartition("persist:veriq-host")
                    .setProxy(proxy ? { proxyRules: proxy } : { mode: "system" });
                host = new HostSession(session.fromPartition("persist:veriq-host"), origin);
                await updatePrivate(profile, "desktop-settings.json", () => ({ origin, proxy }));
                try {
                    await client.call({ operation: "stop" });
                } catch {}
                return;
            }
            case "login":
                return host.login(parseSchema("LoginRequest", input));
            case "logout":
                return host.logout();
            case "workspaces":
                return host.cloud({ operation: "listWorkspaces" });
            case "select": {
                const value = object(input, ["workspaceId"]);
                if (typeof value.workspaceId !== "string") throw new Error("IPC_PAYLOAD_INVALID");
                const selected = await host.select(value.workspaceId);
                await updatePrivate(
                    profile,
                    "desktop-workspaces.json",
                    (old: Record<string, unknown> | undefined) => ({
                        ...old,
                        [selected.id]: selected,
                    }),
                );
                try {
                    await client.call({ operation: "select", workspaceId: selected.id });
                } catch {}
                return selected;
            }
            case "cloud":
                resolveOperation(input, host.workspace?.id);
                return host.cloud(input as CloudOperation);
            case "local":
                return local(input);
            case "streamOpen":
                resolveOperation(input, host.workspace?.id);
                return host.openStream(input as CloudOperation);
            case "streamPull":
            case "streamClose": {
                const value = object(input, ["id"]);
                if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id))
                    throw new Error("IPC_PAYLOAD_INVALID");
                return operation === "streamPull"
                    ? host.pullStream(value.id)
                    : host.closeStream(value.id);
            }
            case "artifact":
                return artifact(input);
            case "directory":
                await shell.openPath(profile);
                return;
            case "lifecycle": {
                const value = object(input, ["action"]);
                if (value.action === "hide") {
                    tray ? window.hide() : window.minimize();
                    return;
                }
                if (value.action === "quit") {
                    if (
                        await confirm("退出界面后后台执行继续。 / Quit UI while Agent continues?")
                    ) {
                        quitting = true;
                        app.quit();
                    }
                    return;
                }
                if (value.action === "stop") {
                    if (
                        await confirm(
                            "停止后台会取消正在执行的测试。 / Stop Agent and cancel active work?",
                        )
                    )
                        await client.call({ operation: "stop" });
                    return;
                }
                throw new Error("IPC_OPERATION_DENIED");
            }
            default:
                throw new Error("IPC_OPERATION_DENIED");
        }
    });
}

/** 应用准备完成后按私有配置、独立 Session、本地协议和主窗口的顺序建立桌面环境，首窗加载与控制平台恢复相互独立；离线或后台不可用不应让随包工作台消失，也不能因此放宽网络和沙箱设置。
 * 先等待 Electron ready，避免在平台尚未初始化时创建 Session 或窗口。
 * 档案目录由 Runtime 私有目录工具检查，不能默许链接或宽权限状态。
 * 读取本机设置时再次校验控制 Origin，不信任曾经写入的 JSON 一定合法。
 * 只允许首次缺少设置文件的情况使用默认值。
 * 普通登录使用 persist:veriq-host 分区，Cookie 可以跨 UI 重开恢复。
 * 主业务 renderer 使用独立非持久分区，不能读取普通登录 Cookie。
 * 请求权限和同步权限检查都拒绝，覆盖两种 Electron 权限调用方式。
 * 应用页面只允许自己的 veriq 资源和同来源 blob，不能直接联系控制平台。
 * 控制平台请求统一留在主进程 HostSession 内执行。
 * 静态资源目录从随包模块位置计算，不从请求或 renderer 指定。
 * 协议处理只接受 app 主机、GET 方法和无查询的静态资源请求。
 * 路径解码后再 resolve，随后检查结果仍在静态资源根内。
 * 文件必须存在、为普通文件且不是符号链接。
 * 缺少静态文件返回真实404，不把任意路径回退成 index.html。
 * 本地 net.fetch 仅读取已确定路径的 file URL，不开放给页面传入。
 * 响应头增加严格 script-src self，renderer 不允许动态编译代码。
 * 样式允许现有组件库所需内联样式，脚本没有 unsafe-inline 或 unsafe-eval。
 * 图片和字体只接受本地或明确数据形式，不为 UI 引入远程 CDN。
 * worker 来源保留 self 和 blob，以运行随包 Monaco worker。
 * frame-src none 阻止业务 UI 任意嵌入网页；Trace 使用另一隔离 Session。
 * BrowserWindow 显式开启 sandbox 和 contextIsolation，关闭 Node 集成与 webview。
 * 预加载文件固定为构建产生的单个 CommonJS 文件。
 * 弹窗请求统一拒绝，导航也由主进程阻止。
 * renderer 崩溃会撤销普通会话内的请求和流，再加载固定本地入口。
 * 崩溃恢复不调用 Agent stop，所以独立执行的生命周期保持不变。
 * 普通 close 事件被拦截为隐藏或最小化，只有 quitting 才放行真正关闭。
 * 托盘只在明确支持的平台环境启用；没有托盘时保持可恢复的窗口回退。
 * 托盘 Quit 仍经过相同原生确认，不能绕过界面退出影响说明。
 * 先加载本地窗口，再尝试恢复平台会话，断网不阻挡静态工作台挂载。
 * 后台启动失败只记录稳定英文诊断，工作台仍能显示不可用状态。
 * 程序单实例锁决定是否进入 main，第二实例只请求恢复已存在窗口。
 * 最后的 before-quit 撤销 UI 所属云端请求，不顺带取消后台测试。
 */
async function main() {
    await app.whenReady();
    /** 正式 Electron 入口从自身资源布局核验独立 Runtime 并绑定原生能力，再读取任何私有档案；配置无法指定 addon 路径，库存失败也不能因为已有后台可连接而跳过本次宿主的启动授权。 */
    installed = app.isPackaged
        ? await loadRuntimeDistribution(join(process.resourcesPath, "runtime"))
        : undefined;
    if (installed && process.platform === "win32") {
        const { bindWindowsDistribution } = await import("../../../runtime/src/native/windows.ts");
        bindWindowsDistribution(installed);
    }
    await privateDirectory(profile);
    try {
        const config = await readPrivate<{ origin: string; proxy: string }>(
            profile,
            "desktop-settings.json",
        );
        origin = controlOrigin(config.origin);
        proxy = config.proxy;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const cookieProtection = await requireCookieProtection(safeStorage);
    console.log("VeriQ Cookie protection verified:", JSON.stringify(cookieProtection));
    await prepareCookieStorage(profile, app.getPath("sessionData"), async () => {
        const result = await dialog.showMessageBox({
            type: "warning",
            title: "VeriQ",
            message:
                "删除旧登录 Cookie 并重新登录？ / Remove legacy login cookies and sign in again?",
            detail: "旧 Cookie 数据库及其日志可能以明文保存。仅删除 VeriQ 的这些文件；不会删除设备身份或业务凭据，也不保证介质擦除。 / Only VeriQ login cookie files are removed; device and business credentials remain. This does not guarantee physical erasure.",
            buttons: ["取消 / Cancel", "删除并重新登录 / Remove and sign in again"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
        });
        return result.response === 1;
    });
    const auth = session.fromPartition("persist:veriq-host");
    await auth.setProxy(proxy ? { proxyRules: proxy } : { mode: "system" });
    host = new HostSession(auth, origin);
    const renderer = session.fromPartition("veriq-renderer");
    renderer.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    renderer.setPermissionCheckHandler(() => false);
    renderer.webRequest.onBeforeRequest((details, callback) =>
        callback({
            cancel:
                !details.url.startsWith("veriq://app/") &&
                !details.url.startsWith("blob:veriq://app/"),
        }),
    );
    const assets = resolve(directory, "../renderer");
    await renderer.protocol.handle("veriq", async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "app" || url.search || request.method !== "GET")
            return new Response("Not found", { status: 404 });
        const pathname = decodeURIComponent(url.pathname);
        const target = bundledAssetPath(assets, pathname);
        if (!target) return new Response("Not found", { status: 404 });
        const info = await lstat(target).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink())
            return new Response("Not found", { status: 404 });
        const response = await net.fetch(pathToFileURL(target).href);
        const headers = new Headers(response.headers);
        headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
        );
        return new Response(response.body, { headers, status: response.status });
    });
    window = new BrowserWindow({
        title: "VeriQ",
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 650,
        webPreferences: {
            preload: join(directory, "../preload/index.cjs"),
            session: renderer,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
        },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () => {
        host.invalidate();
        void window?.loadURL("veriq://app/index.html");
    });
    window.on("close", (event) => {
        if (!quitting) {
            event.preventDefault();
            tray ? window?.hide() : window?.minimize();
        }
    });
    installBridge();
    const supportsTray =
        process.platform === "win32" ||
        process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes("kde");
    if (supportsTray) {
        const icon = nativeImage.createFromDataURL(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        );
        tray = new Tray(icon);
        tray.setToolTip("VeriQ");
        tray.on("click", show);
        tray.setContextMenu(
            Menu.buildFromTemplate([
                { label: "打开 VeriQ / Open", click: show },
                {
                    label: "退出界面 / Quit UI",
                    click: () => {
                        void confirm(
                            "退出界面后后台执行继续。 / Quit UI while Agent continues?",
                        ).then((accepted) => {
                            if (accepted) {
                                quitting = true;
                                app.quit();
                            }
                        });
                    },
                },
            ]),
        );
    }
    await window.loadURL("veriq://app/index.html");
    try {
        await host.restore();
    } catch {}
    try {
        await ensureAgent();
    } catch (error) {
        console.error(
            "VeriQ Agent startup unavailable:",
            error instanceof Error ? error.message : "UNKNOWN_ERROR",
        );
    }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on("second-instance", show);
    app.on("activate", show);
    void main().catch((error) => {
        console.error("VeriQ desktop failed:", error);
        app.exit(1);
    });
}
app.on("before-quit", () => {
    quitting = true;
    host?.invalidate();
});
