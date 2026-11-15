/** 原生 D1 测试调用器只能启动构建脚本约定的固定成员，并把私有协议内容保存在内存中；它不授予正式 Runtime 发行能力、不修改宿主凭据后端，也不把独立测试通路误称为已安装产品接入。 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, lstat } from "node:fs/promises";

/** 固定路径只供本测试模块内部验证构建成员使用，正式发行仍必须由既有库存解析器授权；其中测试辅助程序与控制器位于独立目录，任何业务配置均不能通过这里替换生产可执行程序。 */
export const nativePaths = Object.freeze({
    production: fileURLToPath(new URL("../../build/vault-darwin/veriq_agent", import.meta.url)),
    test: fileURLToPath(new URL("../../build/vault-darwin-test/veriq_agent", import.meta.url)),
    controller: fileURLToPath(
        new URL("../../build/vault-darwin-test/veriq_keychain_controller", import.meta.url),
    ),
    memory: fileURLToPath(new URL("../../build/vault-darwin-test/veriq_acl_test", import.meta.url)),
});

/** 目标操作必须在真实 Mac 进程中开始，Linux 开发环境只能进行语法或类型验证；抛出的静态错误保留缺少实际目标的事实，既不自动下载工具链，也不将整组跳过计作原生通过。 */
export function requireMac() {
    if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch))
        throw new Error("DARWIN_VAULT_TARGET_REQUIRED");
}

/** 独立测试调用选项仅描述固定构建成员的协议输入、继承配置以及取消观察，不作为正式凭据后端的能力对象；期限始终限制在五十到五千毫秒，测试门闩与额外参数负例不会进入生产可执行程序的运行选择接口。 */
type Options = {
    args?: string[];
    capability?: object | undefined;
    closeInput?: boolean;
    afterReady?: "eof" | "extra";
    timeoutMs?: number;
    cancel?: boolean;
};
/** 调用观察把实际 close 确认、退出码和停止原因分别记录，不能由超时信号推导 exitConfirmed；响应缓冲只供调用者在内存中验证并随后覆盖，原始 stderr 和系统异常对象不属于此公开测试结果类型。 */
type Observation = {
    code: number | null;
    exitConfirmed: boolean;
    reason: "complete" | "timeout" | "cancelled" | "protocol";
    bytes: Buffer;
    ready: boolean;
};

/** 测试管道沿用正式协议的单帧与五秒上限，并独立等待 close 事实才完成调用；超时只终止本次子进程，任何秘密响应在断言前转换为布尔或固定状态，原始标准错误完全不进入测试报告。 */
export async function nativeCall(
    path: string,
    frame: string,
    options: Options = {},
): Promise<Observation> {
    requireMac();
    if (!Object.values(nativePaths).includes(path)) throw new Error("DARWIN_VAULT_MEMBER_INVALID");
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000)
        throw new Error("DARWIN_VAULT_DEADLINE_INVALID");
    return await new Promise((resolve, reject) => {
        const child = spawn(path, options.args ?? [], {
            env: { PATH: "/usr/bin:/bin" },
            stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        let reason: Observation["reason"] = "complete",
            ready = false,
            bytes = Buffer.alloc(0),
            stderr = 0;
        let killWatch: NodeJS.Timeout | undefined;
        const stop = (why: Observation["reason"]) => {
            if (reason !== "complete") return;
            reason = why;
            child.kill("SIGKILL");
            killWatch = setTimeout(() => reject(new Error("DARWIN_VAULT_EXIT_UNCONFIRMED")), 1000);
        };
        const deadline = setTimeout(() => stop("timeout"), timeoutMs);
        child.on("error", () => stop("protocol"));
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk: Buffer) => {
            if (bytes.length + chunk.length > 512) {
                chunk.fill(0);
                stop("protocol");
                return;
            }
            const next = Buffer.concat([bytes, chunk]);
            bytes.fill(0);
            chunk.fill(0);
            bytes = next;
            if (!ready && bytes.equals(Buffer.from("V1 test-ready\n"))) {
                ready = true;
                if (options.afterReady === "extra") child.stdin.write("x");
                if (options.afterReady === "eof") child.stdin.end();
                if (options.cancel) stop("cancelled");
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.length;
            chunk.fill(0);
            if (stderr > 512) stop("protocol");
        });
        child.on("close", (code) => {
            clearTimeout(deadline);
            clearTimeout(killWatch);
            child.stdin.destroy();
            resolve({ code, exitConfirmed: true, reason, ready, bytes });
        });
        const capability = child.stdio[3];
        if (capability && "end" in capability) {
            capability.on("error", () => {});
            capability.end(options.capability ? JSON.stringify(options.capability) + "\n" : "");
        }
        child.stdin.write(frame);
        if (options.closeInput) child.stdin.end();
    });
}

/** 内存测试先用合成系统状态检查生产共用错误边界，再比较跨重启模板和恶意类型树，标准输出只接受固定标记；这些回归不访问持久存储，调用者也不会把 ACL、签名数据或原始系统异常加入测试日志。 */
export async function runMemoryChecks(): Promise<boolean> {
    const status = await nativeCall(nativePaths.memory, "", { args: ["--status-regression"] });
    const statusPassed =
        status.exitConfirmed &&
        status.code === 0 &&
        status.bytes.equals(Buffer.from("SECURITY_STATUS_CHECKS_PASSED\n"));
    const expectedFailure =
        status.exitConfirmed &&
        status.code === 1 &&
        status.bytes.equals(Buffer.from("SECURITY_STATUS_CHECKS_FAILED\n"));
    status.bytes.fill(0);
    if (!statusPassed) {
        throw new Error(
            expectedFailure
                ? "DARWIN_SECURITY_STATUS_REGRESSION_FAILED"
                : "DARWIN_SECURITY_STATUS_REGRESSION_PROTOCOL_INVALID",
        );
    }
    const result = await nativeCall(nativePaths.memory, "");
    const ok =
        result.exitConfirmed &&
        result.code === 0 &&
        result.bytes.equals(Buffer.from("ACL_MEMORY_CHECKS_PASSED\n"));
    result.bytes.fill(0);
    return ok;
}

/** 创建诊断只允许固定阶段、有限状态和即时数值结果，字段表同时约束控制器输入与工作流收集；这里不保存原始协议、路径或异常文字，新增阶段必须经过生产者及消费者的一致性检查。 */
const diagnosticStages = [
    "STARTUP",
    "NO_UI",
    "RECEIVE",
    "CREATE_STATE",
    "LIVE_UID_LOGIN",
    "LIVE_SECURITY_SESSION",
    "LIVE_SESSION_BITS",
    "ATTEST_DISPOSABLE",
    "ATTEST_ACK",
    "ATTEST_UID",
    "ATTEST_LOGIN",
    "ATTEST_SESSION",
    "HELPER_REALPATH",
    "HELPER_NAME",
    "HELPER_STAT",
    "RANDOM",
    "DIRECTORY",
    "DIRECTORY_BIND",
    "KEYCHAIN_CREATE",
    "KEYCHAIN_PATH",
    "KEYCHAIN_BIND",
    "KEYCHAIN_MODE",
    "KEYCHAIN_IDENTITY",
    "KEYCHAIN_STAT",
    "CREATE_REPLY",
    "CLEANUP_DELETE",
    "CLEANUP_DIRECTORY",
] as const;
const diagnosticFailures = [
    "REFUSED",
    "DEADLINE",
    "PROCESS_ERROR",
    "CLOSED",
    "PROTOCOL",
    "EXIT_UNCONFIRMED",
] as const;
const diagnosticSignals = ["SIGKILL", "SIGTERM", "SIGABRT", "SIGSEGV", "SIGPIPE", "OTHER"] as const;
type DiagnosticFailure = (typeof diagnosticFailures)[number];
type DiagnosticRecord = {
    schemaVersion: 1;
    stage: (typeof diagnosticStages)[number];
    state: "entered" | "passed" | "failed";
    osStatus?: number;
    errno?: number;
    created?: boolean;
    storeReferencePresent?: boolean;
    regularFile?: boolean;
    ownerMatches?: boolean;
    privateMode?: boolean;
};
/** Node 测试结算只记录固定来源与有限状态，绝不读取被抛出对象的名称、消息、堆栈或构造器；正文、覆盖和清理分别保留事实，使报告能区分主失败与随后发生的次要失败而不推断系统清理成功。 */
export type DarwinCaseFacts = {
    bodyStatus: "NOT_RECORDED" | "PASSED" | "FAILED";
    cleanupStatus: "NOT_RECORDED" | "PASSED" | "FAILED";
    wipeStatus: "NOT_RECORDED" | "PASSED" | "FAILED";
    primary: "NONE" | "BODY" | "WIPE" | "CLEANUP";
    secondary: "NONE" | "WIPE" | "CLEANUP" | "WIPE_AND_CLEANUP";
};

/** 正文先结算并发布有限状态，然后按原序逐一尝试覆盖全部密钥且恰好清理一次，任何观察器异常均被隔离；独立布尔标志保留抛出 undefined 等值的失败事实，最后重新抛出最早的同一个对象供原测试报告器处理。 */
export async function settleDarwinCase(
    body: () => Promise<void>,
    wipes: (() => void)[],
    cleanup: () => Promise<void>,
    observe?: (facts: DarwinCaseFacts) => void,
): Promise<void> {
    let failed = false;
    let primary: unknown;
    const facts: DarwinCaseFacts = {
        bodyStatus: "NOT_RECORDED",
        cleanupStatus: "NOT_RECORDED",
        wipeStatus: "NOT_RECORDED",
        primary: "NONE",
        secondary: "NONE",
    };
    const publish = () => {
        try {
            observe?.({ ...facts });
        } catch {}
    };
    try {
        await body();
        facts.bodyStatus = "PASSED";
    } catch (error) {
        failed = true;
        primary = error;
        facts.bodyStatus = "FAILED";
        facts.primary = "BODY";
    }
    publish();
    facts.wipeStatus = "PASSED";
    for (const wipe of wipes) {
        try {
            wipe();
        } catch (error) {
            facts.wipeStatus = "FAILED";
            if (!failed) {
                failed = true;
                primary = error;
                facts.primary = "WIPE";
            } else if (facts.primary === "BODY") facts.secondary = "WIPE";
        }
    }
    publish();
    try {
        await cleanup();
        facts.cleanupStatus = "PASSED";
    } catch (error) {
        facts.cleanupStatus = "FAILED";
        if (!failed) {
            failed = true;
            primary = error;
            facts.primary = "CLEANUP";
        } else facts.secondary = facts.secondary === "WIPE" ? "WIPE_AND_CLEANUP" : "CLEANUP";
    }
    publish();
    if (failed) throw primary;
}

const diagnosticOperations = [
    "create",
    "run",
    "race",
    "lock",
    "unlock",
    "seed",
    "remove",
    "unchanged",
    "read-denial",
    "cleanup",
    "UNKNOWN",
] as const;
const diagnosticVerbs = ["GET", "SET", "DELETE", "UNKNOWN"] as const;
const responseShapes = ["EMPTY", "PARSED_V1", "INVALID", "UNKNOWN"] as const;
type OperationContext = {
    operation: (typeof diagnosticOperations)[number];
    verb: (typeof diagnosticVerbs)[number];
    ordinal: number;
    category: DiagnosticFailure | "HELPER" | "BODY";
    helperExit: number | "UNKNOWN";
    shape: (typeof responseShapes)[number];
    provenance: "CONTROLLER" | "BODY_BOUNDARY";
};

/** Node 结算字段必须构成按正文、覆盖、清理顺序可到达的真实状态，额外字段和不一致主次来源一律拒绝；校验器只重建有限值对象，旧概要完全缺少此字段时仍由调用方保留未知而不是补出成功。 */
function caseFacts(value: unknown): DarwinCaseFacts | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as DarwinCaseFacts;
    if (
        Object.keys(item).sort().join(",") !==
        "bodyStatus,cleanupStatus,primary,secondary,wipeStatus"
    )
        return;
    for (const key of ["bodyStatus", "cleanupStatus", "wipeStatus"] as const)
        if (!["NOT_RECORDED", "PASSED", "FAILED"].includes(item[key])) return;
    if (
        item.bodyStatus === "NOT_RECORDED" &&
        (item.wipeStatus !== "NOT_RECORDED" || item.cleanupStatus !== "NOT_RECORDED")
    )
        return;
    if (item.wipeStatus === "NOT_RECORDED" && item.cleanupStatus !== "NOT_RECORDED") return;
    const primary =
        item.bodyStatus === "FAILED"
            ? "BODY"
            : item.wipeStatus === "FAILED"
              ? "WIPE"
              : item.cleanupStatus === "FAILED"
                ? "CLEANUP"
                : "NONE";
    const wipe = primary === "BODY" && item.wipeStatus === "FAILED";
    const cleanup = primary !== "CLEANUP" && item.cleanupStatus === "FAILED";
    const secondary =
        wipe && cleanup ? "WIPE_AND_CLEANUP" : wipe ? "WIPE" : cleanup ? "CLEANUP" : "NONE";
    if (item.primary !== primary || item.secondary !== secondary) return;
    return {
        bodyStatus: item.bodyStatus,
        cleanupStatus: item.cleanupStatus,
        wipeStatus: item.wipeStatus,
        primary,
        secondary,
    };
}

/** 操作上下文只接受固定派发表、调用方提供的协议动词和已返回的退出与形状事实，命令序号不能由字符串强制转换；正文边界仅定位断言前最后一次调用，与控制器或 helper 的失败证据明确分开。 */
function operationContext(value: unknown): OperationContext | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as OperationContext;
    if (
        Object.keys(item).sort().join(",") !==
            "category,helperExit,operation,ordinal,provenance,shape,verb" ||
        !diagnosticOperations.includes(item.operation) ||
        !diagnosticVerbs.includes(item.verb) ||
        !Number.isInteger(item.ordinal) ||
        item.ordinal < 1 ||
        item.ordinal > 65535 ||
        ![...diagnosticFailures, "HELPER", "BODY"].includes(item.category) ||
        (item.helperExit !== "UNKNOWN" &&
            (!Number.isInteger(item.helperExit) || item.helperExit < 0 || item.helperExit > 255)) ||
        !responseShapes.includes(item.shape) ||
        !["CONTROLLER", "BODY_BOUNDARY"].includes(item.provenance) ||
        (item.provenance === "BODY_BOUNDARY") !== (item.category === "BODY") ||
        (item.operation !== "run" && item.verb !== "UNKNOWN") ||
        (item.operation !== "run" && (item.helperExit !== "UNKNOWN" || item.shape !== "UNKNOWN")) ||
        (item.category === "HELPER" && item.operation !== "run")
    )
        return;
    return {
        operation: item.operation,
        verb: item.verb,
        ordinal: item.ordinal,
        category: item.category,
        helperExit: item.helperExit,
        shape: item.shape,
        provenance: item.provenance,
    };
}

type DiagnosticSummary = {
    schemaVersion: 1;
    fixture: number;
    records: DiagnosticRecord[];
    rejected: boolean;
    incomplete: boolean;
    firstFailure: DiagnosticFailure | null;
    closeObserved: boolean;
    code: number | null;
    signal: (typeof diagnosticSignals)[number] | null;
    nodeCase?: DarwinCaseFacts;
    operationContext?: OperationContext;
};
const diagnosticPrefix = "VERIQ_D1_DIAGNOSTICS ";
const diagnosticByteLimit = 8192;
const diagnosticRecordLimit = 96;

/** 字段校验先拒绝所有未声明属性，再重建有序的安全记录，避免反序列化对象夹带私有信息；系统状态只接受有符号三十二位整数，errno 只能是非负整数而布尔事实不接受数值替代。 */
function diagnosticRecord(value: unknown): DiagnosticRecord | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (
        Object.keys(item).some(
            (key) =>
                ![
                    "schemaVersion",
                    "stage",
                    "state",
                    "osStatus",
                    "errno",
                    "created",
                    "storeReferencePresent",
                    "regularFile",
                    "ownerMatches",
                    "privateMode",
                ].includes(key),
        ) ||
        item.schemaVersion !== 1 ||
        !diagnosticStages.includes(item.stage as DiagnosticRecord["stage"]) ||
        !["entered", "passed", "failed"].includes(item.state as string)
    )
        return;
    const safe: DiagnosticRecord = {
        schemaVersion: 1,
        stage: item.stage as DiagnosticRecord["stage"],
        state: item.state as DiagnosticRecord["state"],
    };
    for (const key of ["osStatus", "errno"] as const) {
        if (!(key in item)) continue;
        const number = item[key];
        if (
            typeof number !== "number" ||
            !Number.isInteger(number) ||
            number < (key === "errno" ? 0 : -2147483648) ||
            number > 2147483647
        )
            return;
        safe[key] = number;
    }
    for (const key of [
        "created",
        "storeReferencePresent",
        "regularFile",
        "ownerMatches",
        "privateMode",
    ] as const) {
        if (!(key in item)) continue;
        if (typeof item[key] !== "boolean") return;
        safe[key] = item[key];
    }
    /** 三个文件事实只允许形成原短路链可到达的终态前缀，失败必须以实际求值的假值结束且成功必须全部为真；旧记录全部缺失时继续保留未知，带 errno 的调用失败不能同时声称后续谓词已经执行。 */
    if (["regularFile", "ownerMatches", "privateMode"].some((key) => key in item)) {
        if (safe.stage !== "KEYCHAIN_STAT" || safe.state === "entered" || "errno" in item) return;
        if (safe.regularFile === false) {
            if ("ownerMatches" in item || "privateMode" in item || safe.state !== "failed") return;
        } else if (safe.regularFile === true && safe.ownerMatches === false) {
            if ("privateMode" in item || safe.state !== "failed") return;
        } else if (safe.regularFile === true && safe.ownerMatches === true) {
            if (safe.privateMode !== (safe.state === "passed")) return;
        } else return;
    }
    return safe;
}

/** 每个夹具的流式过滤器只保留已验证记录，单行原始缓冲固定为五百一十二字节且消费后覆盖；预算包含概要预留空间，达到字节或条数上限后继续排空输入但不再接受记录，也不改变控制器结果。 */
export function createDarwinDiagnosticFilter() {
    const records: DiagnosticRecord[] = [];
    const pending = Buffer.alloc(512);
    let length = 0,
        dropping = false,
        stopped = false,
        retainedBytes = 512;
    let rejected = false,
        incomplete = false,
        firstFailure: DiagnosticFailure | null = null;
    let closeObserved = false,
        code: number | null = null,
        signal: DiagnosticSummary["signal"] = null;
    let nodeCase: DarwinCaseFacts | undefined;
    let firstOperation: OperationContext | undefined;
    let current: Omit<OperationContext, "category" | "provenance"> | undefined;
    let commandOrdinal = 0;
    let metadataStopped = false;
    const rejectMetadata = () => {
        rejected = true;
        incomplete = true;
        metadataStopped = true;
    };
    const capture = (
        category: OperationContext["category"],
        provenance: OperationContext["provenance"],
    ) => {
        if (!metadataStopped && current && !firstOperation)
            firstOperation = { ...current, category, provenance };
    };
    return {
        /** 命令上下文在实际排队结束后记录，非法值与序号耗尽只停止元数据接纳而不阻断真实操作；固定动词由已知调用方提供，绝不从帧中提取档案、版本、密钥或任意请求字段加入诊断。 */
        operation(operation: string, verb: string) {
            if (metadataStopped) return;
            if (
                !diagnosticOperations.includes(operation as OperationContext["operation"]) ||
                !diagnosticVerbs.includes(verb as OperationContext["verb"]) ||
                commandOrdinal >= 65535 ||
                (operation !== "run" && verb !== "UNKNOWN")
            ) {
                rejectMetadata();
                return;
            }
            current = {
                operation: operation as OperationContext["operation"],
                verb: verb as OperationContext["verb"],
                ordinal: ++commandOrdinal,
                helperExit: "UNKNOWN",
                shape: "UNKNOWN",
            };
        },
        /** helper 事实只来自已经返回的控制器信封以及实际回复验证结果，缺失退出码绝不猜测成非零；预期故障恢复可以传入有效条件，合法领域拒绝也不会被当作协议失败而覆盖之后正文的断言边界。 */
        helper(code: unknown, shape: string, valid: boolean) {
            if (metadataStopped || !current) return;
            if (
                current.operation !== "run" ||
                (code !== "UNKNOWN" &&
                    (typeof code !== "number" ||
                        !Number.isInteger(code) ||
                        code < 0 ||
                        code > 255)) ||
                !responseShapes.includes(shape as OperationContext["shape"]) ||
                typeof valid !== "boolean"
            ) {
                rejectMetadata();
                return;
            }
            current.helperExit = code as number | "UNKNOWN";
            current.shape = shape as OperationContext["shape"];
            if (!valid) capture("HELPER", "CONTROLLER");
        },
        /** 测试结算通过独立 Node 来源写入状态，正文失败只在尚无原操作失败时冻结最后边界；恶意访问器或观察分类异常只标记不完整，不得替换调用方原错误或将后续清理拒绝变成最早原因。 */
        nodeCase(value: DarwinCaseFacts) {
            if (metadataStopped) return;
            try {
                const safe = caseFacts(value);
                if (!safe) {
                    rejectMetadata();
                    return;
                }
                nodeCase = safe;
                if (safe.bodyStatus === "FAILED") capture("BODY", "BODY_BOUNDARY");
            } catch {
                rejectMetadata();
            }
        },
        /** 原始分块只逐字节进入有限行缓冲，跨块换行与非法编码使用相同验证路径；超长行直接丢弃到下一换行，达到总体上限则停止接纳，最终无论解析结果如何都覆盖调用者交付的原始分块。 */
        push(bytes: Buffer) {
            try {
                for (const byte of bytes) {
                    if (stopped) continue;
                    if (byte !== 10) {
                        if (!dropping && length < pending.length) pending[length++] = byte;
                        else {
                            dropping = true;
                            rejected = true;
                            pending.fill(0);
                            length = 0;
                        }
                        continue;
                    }
                    if (!dropping) {
                        try {
                            const item = diagnosticRecord(
                                JSON.parse(
                                    new TextDecoder("utf-8", { fatal: true }).decode(
                                        pending.subarray(0, length),
                                    ),
                                ),
                            );
                            if (!item) rejected = true;
                            else {
                                const size = Buffer.byteLength(JSON.stringify(item)) + 1;
                                if (
                                    records.length >= diagnosticRecordLimit ||
                                    retainedBytes + size > diagnosticByteLimit
                                ) {
                                    stopped = true;
                                    incomplete = true;
                                } else {
                                    records.push(item);
                                    retainedBytes += size;
                                }
                            }
                        } catch {
                            rejected = true;
                        }
                    }
                    pending.fill(0);
                    length = 0;
                    dropping = false;
                }
            } finally {
                bytes.fill(0);
            }
        },
        /** 首个固定失败类别一旦出现便不再被退出或清理错误覆盖，未知输入只降低观察完整性而不变成日志正文；此方法不触发 kill、重试或协议回复，也不修改调用方已有错误对象与抛出时机。 */
        fail(reason: DiagnosticFailure) {
            if (diagnosticFailures.includes(reason)) {
                firstFailure ??= reason;
                capture(reason, "CONTROLLER");
            } else rejected = true;
        },
        /** 退出事实只在真实 child close 回调写入，未记录的状态保持空值而不是猜测成功；退出信号映射到有限集合，其他信号只保留静态 OTHER 标志，不能从任何退出状态推导钥匙串清理完成。 */
        close(exitCode: number | null, exitSignal: string | null) {
            closeObserved = true;
            code =
                Number.isInteger(exitCode) && exitCode !== null && exitCode >= 0 && exitCode <= 255
                    ? exitCode
                    : null;
            signal =
                exitSignal === null
                    ? null
                    : diagnosticSignals.includes(
                            exitSignal as NonNullable<DiagnosticSummary["signal"]>,
                        )
                      ? (exitSignal as DiagnosticSummary["signal"])
                      : "OTHER";
        },
        /** 概要在原有有限退出结算后生成，未闭合阶段、残留半行和任何截断都保留为不完整观察；返回值复制已验证记录并覆盖原始缓冲，此后继续排空迟到分块但不把晚到信息补成既有清理成功。 */
        finish(fixture: number): DiagnosticSummary {
            const entered = new Set<DiagnosticRecord["stage"]>();
            for (const record of records) {
                if (record.state === "entered") entered.add(record.stage);
                else entered.delete(record.stage);
            }
            incomplete ||=
                entered.size !== 0 ||
                length !== 0 ||
                dropping ||
                rejected ||
                !closeObserved ||
                records.length === 0 ||
                records.at(-1)?.state === "entered";
            pending.fill(0);
            length = 0;
            stopped = true;
            const summary: DiagnosticSummary = {
                schemaVersion: 1,
                fixture,
                records: records.map((item) => ({ ...item })),
                rejected,
                incomplete,
                firstFailure,
                closeObserved,
                code,
                signal,
                ...(nodeCase ? { nodeCase: { ...nodeCase } } : {}),
                ...(firstOperation ? { operationContext: { ...firstOperation } } : {}),
            };
            if (Buffer.byteLength(JSON.stringify({ ...summary, records: [] })) > 512) {
                delete summary.nodeCase;
                delete summary.operationContext;
                summary.rejected = true;
                summary.incomplete = true;
            }
            return summary;
        },
    };
}

/** 工作流只消费夹具已收敛的概要并再次使用同一字段校验，诊断行从原始 TAP 日志删除后仅保存在报告内；最多两个不同序号和十六 KiB，非法或截断候选不回显，原测试失败与清理推导均保持独立。 */
export function collectDarwinDiagnostics(streams: Buffer[]) {
    const fixtures: DiagnosticSummary[] = [];
    let rejected = false;
    const outputs = streams.map((bytes) => {
        const lines: string[] = [];
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            for (const line of text.split(/(?<=\n)/)) {
                if (!line.includes("VERIQ_D1_DIAGNOSTICS")) {
                    lines.push(line);
                    continue;
                }
                try {
                    const raw = line.startsWith("# ") ? line.slice(2) : line;
                    if (!raw.startsWith(diagnosticPrefix) || !raw.endsWith("\n")) throw new Error();
                    const encoded = raw.slice(diagnosticPrefix.length, -1);
                    if (Buffer.byteLength(encoded) > diagnosticByteLimit) throw new Error();
                    const item = JSON.parse(encoded) as DiagnosticSummary;
                    if (
                        !item ||
                        Array.isArray(item) ||
                        Object.keys(item)
                            .filter((key) => !["nodeCase", "operationContext"].includes(key))
                            .sort()
                            .join(",") !==
                            "closeObserved,code,firstFailure,fixture,incomplete,records,rejected,schemaVersion,signal" ||
                        item.schemaVersion !== 1 ||
                        ![1, 2].includes(item.fixture) ||
                        fixtures.some((prior) => prior.fixture === item.fixture) ||
                        typeof item.rejected !== "boolean" ||
                        typeof item.incomplete !== "boolean" ||
                        typeof item.closeObserved !== "boolean" ||
                        (item.firstFailure !== null &&
                            !diagnosticFailures.includes(item.firstFailure)) ||
                        (item.code !== null &&
                            (!Number.isInteger(item.code) || item.code < 0 || item.code > 255)) ||
                        (item.signal !== null && !diagnosticSignals.includes(item.signal)) ||
                        !Array.isArray(item.records) ||
                        item.records.length > diagnosticRecordLimit
                    )
                        throw new Error();
                    const node = "nodeCase" in item ? caseFacts(item.nodeCase) : undefined;
                    const context =
                        "operationContext" in item
                            ? operationContext(item.operationContext)
                            : undefined;
                    if (
                        ("nodeCase" in item && !node) ||
                        ("operationContext" in item && !context) ||
                        (context?.provenance === "BODY_BOUNDARY" && node?.bodyStatus !== "FAILED")
                    )
                        throw new Error();
                    const records = item.records.map(diagnosticRecord);
                    if (records.some((record) => !record)) throw new Error();
                    const safe: DiagnosticSummary = {
                        schemaVersion: 1,
                        fixture: item.fixture,
                        records: records as DiagnosticRecord[],
                        rejected: item.rejected,
                        incomplete: item.incomplete,
                        firstFailure: item.firstFailure,
                        closeObserved: item.closeObserved,
                        code: item.code,
                        signal: item.signal,
                        ...(node ? { nodeCase: node } : {}),
                        ...(context ? { operationContext: context } : {}),
                    };
                    if (Buffer.byteLength(JSON.stringify({ ...safe, records: [] })) > 512)
                        throw new Error();
                    if (Buffer.byteLength(JSON.stringify([...fixtures, safe])) > 16384)
                        throw new Error();
                    fixtures.push(safe);
                } catch {
                    rejected = true;
                }
            }
        } catch {
            rejected = true;
            lines.length = 0;
        } finally {
            bytes.fill(0);
        }
        return Buffer.from(lines.join(""));
    });
    return { outputs, fixtures, rejected };
}
let diagnosticOrdinal = 0;

/** 专用控制器由操作者配置的会话声明启动，并在原生层再次核对真实 UID、登录名和安全会话；声明文件不含密码或密钥，密码由系统随机源在控制器内产生，创建与删除的偏好副作用只允许发生在该可丢弃账户。 */
export async function dedicatedFixture() {
    requireMac();
    const configPath = process.env.VERIQ_D1_DISPOSABLE_SESSION;
    if (!configPath) throw new Error("DARWIN_VAULT_DISPOSABLE_SESSION_REQUIRED");
    const info = await lstat(configPath);
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 4096 ||
        info.uid !== process.getuid!() ||
        info.mode & 0o077
    )
        throw new Error("DARWIN_VAULT_SESSION_CONFIG_INVALID");
    const attestation: unknown = JSON.parse(await readFile(configPath, "utf8"));
    const child = spawn(nativePaths.controller, [], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const diagnostics = createDarwinDiagnosticFilter();
    const ordinal = ++diagnosticOrdinal;
    let emitted = false;
    let settling = false;
    /** 诊断输出延后至原控制器的有界退出结算，避免 stdout 拒绝先到而遗漏已经排队的 stderr 阶段；只有两个固定序号可导出，序列化或观察输出失败不能替换原 SESSION_REFUSED 或清理失败。 */
    const emitDiagnostics = () => {
        if (emitted || ordinal > 2) return;
        emitted = true;
        try {
            console.error(diagnosticPrefix + JSON.stringify(diagnostics.finish(ordinal)));
        } catch {}
    };
    let pending = Buffer.alloc(0),
        sequence = Promise.resolve(),
        closed = false;
    let receive: ((value: Record<string, unknown>) => void) | undefined;
    let failure: ((error: Error) => void) | undefined;
    const exited = new Promise<void>((resolve) =>
        child.once("close", (code, signal) => {
            diagnostics.close(code, signal);
            if (failure) diagnostics.fail("CLOSED");
            closed = true;
            failure?.(new Error("DARWIN_VAULT_CONTROLLER_EXITED"));
            resolve();
        }),
    );
    /** 控制器错误也必须等待真实 close 才能交回调用方，最多一秒的退出核对与五秒请求期限分别计量；超过核对期限保留明确未知结果，不把已经调用 kill 当成控制器及其自有存储都完成清理。 */
    const confirmedExit = async () => {
        if (closed) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                diagnostics.fail("EXIT_UNCONFIRMED");
                reject(new Error("DARWIN_VAULT_CONTROLLER_EXIT_UNCONFIRMED"));
            }, 1000);
            void exited.then(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    };
    child.on("error", () => {
        diagnostics.fail("PROCESS_ERROR");
        failure?.(new Error("DARWIN_VAULT_CONTROLLER_FAILED"));
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", (bytes: Buffer) => diagnostics.push(bytes));
    child.stdout.on("data", (bytes: Buffer) => {
        if (pending.length + bytes.length > 8192) {
            diagnostics.fail("PROTOCOL");
            bytes.fill(0);
            child.kill("SIGKILL");
            return;
        }
        const next = Buffer.concat([pending, bytes]);
        pending.fill(0);
        bytes.fill(0);
        pending = next;
        const newline = pending.indexOf(10);
        if (newline < 0) return;
        try {
            const reply: unknown = JSON.parse(pending.subarray(0, newline).toString("utf8"));
            if (
                !reply ||
                typeof reply !== "object" ||
                Array.isArray(reply) ||
                newline !== pending.length - 1
            )
                throw new Error();
            pending.fill(0);
            pending = Buffer.alloc(0);
            receive?.(reply as Record<string, unknown>);
        } catch {
            diagnostics.fail("PROTOCOL");
            child.kill("SIGKILL");
        }
    });
    const command = async (
        operation: string,
        fields: object = {},
        verb: OperationContext["verb"] = "UNKNOWN",
    ): Promise<Record<string, unknown>> => {
        const frame = (fields as { frame?: unknown }).frame;
        const mutation =
            operation === "race" ||
            (operation === "run" && typeof frame === "string" && /^V1 (set|delete) /.test(frame));
        let complete!: () => void;
        const prior = sequence;
        sequence = new Promise<void>((resolve) => {
            complete = resolve;
        });
        await prior;
        diagnostics.operation(operation, verb);
        try {
            if (closed) {
                diagnostics.fail("CLOSED");
                throw new Error("DARWIN_VAULT_CONTROLLER_CLOSED");
            }
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    diagnostics.fail("DEADLINE");
                    child.kill("SIGKILL");
                    reject(new Error("DARWIN_VAULT_CONTROLLER_DEADLINE"));
                }, 5000);
                failure = (error) => {
                    clearTimeout(timer);
                    reject(error);
                };
                receive = (value) => {
                    clearTimeout(timer);
                    receive = undefined;
                    failure = undefined;
                    if (value.ok !== true) {
                        diagnostics.fail("REFUSED");
                        reject(new Error("DARWIN_VAULT_CONTROLLER_REFUSED"));
                    } else resolve(value);
                };
                child.stdin.write(JSON.stringify({ operation, ...fields }) + "\n");
            });
        } catch {
            if (!closed) child.kill("SIGKILL");
            pending.fill(0);
            await confirmedExit();
            throw new Error(
                mutation
                    ? "DARWIN_VAULT_MUTATION_UNCONFIRMED"
                    : "DARWIN_VAULT_CONTROLLER_OPERATION_FAILED",
            );
        } finally {
            complete();
        }
    };
    try {
        await command("create", { attestation });
    } catch {
        child.kill("SIGKILL");
        try {
            await confirmedExit();
        } finally {
            emitDiagnostics();
        }
        throw new Error("DARWIN_VAULT_SESSION_REFUSED");
    }
    const call = async (
        operation: string,
        profile: string,
        version: string,
        key?: Buffer,
        fault?: string,
    ) => {
        const reply = await command(
            "run",
            {
                frame: `V1 ${operation} ${profile} ${version}${key ? " " + key.toString("base64url") : ""}\n`,
                fault,
            },
            operation === "get"
                ? "GET"
                : operation === "set"
                  ? "SET"
                  : operation === "delete"
                    ? "DELETE"
                    : "UNKNOWN",
        );
        if (
            reply.exitConfirmed !== true ||
            typeof reply.response !== "string" ||
            typeof reply.code !== "number" ||
            reply.response.length > 512
        ) {
            diagnostics.helper(
                typeof reply.code === "number" &&
                    Number.isInteger(reply.code) &&
                    reply.code >= 0 &&
                    reply.code <= 255
                    ? reply.code
                    : "UNKNOWN",
                reply.response === "" ? "EMPTY" : "UNKNOWN",
                false,
            );
            throw new Error("DARWIN_VAULT_EXIT_UNCONFIRMED");
        }
        diagnostics.helper(
            reply.code,
            reply.response === "" ? "EMPTY" : "UNKNOWN",
            fault !== undefined || reply.code === 0,
        );
        return {
            exitConfirmed: true,
            code: reply.code,
            bytes: Buffer.from(reply.response, "ascii"),
        };
    };
    const cleanup = async () => {
        try {
            await command("cleanup");
            child.stdin.end();
            await confirmedExit();
        } finally {
            try {
                pending.fill(0);
                if (!closed) {
                    child.kill("SIGKILL");
                    await confirmedExit();
                }
            } finally {
                if (!settling) emitDiagnostics();
            }
        }
    };
    return {
        /** 专用测试通过同一可移植结算器先保留正文结局再逐一覆盖原缓冲和清理，只有诊断导出延后至结算完成；实际清理函数的命令、终止、期限和退出确认仍保持原顺序，失败对象交回原测试报告器。 */
        async settle(body: () => Promise<void>, wipes: (() => void)[]) {
            settling = true;
            try {
                await settleDarwinCase(body, wipes, cleanup, (facts) =>
                    diagnostics.nodeCase(facts),
                );
            } finally {
                settling = false;
                emitDiagnostics();
            }
        },
        /** 普通状态调用只允许既有 V1 固定状态回执且要求原生进程已经正常退出，任何含密钥的读取回复都不能误入此解析器；原始管道缓冲在返回或抛错之前覆盖，测试断言只能得到不会泄漏材料的状态字符串。 */
        async status(operation: string, profile: string, version: string, key?: Buffer) {
            const result = await call(operation, profile, version, key);
            try {
                const match =
                    /^V1 (ok|missing|failed|locked|unavailable|mutation-unconfirmed)\n$/.exec(
                        result.bytes.toString("ascii"),
                    );
                diagnostics.helper(
                    result.code,
                    result.bytes.length === 0 ? "EMPTY" : match ? "PARSED_V1" : "INVALID",
                    result.code === 0 && !!match,
                );
                if (result.code !== 0 || !match) {
                    if (operation === "set" || operation === "delete")
                        return "mutation-unconfirmed";
                    throw new Error("DARWIN_VAULT_RESPONSE_INVALID");
                }
                return match[1];
            } finally {
                result.bytes.fill(0);
            }
        },
        /** 精确版本读取通过新的真实 helper 进程完成，并在内存里与期望三十二字节的规范 V1 编码比较；实际回复和期望缓冲都在 finally 中覆盖，失败仅返回布尔而不让断言框架打印两个密钥的字节差异。 */
        async matches(profile: string, version: string, key: Buffer) {
            const result = await call("get", profile, version);
            const expected = Buffer.from(`V1 ok ${key.toString("base64url")}\n`);
            try {
                const matched = result.bytes.equals(expected);
                diagnostics.helper(
                    result.code,
                    result.bytes.length === 0 ? "EMPTY" : matched ? "PARSED_V1" : "UNKNOWN",
                    result.code === 0 && result.bytes.length !== 0,
                );
                return result.code === 0 && matched;
            } finally {
                result.bytes.fill(0);
                expected.fill(0);
            }
        },
        /** 测试管理操作只交给已经完成会话声明的固定控制器，调用方不能选择任意可执行程序或钥匙串路径；方法等待该操作的明确结果并由控制器负责真正的 lock 或 unlock，不在 TypeScript 中模拟锁定标志。 */
        async control(operation: string, fields: object = {}) {
            await command(operation, fields);
        },
        /** 两个真实 helper 在控制器内同时启动并停在已确认缺失的写入边界，测试要求真实系统返回一次新增和一次重复；返回值只包含计数、布尔和退出事实，不把排队串行调用误当作竞争，也不输出任一密钥正文。 */
        async race(profile: string, version: string, first: Buffer, second: Buffer) {
            const reply = await command("race", {
                profile,
                version,
                keys: [first.toString("base64url"), second.toString("base64url")],
            });
            return (
                reply.absent === 2 &&
                reply.added === 1 &&
                reply.duplicate === 1 &&
                reply.exited === 2 &&
                reply.outcomes === true &&
                reply.readback === true
            );
        },
        /** 未变化证明要求控制器实际重读目标材料、公开 ACL 和非秘密属性三个独立结果都成立，任何不可读取或不匹配都不会降级成主密文文件未变；调用方只接收布尔组合，底层材料和权限主体保持在私有通道内。 */
        async unchanged(profile: string, version: string) {
            const reply = await command("unchanged", {
                profile,
                version,
            });
            return (
                reply.valueUnchanged === true &&
                reply.aclUnchanged === true &&
                reply.attributesUnchanged === true
            );
        },
        /** 独立系统拒绝检查要求被拒绝的 helper 实际尝试秘密读取并观察自身前后解锁，控制器另行核验真实状态及值、ACL、属性未变；所有事实与正常退出都必须成立，缺失字段或任何错误均不能被当作策略拒绝已有覆盖。 */
        async readDenial(profile: string, version: string) {
            const reply = await command("read-denial", { profile, version });
            return [
                "readAttempted",
                "osDenied",
                "helperUnlockedBefore",
                "helperUnlockedAfter",
                "controllerUnlockedBefore",
                "controllerUnlockedAfter",
                "exitConfirmed",
                "classifiedFailed",
                "valueUnchanged",
                "aclUnchanged",
                "attributesUnchanged",
            ].every((field) => reply[field] === true);
        },
        /** 测试故障分别在系统新增和删除返回后使 helper 死亡，调用器先确认没有确定性成功回复且进程确实退出，再用同一档案版本只读核对；新增读回原材料而删除读回缺失，两种结果都不能由死亡本身推导或自动重放。 */
        async uncertainRecovery(profile: string, version: string, key: Buffer) {
            const result = await call("set", profile, version, key, "after-add");
            const uncertain = result.code !== 0 && result.bytes.length === 0;
            result.bytes.fill(0);
            const recovered = await call("get", profile, version);
            const expected = Buffer.from(`V1 ok ${key.toString("base64url")}\n`);
            let verified: boolean;
            try {
                verified = uncertain && recovered.code === 0 && recovered.bytes.equals(expected);
            } finally {
                expected.fill(0);
                recovered.bytes.fill(0);
            }
            if (!verified) return false;
            const deletion = await call("delete", profile, version, undefined, "after-delete");
            const deletionUncertain = deletion.code !== 0 && deletion.bytes.length === 0;
            deletion.bytes.fill(0);
            const missing = await call("get", profile, version);
            try {
                return (
                    deletionUncertain &&
                    missing.code === 0 &&
                    missing.bytes.equals(Buffer.from("V1 missing\n"))
                );
            } finally {
                missing.bytes.fill(0);
            }
        },
        /** 夹具清理要求控制器显式完成自有存储删除并关闭自身进程，错误路径也覆盖积累的私有响应并有界核对实际退出；若内核没有确认退出则抛出未知清理错误，而不是让 finally 结束被误解为系统状态已经恢复。 */
        cleanup,
    };
}
