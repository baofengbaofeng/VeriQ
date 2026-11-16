/** Darwin 的受控停止证明只压缩已核验日志与真实原对象退出事实，格式验证本身不能创造这些事实；历史读取必须另外使用 B
 * 私有文件边界，并同时读取本代已提交过程记录和对应证明，绝不能从状态名称或 PID 消失推断停止。
 */
import { createHash } from "node:crypto";
import {
    LIMITS,
    validateBinding,
    validateJournal,
    type ObserverBinding,
} from "./controlled-child-protocol.mjs";

/** 过程记录先持久化完整派生计划与双绑定，随后只增加本次原对象登记、取消授权和浏览器停止授权；尚未取得实际对象的意图仍然
 * 保持未知，明确计划无浏览器与丢失浏览器句柄不能混为同一种状态。
 */
export interface DarwinProcessRecord {
    version: 1;
    platform: "darwin";
    attemptId: string;
    uid: number;
    kind: "TEST" | "VALIDATE" | "CLEANUP";
    ownerGeneration: number;
    nonce: string;
    commandBinding: ObserverBinding;
    cliBinding: ObserverBinding;
    state: "SPAWNING" | "RUNNING" | "STOPPED";
    outerPlanned: true;
    browserPlanned: boolean;
    cancellationAuthorized: boolean;
    browserStopAuthorized: boolean;
    outerPid?: number;
    chromePid?: number;
}

/** 每份摘要只保留有限计数、完整字节数与摘要，最多一千零二十四个 CLI 直接对象继续留在原始私有日志；
 * 历史证明因此不会随对象数量膨胀，也不会携带端点、任意环境或业务报告内容。
 */
export interface ControlledJournalSummary {
    bytes: number;
    count: number;
    sha256: string;
}

/**
 * 真实退出事实由 Agent 对自己持有的同一个 ChildProcess 同步安装监听获得，诊断 PID 只用来与本次登记配对；observed
 * 是私有格式中的固定声明，不允许历史读取用它补建活句柄或向数字 PID 发送任何信
 * 号。
 */
export interface ControlledExitFact {
    pid: number;
    code: number | null;
    signal: NodeJS.Signals | null;
    observed: true;
}

/** 完整证明严格绑定本代过程身份、有限日志摘要及 outer 和可选 Chrome 的实际退出，scope 永远只是受控集合；本格式拒绝
 * DRAINED 与全部后代范围，也不在这里保存可用于控制浏览器的私密连接端点。
 */
export interface DarwinControlledProof {
    version: 1;
    platform: "darwin";
    attemptId: string;
    uid: number;
    kind: DarwinProcessRecord["kind"];
    ownerGeneration: number;
    nonce: string;
    commandBinding: ObserverBinding;
    cliBinding: ObserverBinding;
    state: "CONTROLLED_STOPPED";
    scope: "CONTROLLED_WORKER_BROWSER";
    outer: ControlledExitFact;
    chrome: ControlledExitFact | null;
    journals: { commands: ControlledJournalSummary; cli: ControlledJournalSummary };
}

const identityKeys = [
    "version",
    "platform",
    "attemptId",
    "uid",
    "kind",
    "ownerGeneration",
    "nonce",
    "commandBinding",
    "cliBinding",
];
const recordKeys = [
    ...identityKeys,
    "state",
    "outerPlanned",
    "browserPlanned",
    "cancellationAuthorized",
    "browserStopAuthorized",
];
const positive = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    object(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
function reject(): never {
    throw new Error("CONTROLLED_PROOF_INVALID");
}

/** 双绑定都交给唯一 C1 身份验证器复制，固定共同身份只允许两个不同的命令 slot；校验器拒绝额外字段与不安全代际，
 * 因此调用方不能把可克隆的配置声明变成本模块之外的宿主执行能力。
 */
function identity(value: Record<string, unknown>): void {
    const command = validateBinding(value.commandBinding),
        cli = validateBinding(value.cliBinding);
    if (
        value.version !== 1 ||
        value.platform !== "darwin" ||
        !Number.isSafeInteger(value.uid) ||
        Number(value.uid) < 0 ||
        !["TEST", "VALIDATE", "CLEANUP"].includes(String(value.kind)) ||
        command.commandSlot === cli.commandSlot
    )
        reject();
    for (const key of ["attemptId", "ownerGeneration", "nonce"] as const) {
        if (value[key] !== command[key] || value[key] !== cli[key]) reject();
    }
}

/** 过程记录解析只接受本实现产生的有限字段组合，未登记 PID 可以存在于 SPAWNING 意图但已登记值必须有效；
 * 停止状态的完整事实仍由下方配对核验，单独调用本函数不会赋予任何停止或释放容量的结论。
 */
export function parseDarwinProcessRecord(value: unknown): DarwinProcessRecord {
    if (!object(value)) reject();
    const optional = ["outerPid", "chromePid"].filter((key) => Object.hasOwn(value, key));
    if (!exact(value, [...recordKeys, ...optional])) reject();
    identity(value);
    if (
        !["SPAWNING", "RUNNING", "STOPPED"].includes(String(value.state)) ||
        value.outerPlanned !== true ||
        value.browserPlanned !== (value.kind === "TEST") ||
        typeof value.cancellationAuthorized !== "boolean" ||
        typeof value.browserStopAuthorized !== "boolean" ||
        (value.browserStopAuthorized && !value.browserPlanned) ||
        optional.some((key) => !positive(value[key])) ||
        (!value.browserPlanned && Object.hasOwn(value, "chromePid"))
    )
        reject();
    return structuredClone(value) as unknown as DarwinProcessRecord;
}

/**
 * processes 目录与 attempts 目录共享有限私有 JSON 读取器，但本用途只承认过程及平台证明后缀；
 * 其他合法活动过程仍可与选中证明并存，普通 JSON 和 staging 则不能借共享名称语法绕过未知成员的失败
 * 关闭边界。
 */
export function isControlledProcessMember(name: string): boolean {
    return /^[a-zA-Z0-9_-]{1,100}\.(?:process|controlled|drained)\.json$/.test(name);
}

/** 在线历史的 Claim 与私有过程记录必须同时绑定 Attempt、已有 fencingToken 和业务任务种类；验证与清理计划没有浏览器，
 * 因此即使自身受控证明完整，也绝不能替代 TEST Claim 所要求的不同受控集合。
 */
export function matchesControlledClaim(record: unknown, claim: unknown): boolean {
    try {
        const journal = parseDarwinProcessRecord(record);
        return (
            object(claim) &&
            journal.attemptId === claim.attemptId &&
            journal.ownerGeneration === claim.fencingToken &&
            journal.kind === claim.jobKind
        );
    } catch {
        return false;
    }
}

/** 摘要的字节和数量独立受原日志协议及固定角色边界限制，空 CLI 使用空字节的 SHA256 而不是缺少成员；任何额外 roster
 * 内容或超限都拒绝，避免历史解析器接受大小无界或语义含糊的私有证明。
 */
function summary(value: unknown, limit: number, empty: boolean): boolean {
    return (
        exact(value, ["bytes", "count", "sha256"]) &&
        Number.isSafeInteger(value.bytes) &&
        Number(value.bytes) >= (empty ? 0 : 1) &&
        Number(value.bytes) <= LIMITS.fileBytes &&
        Number.isSafeInteger(value.count) &&
        Number(value.count) >= 0 &&
        Number(value.count) <= limit &&
        typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.sha256) &&
        (Number(value.bytes) > 0 ||
            (value.count === 0 && value.sha256 === createHash("sha256").digest("hex")))
    );
}

/** 退出字段必须同时表达正常退出码或单一信号而没有双重含义，外层只接受业务零或一与已授权取消的一百三十；
 * 浏览器的主动关闭可以有真实信号，但只能与已持久化的本次浏览器停止授权共同配对。
 */
function exit(
    value: unknown,
    pid: number | undefined,
    outer: boolean,
    cancelled: boolean,
): boolean {
    if (
        !exact(value, ["pid", "code", "signal", "observed"]) ||
        !positive(pid) ||
        value.pid !== pid ||
        value.observed !== true
    )
        return false;
    if (outer)
        return (
            value.signal === null &&
            (value.code === 0 || value.code === 1 || (value.code === 130 && cancelled))
        );
    return (
        (Number.isSafeInteger(value.code) && Number(value.code) >= 0 && value.signal === null) ||
        (value.code === null &&
            typeof value.signal === "string" &&
            /^SIG[A-Z0-9]+$/.test(value.signal))
    );
}

/** 私有历史只承认两份正式成员精确匹配且过程已经提交 STOPPED 的组合，中途先发布的 proof 不能让 RUNNING 记录恢复为成功；
 * 此函数纯粹校验输入，不探测 PID、读取日志、修复权限或补写任何历史成员。
 */
export function validateControlledPair(
    record: unknown,
    proof: unknown,
    expected: { attemptId: string; uid: number },
): boolean {
    try {
        const journal = parseDarwinProcessRecord(record);
        if (
            journal.state !== "STOPPED" ||
            journal.attemptId !== expected.attemptId ||
            journal.uid !== expected.uid ||
            !exact(proof, [...identityKeys, "state", "scope", "outer", "chrome", "journals"])
        )
            return false;
        identity(proof);
        if (proof.state !== "CONTROLLED_STOPPED" || proof.scope !== "CONTROLLED_WORKER_BROWSER")
            return false;
        for (const key of identityKeys) {
            if (key === "commandBinding" || key === "cliBinding") {
                if (
                    JSON.stringify(validateBinding(proof[key])) !==
                    JSON.stringify(validateBinding(journal[key]))
                )
                    return false;
            } else if (proof[key] !== journal[key as keyof DarwinProcessRecord]) return false;
        }
        if (
            !exit(proof.outer, journal.outerPid, true, journal.cancellationAuthorized) ||
            (journal.browserPlanned
                ? !journal.browserStopAuthorized ||
                  !exit(proof.chrome, journal.chromePid, false, false)
                : proof.chrome !== null) ||
            !exact(proof.journals, ["commands", "cli"]) ||
            !summary(proof.journals.commands, journal.kind === "TEST" ? 3 : 2, false) ||
            !summary(proof.journals.cli, LIMITS.objects, true)
        )
            return false;
        const commands = proof.journals.commands as unknown as ControlledJournalSummary,
            cli = proof.journals.cli as unknown as ControlledJournalSummary;
        if (commands.count === 0 && !journal.cancellationAuthorized) return false;
        return commands.count === 3 ? cli.bytes > 0 : cli.count === 0 && cli.bytes === 0;
    } catch {
        return false;
    }
}

/** 两份已经稳定读取的原始字节始终使用唯一 C1 验证核，固定角色顺序由连续 slot 与前缀退出条件补充；只有到达第三个 CLI
 * 命令才要求 CLI 封存，前两个命令的已授权 SIGINT 不会被误当成正常业务成功。
 */
export function verifyControlledJournals(
    record: unknown,
    commandBytes: Buffer,
    cliBytes: Buffer,
): DarwinControlledProof["journals"] {
    const journal = parseDarwinProcessRecord(record);
    const commands = validateJournal(commandBytes, journal.commandBinding).objects;
    if (commands.length > (journal.kind === "TEST" ? 3 : 2)) reject();
    for (const [index, member] of commands.entries()) {
        if (
            index > 0 &&
            (commands[index - 1]!.exitCode !== 0 || commands[index - 1]!.signal !== null)
        )
            reject();
        if (index === 2) {
            if (
                member.signal !== null ||
                ![0, 1, ...(journal.cancellationAuthorized ? [130] : [])].includes(member.exitCode!)
            )
                reject();
        } else if (
            !(
                (member.signal === null && [0, 1].includes(member.exitCode!)) ||
                (journal.cancellationAuthorized &&
                    member.exitCode === null &&
                    member.signal === "SIGINT")
            )
        )
            reject();
    }
    if (!commands.length && !journal.cancellationAuthorized) reject();
    const cli = commands.length === 3 ? validateJournal(cliBytes, journal.cliBinding).objects : [];
    if (commands.length !== 3 && cliBytes.length !== 0) reject();
    const digest = (bytes: Buffer, count: number): ControlledJournalSummary => ({
        bytes: bytes.length,
        count,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    return { commands: digest(commandBytes, commands.length), cli: digest(cliBytes, cli.length) };
}
