/** Darwin 的源码宿主能力只在当前真实独立 Node24、固定 B 产物和具体观察器自检全部通过后签发，私有 WeakMap 保存实际能力而不是可复制的配置声明；本入口不改变安装角色、doctor、Electron 或默认命令行的失败关闭状态。 */
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium } from "playwright-core";
import { darwinNative, type DarwinNative } from "../native/darwin.ts";
import { isIndependentNode24 } from "../node-version.ts";
import { runControlledChildCapability } from "./controlled-child-capability.ts";
import type { ObserverBinding } from "./controlled-child-protocol.mjs";

declare const brand: unique symbol;

/** 这个类型只能表达由本模块私有品牌登记过的当前宿主对象，外部断言、结构克隆或 JSON 反序列化都不会建立 WeakMap 所有权；执行监督器仍须每次通过真实能力查验，不能只依赖编译期不可见字段判断可信来源。 */
export interface DarwinSourceCapability {
    readonly [brand]: true;
}

/** 受信源码宿主只提供已经 B 核验的临时根，浏览器固定取当前锁定 Playwright 的公共 executablePath；测试可以缩短单次停止期限但不能超过正式三十秒，业务 Job、DSL 和 renderer 不参与构造这个非序列化能力。 */
export interface DarwinSourceOptions {
    temporaryDirectory: string;
    stopTimeoutMs?: number;
}

/** 准备回调只获得双绑定、固定目标描述符和内存端点，publish 由父层持有的 B 工作目录执行有限发布；接口没有文件或目录 close 能力，因此回调不能通过取得整数或关闭宿主对象移走实际日志所有权。 */
export interface DarwinLaunchContext {
    readonly commandBinding: Readonly<ObserverBinding>;
    readonly cliBinding: Readonly<ObserverBinding>;
    readonly controlled: Readonly<{ commandBinding: Readonly<ObserverBinding>; cliBinding: Readonly<ObserverBinding>; commandJournalFd: 5; cliJournalFd: 4 }>;
    readonly wsEndpoint?: string;
    publish(name: "invocation.json" | "playwright.config.mjs", bytes: Buffer): void;
}

/** 启动参数来自源码宿主可信调用链，正安全代际复用既有 fence 而不创建本地计数器；prepare 是配置写入的内存函数缝，不能从可序列化的任务字段恢复，也不能由业务输入选择可执行插件或日志路径。 */
export interface DarwinControlledLaunch {
    kind: "TEST" | "VALIDATE" | "CLEANUP";
    ownerGeneration: number;
    /** 可见模式仅接受宿主传入的实际布尔值，下载目录只能指向本次私有工作目录内的固定 downloads 子目录；这两个有限字段不开放任意浏览器参数、可执行路径或来自 Job 的 LaunchOptions。 */
    headless?: boolean;
    downloadsPath?: string;
    prepare(context: DarwinLaunchContext): void | Promise<void>;
}

/** 实际能力状态与空的公开 token 分开存放，原生入口、固定 Chrome 和期限只有品牌验证后才向实际所有者借用；普通源码宿主以外的安装身份不会因为存在这份类型定义而获得任何启动或生产就绪声明。 */
export interface DarwinSourceState {
    readonly native: DarwinNative;
    readonly browserExecutable: string;
    readonly temporaryDirectory: string;
    readonly stopTimeoutMs: number;
}
const capabilities = new WeakMap<object, DarwinSourceState>();

/** 工厂在真实 Darwin 当前进程上先核独立稳定 Node24，再通过原 B loader 与私有临时目录完成实际子对象探针；浏览器仅检查固定公共库存路径可执行，不在能力签发期间提前派生 Chrome 或把探针结果提升成完整产品 ready。 */
export async function createDarwinSource(options: DarwinSourceOptions): Promise<DarwinSourceCapability> {
    if (process.platform !== "darwin" || !isIndependentNode24(process.versions)) throw new Error("DARWIN_SOURCE_NODE24_REQUIRED");
    const stopTimeoutMs = options.stopTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 100 || stopTimeoutMs > 30000) throw new Error("DARWIN_SOURCE_DEADLINE_INVALID");
    const native = darwinNative();
    const directory = native.openPrivateDirectory(options.temporaryDirectory, false);
    directory.close();
    const browserExecutable = chromium.executablePath();
    await access(browserExecutable, constants.X_OK);
    const probe = await runControlledChildCapability({ nodeExecutable: process.execPath, temporaryDirectory: options.temporaryDirectory });
    if (!probe.supported || probe.nodeVersion !== process.version) throw new Error("DARWIN_SOURCE_OBSERVER_UNSUPPORTED");
    const capability = Object.freeze({}) as DarwinSourceCapability;
    capabilities.set(capability, Object.freeze({ native, browserExecutable, temporaryDirectory: options.temporaryDirectory, stopTimeoutMs }));
    return capability;
}

/** 能力消费只接受同一模块实例签发并仍由私有 WeakMap 识别的原对象，不能信任外形、符号字段、冻结状态或支持布尔值；返回的借用状态用于实际所有者构造，业务配置与恢复历史都不得通过该接口补造能力。 */
export function requireDarwinSource(value: unknown): DarwinSourceState {
    const state = value && typeof value === "object" ? capabilities.get(value) : undefined;
    if (!state || process.platform !== "darwin" || !isIndependentNode24(process.versions)) throw new Error("DARWIN_SOURCE_CAPABILITY_REQUIRED");
    return state;
}
