import { join } from "node:path";
import { rm, writeFile, lstat, readdir, chmod } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import type {
    PlatformComponents,
    JsonValue,
    CompiledAssetBundle,
    EnvironmentV1,
} from "@veriq/contracts";
import { validateSchema } from "@veriq/contracts";
import { DeviceStore, RuntimeClient, controlOrigin } from "../../../runtime/src/enrollment.ts";
import { SecretStore, type SecretReference } from "../../../runtime/src/credentials/store.ts";
import type { CredentialOptions } from "../../../runtime/src/credentials/profile.ts";
import { TrustStore, type IssuerTrust } from "../../../runtime/src/offline/trust.ts";
import { downloadBundle } from "../../../runtime/src/offline/download.ts";
import { verifyBundle, reverifyInstalled } from "../../../runtime/src/offline/verify.ts";
import { runOffline, recoverOffline } from "../../../runtime/src/offline/run.ts";
import { LocalStore } from "../../../runtime/src/offline/store.ts";
import { LocalReports } from "../../../runtime/src/offline/reports.ts";
import { uploadOffline } from "../../../runtime/src/offline/upload.ts";
import {
    readPrivate,
    updatePrivate,
    privateDirectory,
} from "../../../runtime/src/offline/config.ts";
import { diagnoseRelease, loadRuntimeDistribution } from "../../../runtime/src/distribution.ts";
import { openTrace } from "../../../runtime/src/trace.ts";
import { DeviceSession } from "../../../runtime/src/agent/credentials.ts";
import { AgentClient } from "../../../runtime/src/agent/transport.ts";
import { claimLoop } from "../../../runtime/src/agent/claim-loop.ts";
import { ExecutionSupervisor } from "../../../runtime/src/execution/supervisor.ts";
import { object } from "../main/policy";
import { probeBrowser } from "./browser-capability";
import { routingOverride } from "../shared/routing";
import { credentialIssue, type CredentialIssue } from "../shared/credential-status";

type S = PlatformComponents["schemas"];
type CachedBundle = {
    id: string;
    workspaceId: string;
    engineVersion: string;
    createdAt: string;
    debug: boolean;
};
/** 后台启动配置由可信桌面入口或安装包提供，包含固定引擎与浏览器路径而不接受渲染端文件参数；控制 Origin 必须与现有设备登记匹配，防止切换平台时误送设备凭证。 */
export interface AgentConfiguration {
    origin: string;
    engineDirectory: string;
    engineVersion?: string;
    browserExecutable: string;
    headedExecutable?: string;
    /** 正式安装由 main 写入唯一 Runtime 资源根，Agent 启动及准备执行时重新验证该目录；renderer 和签名业务包不能传入此字段，开发配置没有该字段时保持已有独立工具路径。 */
    distributionRoot?: string;
}
const id = (value: unknown) => {
    if (
        typeof value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
        throw new Error("IPC_PAYLOAD_INVALID");
    return value;
};
const text = (value: unknown, maximum = 160) => {
    if (typeof value !== "string" || !value.length || value.length > maximum)
        throw new Error("IPC_PAYLOAD_INVALID");
    return value;
};
const failure = (error: unknown) =>
    error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
        ? error.message
        : "LOCAL_OPERATION_FAILED";

/** 桌面后台是已有 Runtime 的本机操作入口，执行、验签、持久化和回传都委托原实现；进程不依赖 Electron 生命周期，状态只返回无密钥摘要与明确的活动占用事实。 */
export class DesktopAgent {
    private readonly device: DeviceStore;
    private readonly credentialProfile: boolean;
    private readonly trust: TrustStore;
    private readonly secrets: SecretStore;
    private readonly executionRoot: string;
    private pendingEnrollment: S["EnrollmentDTO"] | undefined;
    private run: Promise<unknown> | undefined;
    private runController: AbortController | undefined;
    private online: Promise<void> | undefined;
    private onlineController: AbortController | undefined;
    private lastError: string | undefined;
    private headedCapability: ReturnType<typeof probeBrowser>;
    private browserCapability: ReturnType<typeof probeBrowser>;
    private selectedWorkspace: string | undefined;
    private transition:
        | { id: string; operation: string; controller: AbortController; done: Promise<void> }
        | undefined;
    private interruptions = 0;
    private stopped = false;
    private viewers = new Map<
        string,
        { controller: AbortController; done: Promise<void>; expiry: ReturnType<typeof setTimeout> }
    >();

    /** 后台对象把设备登记、签发者信任、本机凭证与离线执行状态分别绑定到同一私有档案，而执行状态使用独立子目录；初始化只建立这些依赖和浏览器探测，不在构造函数中领取远程任务或运行签名包。
     * 控制 Origin 在接触任何持久设备资料前经过 Runtime 的既有地址校验。
     * 浏览器探测 Promise 在实例创建时启动，后续状态请求复用同一安装能力事实。
     * 可见与无头探测使用两个明确配置的路径，不把 UI Chromium 当作测试浏览器。
     * 设备存储持有长期设备身份，普通员工 Cookie 从未进入此对象。
     * 信任存储负责签发者公钥及撤销语义，不依赖资源包自报的信任状态。
     * 凭证存储的解析接口只供执行器消费，桌面状态不包含明文值。
     * offline 子目录存放本机 SQLite、拥有者状态、工作目录和执行证据。
     * 在线 Agent 工作目录在需要领取任务时单独创建，避免混淆两种运行归属。
     * 构造成功不代表发行或浏览器已通过自检，启动命令仍需各自验证。
     * 构造函数不发送注册请求，失败重启不能悄悄产生额外设备身份。
     * 选定 Workspace 从经过范围检查的持久选择或设备登记恢复。
     * 执行与在线领取的 Promise 是进程内所有权，不从 renderer 提交的状态重建。
     * 启动门闩覆盖异步准备窗口，运行 Promise 则覆盖已经交给 Runtime 的任务。
     * 两者分开使取消启动不需要伪造一个尚未存在的 Run 标识。
     * 查看器集合只管理独立证据服务，不计入业务执行器的 Run 槽位。
     */
    constructor(
        readonly root: string,
        readonly config: AgentConfiguration,
        credentials?: CredentialOptions,
    ) {
        controlOrigin(config.origin);
        this.headedCapability = probeBrowser(config.headedExecutable, true);
        this.browserCapability = probeBrowser(config.browserExecutable, false);
        this.device = new DeviceStore(root, credentials);
        this.credentialProfile = credentials !== undefined;
        this.trust = new TrustStore(root);
        this.secrets = new SecretStore(root, credentials);
        this.executionRoot = join(root, "offline");
    }

    /** 资源包目录索引只是界面可列举的缓存元数据，不是签名或执行授权证明；索引缺失表示空缓存，其它读取错误必须上报，防止损坏的本机状态被静默覆盖成一个看似干净的新档案。
     * 列表持久化只包含标识、Workspace、引擎版本、时间和 DEBUG 标记。
     * 不保存设备令牌、业务凭证或指向任意外部文件的读取能力。
     * 真正选包时会再次核验安装目录内容，不能仅凭此列表启动执行。
     * ENOENT 是首次使用的正常情况，权限和解析错误不是。
     * 返回的数组不被调用方原地修改，更新通过私有配置原子写入完成。
     * 目录列表允许不同 Workspace 的本机缓存并存，但读取内容必须先选定对应空间。
     */
    private async catalog(): Promise<CachedBundle[]> {
        try {
            return await readPrivate<CachedBundle[]>(this.root, "desktop-bundles.json");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }

    /** 读取缓存内容必须同时匹配调用者提供的合法包标识与后台当前选定 Workspace，随后重新核验安装内容；从列表里找到一个条目只建立候选关系，不能绕过签名、撤销或 DEBUG 策略。
     * 调用者先用 id 校验器规范检查包 UUID，不能把路径字符串送入此处。
     * 匹配失败统一返回 BUNDLE_WORKSPACE_MISMATCH，避免提供跨空间内容。
     * 目录由私有 root、固定 bundles 段和已校验 UUID 组成。
     * 签发者信任来自本机 TrustStore，而不是条目的显示字段。
     * 条目的 debug 决定是否接受明确标记的调试包，不把调试包当正式批准包。
     * reverifyInstalled 复用 Runtime 的库存、路径、哈希和签名检查。
     * 返回的 checked 是实际已核验内容，后续投影从它构造。
     * 目录路径只在 Node 内流转，renderer 得到的是受限资源标识与文本。
     * 离线签名有效不表示知道实时撤销状态，报告仍保留原有未知撤销语义。
     */
    private async selected(bundleId: string) {
        const item = (await this.catalog()).find(
            (bundle) => bundle.id === bundleId && bundle.workspaceId === this.selectedWorkspace,
        );
        if (!item) throw new Error("BUNDLE_WORKSPACE_MISMATCH");
        const directory = join(this.root, "bundles", item.id);
        const checked = await reverifyInstalled(directory, {
            trust: this.trust,
            workspaceId: item.workspaceId,
            debug: item.debug,
        });
        return { item, directory, checked };
    }

    /** 设备登记中的控制 Origin 与 Workspace 是下载和回传的认证目的地，必须与后台启动配置和当前本机选择同时一致；签名资源中的业务 URL 或员工刚登录的平台会话不能改变设备令牌的发送范围。
     * 每次调用重新读取 DeviceStore，解绑后不能继续使用先前缓存的令牌。
     * 配置 Origin 比较避免更换控制平台后误用旧设备身份。
     * Workspace 比较避免拿一个空间的设备访问另一个空间的包或导入。
     * 失败发生在构造带认证的网络请求之前。
     * 该结果只供后台内部调用，不作为公开 status 的返回对象。
     * 状态页需要的设备 id 和 Workspace 会另外显式投影。
     * 离线执行也使用登记的设备 id 标记来源，但不将设备 token 写入测试子进程。
     */
    private async deviceConfig() {
        const config = await this.device.load();
        if (config.server !== this.config.origin || config.workspaceId !== this.selectedWorkspace)
            throw new Error("DEVICE_SCOPE_MISMATCH");
        return config;
    }

    /** 设备缺席只接受当前存储路径的明确事实，保险库事务已有专用缺登记标识而后端系统错误不具备此含义；源码文件模式保留精确 device.json 的缺文件以及 Windows 既有有限原生缺路径合同，避免未知 ENOENT 放开绑定与控制源保护。 */
    private deviceNotEnrolled(error: unknown): boolean {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        if (this.credentialProfile) return error.message === "DEVICE_NOT_ENROLLED";
        return (
            ("path" in error && error.path === join(this.root, "device.json")) ||
            (process.platform === "win32" &&
                error.message === "NATIVE_PATH_UNAVAILABLE" &&
                "win32" in error &&
                (error.win32 === 2 || error.win32 === 3))
        );
    }

    /** 状态接口读取真实持久拥有者、历史和当前进程句柄，而不以界面忙碌状态推测执行是否结束；即使另一个请求停在签名包准备阶段，本方法也应独立返回可观察的准备标识和取消状态。
     * 每次状态读取独立打开 LocalStore，并在 finally 中关闭 SQLite 句柄。
     * 活动拥有者来自数据库，UI 崩溃后仍可恢复同一个 Run 和 Attempt。
     * 缺少活动拥有者时返回 null，不构造占位 Run 或声称已经停止。
     * 在线标志来自当前领取循环 Promise，不能由 renderer 写入。
     * 准备状态的 id 是控制操作标识，类型上与 Run 字段分开。
     * 准备状态只公开 run 和 onlineStart，普通目录读写不冒充任务。
     * cancelling 来自该预留控制器的真实 AbortSignal。
     * 它表示取消已经请求，不能替代 Runtime 的 processStopped 回执。
     * 设备存储不存在时允许未绑定状态，其它读取失败不会被伪装成未绑定。
     * 恢复的 Workspace 必须仍属于设备或实际缓存列表。
     * 无法恢复旧选择时优先使用当前设备登记的 Workspace。
     * 历史查询限制为最近一百条，防止状态轮询返回无界数据。
     * 历史只查询当前选定 Workspace，不混合其它空间的 Run。
     * 上传错误保留稳定代码，使 UI 能显示待回传并提供显式重试。
     * 浏览器版本来源是实际安装探测，源码版本或窗口 User-Agent 都不能替代它。
     * Node 版本与 pid 来自本进程，用于证明执行后台独立于 Electron。
     * 错误摘要只保留白名单形式的稳定代码，不向页面泄露路径或凭证。
     * 状态不会自动拉起新的 Agent，也不会因读取历史而启动在线领取。
     * 普通员工登出不改变设备字段，本地执行与普通 Cookie 生命周期相互独立。
     */
    private async state() {
        const store = await LocalStore.open(this.executionRoot);
        try {
            let device: { id: string; workspaceId: string } | undefined;
            let credentialError: CredentialIssue | undefined;
            try {
                const config = await this.device.load();
                device = { id: config.runnerId, workspaceId: config.workspaceId };
            } catch (error) {
                /** 后台已能响应 IPC 并不代表凭据可用，锁定、旧格式与损坏只投影为有限失败状态；这里只处理设备读取，SQLite、历史和缓存错误继续抛出，显式凭据操作仍由原 Runtime 约束执行。 */
                if (!this.deviceNotEnrolled(error)) credentialError = credentialIssue(error);
            }
            if (!this.selectedWorkspace) {
                try {
                    const remembered = await readPrivate<{ workspaceId: string }>(
                        this.root,
                        "desktop-selection.json",
                    );
                    if (
                        remembered.workspaceId === device?.workspaceId ||
                        (await this.catalog()).some(
                            (bundle) => bundle.workspaceId === remembered.workspaceId,
                        )
                    )
                        this.selectedWorkspace = remembered.workspaceId;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
                this.selectedWorkspace ??= device?.workspaceId;
            }
            return {
                node: process.versions.node,
                pid: process.pid,
                active: store.active() ?? null,
                online: !!this.online,
                ...(this.transition && ["run", "onlineStart"].includes(this.transition.operation)
                    ? {
                          preparing: {
                              id: this.transition.id,
                              operation: this.transition.operation,
                              cancelling: this.transition.controller.signal.aborted,
                          },
                      }
                    : {}),
                device,
                ...(credentialError ? { credentialError } : {}),
                bundles: await this.catalog(),
                error: this.lastError,
                workspaceId: this.selectedWorkspace,
                headedAvailable: (await this.headedCapability).available,
                browser: await this.browserCapability,
                history: this.selectedWorkspace ? store.history(this.selectedWorkspace, 100) : [],
            };
        } finally {
            store.close();
        }
    }

    /** 每个本机命令先拒绝未知字段并验证作用域，路径始终由配置根和已登记 UUID 构造；renderer 即使绕过静态类型，也不能调用任意进程、文件或替换控制服务器。 */
    async dispatch(input: unknown): Promise<unknown> {
        const message = object(input);
        const operation = text(message.operation);
        const permitted: Record<string, readonly string[]> = {
            status: [],
            select: ["workspaceId"],
            doctor: [],
            enroll: ["name"],
            pollEnrollment: [],
            device: [],
            unbind: [],
            trust: ["issuer", "fingerprint"],
            download: ["bundleId", "debug"],
            snapshot: ["bundleId"],
            source: ["bundleId", "versionId", "file"],
            credentials: ["bundleId"],
            setCredential: ["bundleId", "reference", "value"],
            removeCredential: ["bundleId", "reference"],
            run: ["bundleId", "headed", "retry", "overrides"],
            cancel: ["runId", "startupId"],
            report: ["runId"],
            upload: ["runId"],
            nativeArtifact: ["runId", "attemptId", "artifactId", "action", "authorized"],
            nativeTraceExport: ["exportId"],
            viewerKeepAlive: ["viewerId"],
            viewerClose: ["viewerId"],
            onlineStart: [],
            onlineStop: [],
            clearBundle: ["bundleId"],
            stop: [],
            recover: [],
            migrateCredentials: [],
            recoverCredentialInitialization: [],
        };
        if (!Object.hasOwn(permitted, operation)) throw new Error("AGENT_OPERATION_DENIED");
        object(message, ["operation", ...permitted[operation]!]);
        if (operation === "stop" || operation === "cancel" || operation === "onlineStop")
            return this.interrupt(operation, message);
        if (this.stopped && operation !== "status") throw new Error("AGENT_STOPPED");
        const guarded = [
            "run",
            "onlineStart",
            "select",
            "enroll",
            "pollEnrollment",
            "unbind",
            "trust",
            "setCredential",
            "removeCredential",
            "clearBundle",
            "recover",
            "migrateCredentials",
            "recoverCredentialInitialization",
        ];
        if (!guarded.includes(operation)) return this.execute(operation, message);
        if (this.transition || this.interruptions || this.run || this.online)
            throw new Error("AGENT_BUSY");
        let finish!: () => void;
        const reservation = {
            id: randomUUID(),
            operation,
            controller: new AbortController(),
            done: new Promise<void>((resolve) => {
                finish = resolve;
            }),
        };
        this.transition = reservation;
        try {
            return await this.execute(operation, message, reservation.controller);
        } catch (error) {
            if (reservation.controller.signal.aborted) throw new Error("AGENT_START_CANCELLED");
            throw error;
        } finally {
            if (this.transition === reservation) this.transition = undefined;
            finish();
        }
    }

    /** 已经通过操作白名单的请求在这里进入具体 Runtime 适配分支，启动控制器只属于该次已预留操作；每个分支仍验证自己的字段、当前空间与资源归属，不能把统一派发校验当作业务授权已完成。
     * 私有目录创建发生在门闩预留之后，文件系统等待不会给第二个启动留下空闲窗口。
     * 开始处理前检查取消信号，已经取消的排队准备不继续做业务工作。
     * 只读请求可以没有 startup 控制器，并与执行准备并发。
     * 受保护的变更在 dispatch 中同步预留，execute 不建立第二条无界等待队列。
     * 所有异常回到同一个调用方，Node broker 再将不稳定异常转换成稳定错误码。
     * 本方法不接受任意命令名、HTTP 路径或进程参数。
     * 下载与回传委托成熟 Runtime 接口，不能通过本地适配绕过发行或设备检查。
     * 状态切换的副作用按各分支完成，不把 socket 回执丢失当作操作回滚。
     */
    private async execute(
        operation: string,
        message: Record<string, unknown>,
        startup?: AbortController,
    ): Promise<unknown> {
        await privateDirectory(this.root);
        startup?.signal.throwIfAborted();
        if (operation === "status") return this.state();
        if (operation === "recoverCredentialInitialization") {
            await this.device.recoverCredentialInitialization();
            return { recovered: true, credentialMode: "os-vault" };
        }
        if (operation === "migrateCredentials") {
            await this.device.migrateCredentials();
            return { migrated: true, credentialMode: "os-vault" };
        }
        if (operation === "select") {
            const workspace = id(message.workspaceId);
            const cached = (await this.catalog()).some(
                (bundle) => bundle.workspaceId === workspace,
            );
            let bound = false;
            try {
                bound = (await this.device.load()).workspaceId === workspace;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (!cached && !bound) throw new Error("LOCAL_WORKSPACE_UNAVAILABLE");
            this.selectedWorkspace = workspace;
            await updatePrivate(this.root, "desktop-selection.json", () => ({
                workspaceId: workspace,
            }));
            return this.state();
        }
        if (operation === "doctor") return this.diagnose(true);
        if (operation === "enroll") {
            /** 新登记必须先确认当前档案确实没有设备，锁定、旧格式或缺密钥都不能取得远端新审批码；即使 renderer 绕过禁用按钮也保持相同拒绝，最终写入仍由 Runtime 的只创建事务防止并发覆盖。 */
            let enrolled = false;
            try {
                await this.device.load();
                enrolled = true;
            } catch (error) {
                if (!this.deviceNotEnrolled(error)) throw new Error(credentialIssue(error));
            }
            if (enrolled) throw new Error("ALREADY_ENROLLED");
            const result = await this.diagnose(false);
            if (!result.ok || !result.capabilities) throw new Error("RUNTIME_DOCTOR_FAILED");
            this.pendingEnrollment = await new RuntimeClient(this.config.origin).begin(
                text(message.name),
                result.capabilities,
            );
            const { deviceCode: _privateCode, ...visible } = this.pendingEnrollment;
            return visible;
        }
        if (operation === "pollEnrollment") {
            if (!this.pendingEnrollment) throw new Error("ENROLLMENT_NOT_STARTED");
            const credentials = await new RuntimeClient(this.config.origin).poll(
                this.pendingEnrollment.deviceCode,
            );
            await this.device.save({ ...credentials, server: this.config.origin });
            this.pendingEnrollment = undefined;
            this.selectedWorkspace = credentials.workspaceId;
            if (this.config.origin.startsWith("https:"))
                await this.trust.refresh(await this.device.load());
            return this.state();
        }
        if (operation === "device") {
            const config = await this.deviceConfig();
            return new RuntimeClient(config.server).inspectDevice(config.deviceToken);
        }
        if (operation === "unbind") {
            if (this.run || this.online) throw new Error("AGENT_BUSY");
            const config = await this.deviceConfig();
            await new RuntimeClient(config.server).logout(config.deviceToken);
            await this.device.remove();
            return this.state();
        }
        if (operation === "trust") {
            if (validateSchema("IssuerTrustV1", message.issuer).length)
                throw new Error("INVALID_ISSUER");
            await this.trust.bind(
                message.issuer as IssuerTrust,
                this.config.origin,
                text(message.fingerprint, 64),
            );
            return { trusted: true };
        }
        if (operation === "download") {
            const config = await this.deviceConfig(),
                bundleId = id(message.bundleId);
            if (typeof message.debug !== "boolean") throw new Error("IPC_PAYLOAD_INVALID");
            if ((await this.catalog()).some((bundle) => bundle.id === bundleId))
                return this.selected(bundleId).then(() => this.state());
            const archive = join(this.root, `download-${randomUUID()}.zip`);
            try {
                await downloadBundle(config, bundleId, archive);
                const verified = await verifyBundle(archive, {
                    trust: this.trust,
                    destination: join(this.root, "bundles", bundleId),
                    workspaceId: config.workspaceId,
                    debug: message.debug,
                });
                const item: CachedBundle = {
                    id: bundleId,
                    workspaceId: verified.manifest.workspaceId,
                    engineVersion: verified.manifest.engineVersion,
                    createdAt: verified.manifest.createdAt,
                    debug: verified.debug,
                };
                await updatePrivate<CachedBundle[]>(this.root, "desktop-bundles.json", (old) => [
                    ...(old ?? []),
                    item,
                ]);
                return this.state();
            } finally {
                await rm(archive, { force: true });
            }
        }
        if (
            operation === "snapshot" ||
            operation === "source" ||
            operation === "credentials" ||
            operation.endsWith("Credential")
        ) {
            const { checked } = await this.selected(id(message.bundleId));
            const selection = JSON.parse(checked.contents.get("selection.json")!.toString()) as {
                environmentVersionId: string;
            };
            const environmentValue = checked.snapshot.assets.find(
                (asset) => asset.versionId === selection.environmentVersionId,
            )?.document;
            if (validateSchema("EnvironmentV1", environmentValue).length)
                throw new Error("BUNDLE_ENVIRONMENT_MISSING");
            const environment = environmentValue as unknown as EnvironmentV1;
            const references = [
                ...environment.roles,
                ...(environment.fixtureIdentity ? [environment.fixtureIdentity] : []),
            ].map((role) => ({ secretRef: role.secretRef, versionId: role.secretVersionId }));
            if (operation === "credentials")
                return {
                    issuerId: checked.manifest.issuerId,
                    workspaceId: checked.manifest.workspaceId,
                    references,
                };
            if (operation.endsWith("Credential")) {
                const reference = object(message.reference, [
                    "issuerId",
                    "workspaceId",
                    "secretRef",
                    "versionId",
                ]);
                if (
                    reference.issuerId !== checked.manifest.issuerId ||
                    reference.workspaceId !== checked.manifest.workspaceId ||
                    !references.some(
                        (pin) =>
                            pin.secretRef === reference.secretRef &&
                            pin.versionId === reference.versionId,
                    )
                )
                    throw new Error("CREDENTIAL_SCOPE_MISMATCH");
                const ref: SecretReference = {
                    issuerId: text(reference.issuerId),
                    workspaceId: id(reference.workspaceId),
                    secretRef: text(reference.secretRef),
                    versionId: id(reference.versionId),
                };
                if (operation === "removeCredential") await this.secrets.remove(ref);
                else {
                    if (validateSchema("JsonValue", message.value).length)
                        throw new Error("INVALID_SECRET_VALUE");
                    await this.secrets.set(ref, message.value as JsonValue);
                }
                return { saved: true };
            }
            const sourceFiles: Record<string, S["CompiledSourceDTO"]> = {};
            for (const version of checked.resources.versions) {
                const bytes = checked.contents.get(`provenance/${version.id}/descriptor.json`);
                if (!bytes) continue;
                const descriptor: CompiledAssetBundle = JSON.parse(bytes.toString());
                sourceFiles[version.id] = {
                    descriptorSha256: createHash("sha256").update(bytes).digest("hex"),
                    files: descriptor.files.filter((file) =>
                        /^(validation\.ts|source\/context\.ts|cases\/[0-9a-f-]{36}\.test\.ts)$/i.test(
                            file.path,
                        ),
                    ),
                };
            }
            if (operation === "source") {
                const versionId = id(message.versionId);
                const file = object(message.file, ["path", "sha256", "sizeBytes"]);
                const member = sourceFiles[versionId]?.files.find(
                    (item) =>
                        item.path === file.path &&
                        item.sha256 === file.sha256 &&
                        item.sizeBytes === file.sizeBytes,
                );
                if (!member) throw new Error("SOURCE_NOT_AVAILABLE");
                return checked.contents
                    .get(`compiled/${versionId}/${member.path}`)!
                    .toString("utf8");
            }
            const drafts: S["DraftDTO"][] = [];
            if (checked.dslOnly) {
                const target = checked.snapshot.validationTarget!;
                const asset = checked.snapshot.assets.find(
                    (asset) => asset.versionId === target.versionId,
                )!;
                const frozen = JSON.parse(
                    checked.contents.get("draft/metadata.json")!.toString(),
                ) as { frozenAt: string };
                drafts.push({
                    resourceId: asset.resourceId,
                    revision: target.revision,
                    content: {
                        kind: asset.kind,
                        document: asset.document,
                    } as S["ResourceDocumentV1"],
                    updatedAt: frozen.frozenAt,
                    documentHash: asset.sha256,
                });
            }
            return {
                workspaceId: checked.manifest.workspaceId,
                ...checked.resources,
                sourceFiles,
                drafts,
            };
        }
        if (operation === "run") {
            if (this.run || this.online) throw new Error("AGENT_BUSY");
            if (typeof message.headed !== "boolean" || typeof message.retry !== "boolean")
                throw new Error("IPC_PAYLOAD_INVALID");
            if (message.headed && !(await this.headedCapability).available)
                throw new Error("HEADED_BROWSER_UNAVAILABLE");
            const { item, directory } = await this.selected(id(message.bundleId)),
                config = await this.deviceConfig();
            const overrides =
                message.overrides === undefined ? {} : routingOverride(message.overrides);
            const choiceId = randomUUID();
            const choice = {
                bundleId: item.id,
                overrides,
                headless: !message.headed,
                retry: message.retry,
                browser: await (message.headed ? this.headedCapability : this.browserCapability),
                startedAt: new Date().toISOString(),
            };
            if (!choice.browser.available) throw new Error("PINNED_BROWSER_UNAVAILABLE");
            await updatePrivate(
                this.root,
                "desktop-execution-modes.json",
                (old: Record<string, unknown> | undefined) => ({ ...old, [choiceId]: choice }),
            );
            startup?.signal.throwIfAborted();
            const installed = this.config.distributionRoot
                ? await loadRuntimeDistribution(this.config.distributionRoot)
                : undefined;
            startup?.signal.throwIfAborted();
            this.runController = startup ?? new AbortController();
            this.lastError = undefined;
            this.run = runOffline(
                { directory },
                {
                    ...(installed ? { execution: installed.execution } : {}),
                    root: this.executionRoot,
                    trust: this.trust,
                    secrets: this.secrets,
                    releaseDirectory: this.config.engineDirectory,
                    browserExecutable: message.headed
                        ? this.config.headedExecutable!
                        : this.config.browserExecutable,
                    deviceId: config.runnerId,
                    debug: item.debug,
                    retry: message.retry,
                    signal: this.runController.signal,
                    headless: !message.headed,
                    overrides,
                    authorizeOverride: (field, value) =>
                        Object.hasOwn(overrides, field) &&
                        overrides[field as keyof typeof overrides] === value,
                },
            )
                .then(async (result) => {
                    await updatePrivate(
                        this.root,
                        "desktop-execution-modes.json",
                        (old: Record<string, unknown> | undefined) => ({
                            ...old,
                            [choiceId]: {
                                ...choice,
                                runId: result.localRunId,
                                finishedAt: result.finishedAt,
                            },
                        }),
                    );
                    return result;
                })
                .catch((error) => {
                    this.lastError = failure(error);
                })
                .finally(() => {
                    this.run = undefined;
                    this.runController = undefined;
                });
            return { started: true };
        }
        if (operation === "report") {
            if (!this.selectedWorkspace) throw new Error("LOCAL_WORKSPACE_UNAVAILABLE");
            return new LocalReports(this.executionRoot, () => false).snapshot(
                this.selectedWorkspace,
                id(message.runId),
            );
        }
        if (operation === "upload")
            return uploadOffline(this.executionRoot, id(message.runId), await this.deviceConfig());
        if (operation === "nativeArtifact") return this.nativeArtifact(message);
        if (operation === "nativeTraceExport") {
            const path = join(this.root, "exports", id(message.exportId) + ".zip");
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024)
                throw new Error("INVALID_TRACE_FILE");
            return this.startViewer(path);
        }
        if (operation === "viewerClose" || operation === "viewerKeepAlive") {
            const viewer = this.viewers.get(id(message.viewerId));
            if (!viewer) return { closed: true };
            clearTimeout(viewer.expiry);
            if (operation === "viewerClose") {
                viewer.controller.abort();
                await viewer.done;
            } else viewer.expiry = setTimeout(() => viewer.controller.abort(), 15000);
            return { closed: operation === "viewerClose" };
        }
        if (operation === "onlineStart") {
            await this.startOnline(startup ?? new AbortController());
            return this.state();
        }
        if (operation === "clearBundle") {
            if (this.run || this.online) throw new Error("AGENT_BUSY");
            const { item, directory } = await this.selected(id(message.bundleId));
            async function writable(path: string): Promise<void> {
                const info = await lstat(path);
                if (!info.isDirectory() || info.isSymbolicLink())
                    throw new Error("UNSAFE_CACHE_DIRECTORY");
                await chmod(path, 0o700);
                for (const entry of await readdir(path, { withFileTypes: true })) {
                    if (entry.isSymbolicLink()) throw new Error("UNSAFE_CACHE_DIRECTORY");
                    if (entry.isDirectory()) await writable(join(path, entry.name));
                }
            }
            await writable(directory);
            await rm(directory, { recursive: true, force: true });
            await updatePrivate<CachedBundle[]>(this.root, "desktop-bundles.json", (old) =>
                (old ?? []).filter((bundle) => bundle.id !== item.id),
            );
            return this.state();
        }
        if (operation === "recover") {
            if (this.run || this.online) throw new Error("AGENT_BUSY");
            return { receipt: (await recoverOffline(this.executionRoot)) ?? null };
        }
        throw new Error("AGENT_OPERATION_DENIED");
    }

    /** 中断路径先占用反向控制门闩，再处理被捕获的那一次启动或执行，防止等待旧启动收敛时新任务抢入并被误取消；停止、取消启动与取消真实 Run 各自保留不同的标识和完成语义。
     * 方法进入时立即捕获 transition，后续不重新选择一个可能已变化的启动对象。
     * stop 在任何 await 之前把实例标成 stopped，新工作从此拒绝。
     * interruptions 计数同时阻止新的状态变更，不影响独立 status 查询。
     * 多个中断请求可以等待同一个已拥有对象，不创建新的执行器。
     * startupId 与 runId 不能同时提交，否则目标语义不明确。
     * 启动取消要求 id 等于当前预留，陈旧 id 不能命中新启动。
     * 只有 run 和 onlineStart 属于可取消启动，不把原子配置写入伪装成 Run。
     * 取消预留先设置 AbortSignal，再等待该预留自己的 done。
     * done 表示准备路径退出，响应只说 requested，不生成停止回执。
     * 真实 Run 取消先捕获当前控制器，再打开 LocalStore 检查拥有者。
     * 数据库中的 runId 与 Workspace 必须同时匹配请求。
     * 过去已经结束的 Run 即使属于同一空间，也不能取消当前执行。
     * 匹配后才设置持久 cancel_requested，崩溃重连仍能看到取消意图。
     * 控制器 abort 作用于之前捕获的实例，不能误指向后来的 Run。
     * SQLite 句柄无论成功还是拒绝都在 finally 中关闭。
     * 停止在线领取只撤销在线启动预留，不取消独立离线执行的准备。
     * 已启动的在线循环需要等其 Promise 结束，关闭设备会话的 finally 才算执行过。
     * 完全停止还撤销所有原生 Trace 查看器的私有服务。
     * 查看器关闭与测试停止各等待自己的完成 Promise，互不冒充停止事实。
     * 最后返回 stopped 之前，当前 Run、在线循环和查看器都已收敛。
     * 底层 Runtime 若无法给出停止事实仍按原有隔离规则处理，本方法不伪造成功回执。
     * 等待期间 socket 仍可能超时，调用方必须查询状态而不是猜测已经取消。
     * interruptions 在 finally 中减少，错误请求不会永久堵塞后续合法变更。
     * stopped 则有意不恢复，重启需要新的独立 Agent 实例。
     */
    private async interrupt(operation: string, message: Record<string, unknown>): Promise<unknown> {
        const reservation = this.transition;
        if (operation === "stop") this.stopped = true;
        this.interruptions++;
        try {
            if (operation === "cancel" && message.startupId !== undefined) {
                if (message.runId !== undefined) throw new Error("IPC_PAYLOAD_INVALID");
                if (
                    !reservation ||
                    reservation.id !== id(message.startupId) ||
                    !["run", "onlineStart"].includes(reservation.operation)
                )
                    throw new Error("STARTUP_NOT_FOUND");
                reservation.controller.abort();
                await reservation.done;
                return { requested: true };
            }
            if (operation === "cancel") {
                const runId = id(message.runId),
                    controller = this.runController;
                if (!this.selectedWorkspace) throw new Error("LOCAL_WORKSPACE_UNAVAILABLE");
                const store = await LocalStore.open(this.executionRoot);
                try {
                    const active = store.active();
                    if (active?.runId !== runId || active.workspaceId !== this.selectedWorkspace)
                        throw new Error("RUN_NOT_ACTIVE");
                    store.cancel(this.selectedWorkspace, runId);
                    controller?.abort();
                } finally {
                    store.close();
                }
                return { requested: true };
            }
            if (reservation && (operation === "stop" || reservation.operation === "onlineStart")) {
                reservation.controller.abort();
                await reservation.done;
            }
            if (operation === "onlineStop") {
                const online = this.online;
                this.onlineController?.abort();
                await online;
                return this.state();
            }
            this.runController?.abort();
            this.onlineController?.abort();
            for (const viewer of this.viewers.values()) viewer.controller.abort();
            await Promise.all([
                this.run,
                this.online,
                ...[...this.viewers.values()].map((viewer) => viewer.done),
            ]);
            return { stopped: true };
        } finally {
            this.interruptions--;
        }
    }

    /** 独立发行中的 Agent 已内联编译器和 SDK 代码，不能依赖开发工作区包路径完成版本探测；这里必须先逐文件核验真实发行库存，才把库存中的两种组件版本交给兼容的 Runtime 自检。
     * engineVersion 来自可信安装配置，默认仍为当前桌面发行选择。
     * loadRelease 检查目录库存、文件白名单、大小和哈希，失败直接拒绝。
     * compilerVersion 与 runnerSdkVersion 是核验后 entry 的实际字段。
     * 这两个字段不由 renderer 提供，也不单独充当哈希验证证明。
     * Runtime doctor 继续检查它支持的组件版本，而不是无条件接受元数据。
     * 浏览器检查仍启动实际已配置的匹配浏览器并渲染页面。
     * network 为真时保留控制平台可达性检查，离线不会被展示为整体通过。
     * 注册前的本地能力检查可以省略网络，因为注册请求本身要联系该控制平台。
     * 附加库存检查显示真实发行版本和规范库存摘要。
     * 编译器及 SDK 的源码版本可以与发行 engineVersion 不同。
     * 仅当原 doctor 已形成 capabilities 时才替换其发行版本字段。
     * 失败结果不能凭库存版本字符串制造 capabilities。
     * CLI 与桌面现在共用此发行适配，开发源码入口仍可保留原来的包探测。
     */
    private async diagnose(network: boolean) {
        const installed = this.config.distributionRoot
            ? await loadRuntimeDistribution(this.config.distributionRoot)
            : undefined;
        return diagnoseRelease({
            engineDirectory: installed?.engineDirectory ?? this.config.engineDirectory,
            engineVersion: installed?.engineVersion ?? this.config.engineVersion ?? "1.0.0",
            browserExecutable: installed?.browserExecutable ?? this.config.browserExecutable,
            ...(network ? { server: this.config.origin } : {}),
        });
    }

    /** 在线领取使用已绑定设备的真实会话和现有执行监管器，启动准备期间仍受同一个控制器约束；查询设备状态失败或取消会关闭该会话，只有检查成功后才把 claimLoop 登记为活动任务。 */
    private async startOnline(controller: AbortController) {
        if (this.online || this.run) throw new Error("AGENT_BUSY");
        const installed = this.config.distributionRoot
            ? await loadRuntimeDistribution(this.config.distributionRoot)
            : undefined;
        const diagnostics = await this.diagnose(false);
        controller.signal.throwIfAborted();
        if (!diagnostics.ok || !diagnostics.capabilities) {
            throw new Error("DOCTOR_FAILED");
        }
        const config = await this.deviceConfig(),
            session = new DeviceSession(this.device, new RuntimeClient(config.server));
        await session.open();
        const client = new AgentClient(session),
            root = join(this.root, "agent");
        this.onlineController = controller;
        let info: S["RuntimeDTO"];
        try {
            info = await client.request<S["RuntimeDTO"]>("/internal/v1/runtime");
            controller.signal.throwIfAborted();
            if (info.capabilities.engineVersion !== diagnostics.capabilities.engineVersion)
                throw new Error("RUNTIME_CAPABILITY_MISMATCH_REENROLL");
        } catch (error) {
            await session.close();
            this.onlineController = undefined;
            throw error;
        }
        const supervisor = new ExecutionSupervisor({
            ...(installed ? { execution: installed.execution } : {}),
            root,
            client,
            releaseDirectory: this.config.engineDirectory,
            browserExecutable: this.config.browserExecutable,
        });
        this.online = claimLoop({
            root,
            client,
            supervisor,
            runnerId: config.runnerId,
            capabilities: diagnostics.capabilities,
            signal: this.onlineController.signal,
        })
            .catch((error) => {
                if (!this.onlineController?.signal.aborted) this.lastError = failure(error);
            })
            .finally(async () => {
                await session.close();
                this.online = undefined;
                this.onlineController = undefined;
            });
    }

    /** 每个查看器只有一个私有 Trace 副本和独立取消句柄，宿主心跳仅维持这个窗口的租期；宿主崩溃后租期到期回收查看器，正常关闭会等待真实进程退出再删副本，不中止测试 Agent。 */
    private async startViewer(
        path: string,
    ): Promise<{ viewerId: string; url: string; pid: number }> {
        if (this.viewers.size >= 2) throw new Error("TRACE_WINDOW_LIMIT");
        const viewerId = randomUUID(),
            controller = new AbortController();
        let announce!: (value: { viewerId: string; url: string; pid: number }) => void;
        let fail!: (reason: unknown) => void;
        const ready = new Promise<{ viewerId: string; url: string; pid: number }>(
            (resolve, reject) => {
                announce = resolve;
                fail = reject;
            },
        );
        const expiry = setTimeout(() => {
            controller.abort();
            fail(new Error("TRACE_START_TIMEOUT"));
        }, 10000);
        const done = openTrace(path, controller.signal, (url, pid) =>
            announce({ viewerId, url, pid }),
        )
            .catch((error) => {
                fail(error);
                this.lastError = failure(error);
            })
            .finally(async () => {
                const viewer = this.viewers.get(viewerId);
                if (viewer) clearTimeout(viewer.expiry);
                this.viewers.delete(viewerId);
                await rm(path, { force: true });
            });
        this.viewers.set(viewerId, { controller, done, expiry });
        return ready;
    }

    /** 本机原始证据要求 main 已完成原生确认并匹配当前选定工作区，随后由 LocalReports 再检查 Run 与 Attempt 归属和文件摘要；导出副本以独占创建写入私有目录，原始证据始终保留。 */
    private async nativeArtifact(message: Record<string, unknown>) {
        const workspace = this.selectedWorkspace;
        if (!workspace || message.authorized !== true) throw new Error("RAW_EVIDENCE_FORBIDDEN");
        const runId = id(message.runId),
            attemptId = id(message.attemptId),
            artifactId = id(message.artifactId);
        const reports = new LocalReports(
            this.executionRoot,
            (requested) => requested === workspace,
        );
        const snapshot = await reports.snapshot(workspace, runId);
        const artifact = snapshot.artifacts[attemptId]?.find((item) => item.id === artifactId);
        if (!artifact) throw new Error("LOCAL_ARTIFACT_NOT_FOUND");
        if (message.action === "trace" && artifact.kind !== "TRACE")
            throw new Error("TRACE_REQUIRED");
        if (message.action === "preview" && artifact.kind !== "SCREENSHOT")
            throw new Error("SCREENSHOT_REQUIRED");
        const bytes = await reports.readRaw(workspace, runId, attemptId, artifactId);
        const directory = join(this.root, "exports");
        await privateDirectory(directory);
        const extension =
            artifact.kind === "TRACE"
                ? "zip"
                : artifact.kind === "SCREENSHOT"
                  ? "png"
                  : artifact.kind === "JUNIT"
                    ? "xml"
                    : "bin";
        const path = join(directory, `${randomUUID()}-${artifactId}.${extension}`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        if (message.action === "trace") {
            if (artifact.kind !== "TRACE") throw new Error("TRACE_REQUIRED");
            return this.startViewer(path);
        }
        return { path, kind: artifact.kind, sizeBytes: bytes.length };
    }
}
