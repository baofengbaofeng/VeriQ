import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { canonicalBytes } from "@veriq/contracts";
import {
    RuntimePayloadError,
    admitRuntimePayloadInputs,
    verifyRuntimePayloadInputs,
    type ExpectedPayloadInputs,
    type Ref,
    type Cleanup,
    type InputInspection,
} from "./runtime-payload-inputs.ts";
import { freeze, limits, relative } from "./runtime-payload-tree.ts";
import { ArchiveTransaction, controlledIoFailure } from "./runtime-payload-transaction.ts";
import { scanTar } from "./runtime-payload-tar.ts";
import { scanZip } from "./runtime-payload-zip.ts";

/** 拒绝事实只描述当前成熟解析器已读到的有限字段，不提供额外解析器或可配置准入能力；类型限定原有十二个拒绝点，普通正文和任意异常消息不属于这个内部观察合同。 */
export type ArchiveRejectionFacts = Readonly<{
    archive: "node" | "chrome";
    stage: "TAR_FRAME" | "TAR_METADATA" | "TAR_ENTRY" | "ZIP_ENTRY";
    reason:
        | "TAR_META_EMPTY"
        | "TAR_ENTRY_TYPE"
        | "TAR_HEADER_MODE"
        | "TAR_PAX_TEXT"
        | "TAR_PAX_RECORD"
        | "TAR_PAX_VALUE"
        | "TAR_PAX_ROUNDTRIP"
        | "TAR_GNU_TEXT"
        | "ZIP_METHOD_FLAGS"
        | "ZIP_HOST_TYPE"
        | "ZIP_DIRECTORY_MODE"
        | "ENTRY_MODE_SIZE";
    headerIndex?: number | null;
    memberIndex?: number | null;
    path?: string | Buffer | undefined;
    size?: number;
    rawMode?: number | undefined;
    effectiveMode?: number;
    type?: string | number | undefined;
    effectiveType?: string;
    header?: Buffer;
    metadata?: Buffer | undefined;
    details?: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined;
}>;

/** 私有弱表只保存已经序列化的自有字符串，冻结异常无需新增字段也不会持有调用方可变缓冲；首个错误身份与首个已捕获事件保持一一对应，另一次扫描不能污染本次归一化结果。 */
const rejectionLines = new WeakMap<RuntimePayloadError, string>();
const rejectionLineLimit = 96 * 1024;
const rejectionContexts = new WeakMap<ArchiveScan, Omit<ArchiveRejectionFacts, "reason">>();

/** 每个扫描对象的原头上下文只在这个私有弱表存活，适配器交付当前成员前写入已观察字段；它不成为构造参数或公开结果，跨扫描没有共享当前条目，捕获失败也不能打断正常解析。 */
export function setArchiveRejectionContext(
    scan: ArchiveScan,
    context: Omit<ArchiveRejectionFacts, "reason">,
): void {
    try {
        rejectionContexts.set(scan, context);
    } catch {
        rejectionContexts.delete(scan);
    }
}

/** 数字观察区分不存在、非有限值与超出安全整数的有限值，不让 JSON 把 NaN 或 Infinity 静默编码成普通空值；原数字在安全时保留原值，分类仅供定位拒绝原因而不参与准入。 */
function observedNumber(value: number | undefined) {
    return {
        value: value !== undefined && Number.isFinite(value) ? value : null,
        kind:
            value === undefined
                ? "UNDEFINED"
                : Number.isNaN(value)
                  ? "NAN"
                  : value === Infinity
                    ? "POSITIVE_INFINITY"
                    : value === -Infinity
                      ? "NEGATIVE_INFINITY"
                      : Number.isSafeInteger(value)
                        ? "SAFE_INTEGER"
                        : "FINITE_NON_SAFE_INTEGER",
    };
}

/** 捕获入口在复制与散列之前核每个输入的硬界限，再把完整 JSON 连同换行按真实 UTF8 字节计费；捕获失败只丢弃诊断，始终保留调用方原异常，禁止把截断样本冒充完整成员元数据。 */
export function attachArchiveRejection(error: unknown, facts: ArchiveRejectionFacts): void {
    try {
        if (
            !(error instanceof RuntimePayloadError) ||
            error.code !== "PAYLOAD_ARCHIVE_UNSUPPORTED" ||
            rejectionLines.has(error)
        )
            return;
        const sample = (bytes: Buffer | undefined, limit: number) => {
            if (bytes === undefined) return null;
            if (bytes.length > limit) throw new Error("DIAGNOSTIC_LIMIT");
            const copy = Buffer.from(bytes);
            return {
                sizeBytes: copy.length,
                sha256: createHash("sha256").update(copy).digest("hex"),
                base64: copy.toString("base64"),
            };
        };
        let path = null;
        if (facts.path !== undefined) {
            if (
                facts.path.length > 65536 ||
                (typeof facts.path === "string" && Buffer.byteLength(facts.path) > 65536)
            )
                return;
            const bytes = Buffer.from(facts.path);
            if (bytes.length > 65536) return;
            path = {
                sha256: createHash("sha256").update(bytes).digest("hex"),
                sizeBytes: bytes.length,
                encoding: typeof facts.path === "string" ? "UTF8" : "ZIP_RAW_BYTES",
            };
        }
        const details: Record<string, string | number | boolean | null> = {};
        const entries = Object.entries(facts.details ?? {});
        if (entries.length > 32) return;
        for (const [key, value] of entries) {
            if (
                !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key) ||
                (typeof value === "string" && value.length > 128)
            )
                return;
            details[key] =
                value === undefined || (typeof value === "number" && !Number.isFinite(value))
                    ? null
                    : value;
        }
        if (
            (typeof facts.type === "string" && facts.type.length > 128) ||
            (facts.effectiveType !== undefined && facts.effectiveType.length > 128)
        )
            return;
        const line =
            JSON.stringify({
                kind: "ASSET_ARCHIVE_REJECTION",
                schemaVersion: 1,
                archive: facts.archive,
                stage: facts.stage,
                reason: facts.reason,
                headerIndex: facts.headerIndex ?? null,
                memberIndex: facts.memberIndex ?? null,
                path,
                declaredSize: observedNumber(facts.size),
                rawMode: observedNumber(facts.rawMode),
                effectiveMode: observedNumber(facts.effectiveMode),
                type: facts.type ?? null,
                effectiveType: facts.effectiveType ?? null,
                header: sample(facts.header, 512),
                metadata: sample(facts.metadata, 65536),
                details,
            }) + "\n";
        if (Buffer.byteLength(line) <= rejectionLineLimit) rejectionLines.set(error, line);
    } catch {
        // 捕获本身没有文件或流所有权，散列、分配或序列化失败时仅放弃这份可选事实；调用点仍抛出已经选定的原异常，不借诊断失败改变其分类、阶段、清理状态或首错顺序。
    }
}

/** 归档拒绝诊断读取只按真实异常身份寻找私有事实，不改变已冻结异常的字段与公开分类；没有实际捕获时返回空值，调用方不得把缺失记录推断成扫描成功或已观察任何成员。 */
export function archiveRejectionLine(error: unknown): string | null {
    return error instanceof RuntimePayloadError ? (rejectionLines.get(error) ?? null) : null;
}

/** 事务清理完成后的异常归一化只迁移被选中首错的私有字符串，不覆盖目标已有事件或复制其它异常事实；返回对象仍是调用方刚构造的正式错误，公开字段与原构造参数完全一致。 */
export function transferArchiveRejection(
    source: unknown,
    target: RuntimePayloadError,
): RuntimePayloadError {
    try {
        const line = archiveRejectionLine(source);
        if (line && target.code === "PAYLOAD_ARCHIVE_UNSUPPORTED" && !rejectionLines.has(target))
            rejectionLines.set(target, line);
    } catch {
        // 迁移是异常报告的附属操作且不持有任何资源，弱表读取或写入失败时保留目标异常原样；不得用迁移异常覆盖实际扫描首错，也不得从其它扫描借用一个貌似完整的事件。
    }
    return target;
}

/** CLI 在真实清理返回后调用这个有限输出入口，先设置原退出码再写原公共分类和最多一条私有诊断；输出管道失败不改变业务首错，异步错误监听只属于 CLI 报告阶段而不进入扫描生命周期。 */
export function emitArchiveFailure(error: RuntimePayloadError, exitCode: number): void {
    process.exitCode = exitCode;
    try {
        process.stderr.on("error", () => {});
        process.stderr.write(`${error.code} phase=${error.phase} cleanup=${error.cleanup}\n`);
        const line = archiveRejectionLine(error);
        if (line) process.stderr.write(line);
    } catch {
        // 诊断输出只是已完成失败的报告尝试，关闭的管道或同步写入异常不会重启扫描也不应升级成不同业务错误；原退出码已经设置，标准输出仍为空且不会伪造任何成功结果。
    }
}

/** 归档条目保留真实原路径、权限与文件摘要或原始链接目标，推导父目录不会伪造成原归档成员；所有嵌套字段均为只读事实，逻辑链接不会因此获得物理创建或执行能力，后续组装必须重新核原始来源。 */
export type ArchiveMember =
    | Readonly<{ path: string; kind: "file"; sizeBytes: number; sha256: string; mode: number }>
    | Readonly<{ path: string; kind: "directory"; mode: number }>
    | Readonly<{ path: string; kind: "link"; target: string; mode: number }>;
/** intake 回执明确区分 gzip 完整流 CRC 与 ZIP 各成员 CRC，只声明公开 API 能证明的 local header 和 data 范围；展开字节含逻辑目标，streamBytes 在 tar 表示真实解压流而 ZIP 表示完整原快照长度。 */
export type IntakeReceipt = Readonly<{
    schemaVersion: 1;
    kind: "RUNTIME_ARCHIVE_INTAKE";
    recipeSha256: string;
    archives: readonly Readonly<{
        kind: "node" | "chrome";
        snapshot: Ref;
        members: readonly ArchiveMember[];
        expandedBytes: number;
        streamBytes: number;
        checks: Readonly<{
            crc: "ZIP_EACH_ENTRY" | "GZIP_STREAM";
            zipLocalDataRanges: "CHECKED" | "NOT_APPLICABLE";
        }>;
    }>[];
}>;
/** 成功结果只说明归档普通文件树已经提交并复核，不是 Runtime 候选或执行许可；锁和事务元数据收尾未完成时仍诚实保留 committed，同时 cleanup 明确为 INCOMPLETE，不能删除最终目录假装回滚。 */
export type IntakeResult = Readonly<{
    directory: string;
    receiptSha256: string;
    receipt: IntakeReceipt;
    committed: true;
    cleanup: Cleanup;
}>;
/** 阶段选项只接收显式真实输入根、受控输出父目录与单个可移植候选名，不能通过选项放宽任何资源预算；取消信号只固定引用，库入口不注册全局进程事件，也不接收调用者文件系统或提取回调。 */
export type StageOptions = Readonly<{
    inputRoot: string;
    outputParent: string;
    candidateName: string;
    signal?: AbortSignal;
}>;

/** 固定共享预算同时累计五棵已核树与两份归档的有效物理路径、链接和内容，缺省父目录只计一次；声明级准入用于在读取巨大正文前拒绝不可能计划，实际逐块长度还必须与同一声明精确相等，不能由调用者覆写上限。 */
export class ArchiveBudget {
    private entries = 0;
    private links = 0;
    private bytes = 0;
    private receiptBytes = 0;
    /** 预算种子来自本次真实 verify 报告，不接受旧报告当作 intake 能力；树的 fileBytes 仍只代表普通文件，逻辑链接目标 UTF8 字节在此单独加入，避免遗漏或重复收费改变字段原本含义。 */
    constructor(report?: InputInspection) {
        if (report)
            for (const tree of Object.values(report.trees))
                this.add(
                    tree.fileCount + tree.directoryCount + tree.linkCount,
                    tree.linkCount,
                    tree.fileBytes +
                        tree.inventory.links.reduce((n, l) => n + Buffer.byteLength(l.target), 0),
                );
    }
    /** 每一次有效路径和实际声明正文进入同一个累计计数器，两份归档之间不会重置额度；整型和负值也拒绝，测试可以只用小声明验证跨边界关系而不分配数 GiB 文件或公开生产预算旋钮。 */
    add(entries: number, links: number, bytes: number) {
        if (
            ![entries, links, bytes].every((n) => Number.isSafeInteger(n) && n >= 0) ||
            this.entries + entries > limits.entries ||
            this.links + links > limits.links ||
            this.bytes + bytes > limits.total
        )
            throw new RuntimePayloadError("PAYLOAD_LIMIT");
        this.entries += entries;
        this.links += links;
        this.bytes += bytes;
    }
    /** 回执成员按实际序列化字节消费独立四 MiB 上限，正文尚未提取即可拒绝过长事实集合；这里只计成员部分，最终完整规范回执仍另核总长度，临时序列化永远只包含单个受路径和目标上限约束的小条目。 */
    member(value: ArchiveMember) {
        this.receiptBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
        if (this.receiptBytes > limits.json) throw new RuntimePayloadError("PAYLOAD_LIMIT");
    }
}

/** 内部扫描条目只包含成熟解析器已经解释的有效路径和真实类型，尚未读取正文时不声称有内容摘要；两个成熟归档适配器使用同一 collector 消费有界流，调用者无法注入自定义提取函数或选择任意输出路径。 */
export type ScanEntry = Readonly<{
    path: string;
    kind: "file" | "directory" | "link";
    mode: number;
    size: number;
    target?: string;
}>;
/** 单份扫描表合并实际成员与推导父目录，先完整扫描再从同一快照对照提取；成员顺序、原模式、类型、长度、摘要及原始目标均必须逐项相同，第二遍不会通过重新扫描外部来源偷偷替换第一遍的事实。 */
export class ArchiveScan {
    readonly members: ArchiveMember[] = [];
    readonly effective = new Map<string, { kind: ArchiveMember["kind"]; explicit: boolean }>();
    expandedBytes = 0;
    private cursor = 0;
    private rejectionIndex = 0;
    private readonly cases = new Map<string, string>();
    /** 扫描与提取共用固定顶层目录和当前事务，只在第二遍获得已扫描成员列表；第一遍不写普通正文，第二遍不会重新收费共享逻辑预算，但仍按实际流长度与原摘要比较以发现损坏或替换。 */
    constructor(
        readonly kind: "node" | "chrome",
        readonly top: string,
        readonly tx: ArchiveTransaction,
        private readonly budget: ArchiveBudget,
        private readonly previous?: ArchiveScan,
    ) {}
    /** 每个路径先核原始可移植拼写，再按全部父组件登记大小写和类型身份；允许一次显式目录补上先前推导父目录，重复显式条目、链接下真实孩子和目录文件冲突都在任何正文写入前拒绝。 */
    private register(path: string, kind: ArchiveMember["kind"], explicit: boolean) {
        relative(path);
        if (path !== this.top && !path.startsWith(this.top + "/")) this.tx.fail("PAYLOAD_PATH");
        let prefix = "";
        const components = path.split("/");
        for (let index = 0; index < components.length; index++) {
            prefix = prefix ? `${prefix}/${components[index]}` : components[index]!;
            const leaf = index === components.length - 1,
                requested = leaf ? kind : "directory";
            const prior = this.cases.get(prefix.toLowerCase());
            if (prior !== undefined && prior !== prefix) this.tx.fail("PAYLOAD_COLLISION");
            this.cases.set(prefix.toLowerCase(), prefix);
            const old = this.effective.get(prefix);
            if (old) {
                if (old.kind !== requested || (leaf && explicit && old.explicit))
                    this.tx.fail("PAYLOAD_COLLISION");
                if (leaf && explicit) old.explicit = true;
            } else {
                this.effective.set(prefix, { kind: requested, explicit: leaf && explicit });
                this.budget.add(1, requested === "link" ? 1 : 0, 0);
            }
        }
    }
    /** 正文消费执行单文件两 GiB、目录零字节与链接一千零二十四 ASCII 字节的固定限制；第一遍仅存小链接正文和摘要，第二遍直接背压写入私有普通文件，任何流超声明、权限特殊位或摘要差异都会终止整个事务。 */
    async entry(entry: ScanEntry, chunks: AsyncIterable<Uint8Array>) {
        this.tx.check();
        this.rejectionIndex++;
        if (
            !Number.isSafeInteger(entry.mode) ||
            entry.mode < 0 ||
            entry.mode > 0o777 ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            entry.size > limits.file
        ) {
            try {
                this.tx.fail(
                    entry.size > limits.file ? "PAYLOAD_LIMIT" : "PAYLOAD_ARCHIVE_UNSUPPORTED",
                );
            } catch (error) {
                const context = rejectionContexts.get(this);
                attachArchiveRejection(error, {
                    ...context,
                    archive: this.kind,
                    stage: this.kind === "node" ? "TAR_ENTRY" : "ZIP_ENTRY",
                    reason: "ENTRY_MODE_SIZE",
                    memberIndex: this.rejectionIndex,
                    path: entry.path,
                    size: entry.size,
                    effectiveMode: entry.mode,
                    type: context?.type,
                    effectiveType: entry.kind,
                    details: {
                        ...context?.details,
                        modeNotInteger: !Number.isSafeInteger(entry.mode),
                        modeNegative: entry.mode < 0,
                        modeHigh: entry.mode > 0o777,
                        sizeNotInteger: !Number.isSafeInteger(entry.size),
                        sizeNegative: entry.size < 0,
                    },
                });
                throw error;
            }
        }
        const path =
            entry.kind === "directory" && entry.path.endsWith("/")
                ? entry.path.slice(0, -1)
                : entry.path;
        if (entry.kind === "directory" && entry.size !== 0) this.tx.fail("PAYLOAD_ARCHIVE_FORMAT");
        if (entry.kind === "link" && entry.size > 1024) this.tx.fail("PAYLOAD_LIMIT");
        if (!this.previous) {
            this.register(path, entry.kind, true);
            if (entry.kind === "file") this.budget.add(0, 0, entry.size);
        }
        const expected = this.previous?.members[this.cursor++];
        if (
            this.previous &&
            (!expected ||
                expected.path !== path ||
                expected.kind !== entry.kind ||
                expected.mode !== entry.mode ||
                (expected.kind === "file" && expected.sizeBytes !== entry.size))
        )
            this.tx.fail("PAYLOAD_SOURCE_CHANGED");
        const digest = createHash("sha256"),
            small: Buffer[] = [];
        let size = 0;
        const consume = async function* (scan: ArchiveScan) {
            for await (const value of chunks) {
                scan.tx.check();
                const chunk = Buffer.from(value);
                size += chunk.length;
                if (size > entry.size || (entry.kind === "link" && size > 1024))
                    scan.tx.fail("PAYLOAD_LIMIT");
                digest.update(chunk);
                if (entry.kind === "link") small.push(chunk);
                yield chunk;
            }
            if (size !== entry.size) scan.tx.fail("PAYLOAD_ARCHIVE_FORMAT");
        };
        if (this.previous && entry.kind === "file" && expected?.kind === "file")
            await this.tx.write(`trees/${this.kind}/${path}`, consume(this), expected);
        else
            for await (const _chunk of consume(this)) {
                /* 扫描阶段只消费并摘要当前块，正文不在内存或临时文件中累计，只有受限链接目标会保留到逻辑核验阶段以便精确比较原始目标，避免把巨大普通文件无意缓存而绕过流式内存边界。 */
            }
        let member: ArchiveMember;
        if (entry.kind === "file")
            member = {
                path,
                kind: "file",
                sizeBytes: size,
                sha256: digest.digest("hex"),
                mode: entry.mode,
            };
        else if (entry.kind === "directory") member = { path, kind: "directory", mode: entry.mode };
        else {
            const target = entry.target ?? Buffer.concat(small).toString("utf8");
            relative(target, true);
            if (Buffer.byteLength(target) > 1024 || /[^\x20-\x7e]/.test(target))
                this.tx.fail("PAYLOAD_PATH");
            member = { path, kind: "link", target, mode: entry.mode };
            if (!this.previous) this.budget.add(0, 0, Buffer.byteLength(target));
        }
        if (expected && JSON.stringify(member) !== JSON.stringify(expected))
            this.tx.fail("PAYLOAD_SOURCE_CHANGED");
        if (!this.previous) this.budget.member(member);
        this.members.push(member);
        this.expandedBytes +=
            member.kind === "file"
                ? member.sizeBytes
                : member.kind === "link"
                  ? Buffer.byteLength(member.target)
                  : 0;
        this.tx.check();
    }
    /** 完整流结束后确认第二遍条目没有遗漏，再建立推导目录供零正文目录和逻辑解析使用；显式成员列表仍只包含实际归档条目，不能凭落地需要发明原目录模式或把没有扫描过的成员写进回执。 */
    async finish() {
        if (!this.members.length || (this.previous && this.cursor !== this.previous.members.length))
            this.tx.fail("PAYLOAD_ARCHIVE_FORMAT");
        if (this.previous)
            for (const [path, value] of this.previous.effective)
                if (value.kind === "directory") await this.tx.mkdir(`trees/${this.kind}/${path}`);
    }
    /** 链接先逐字符组件在明确根内解析，每次跟随别名都消费固定跳数且必须终止于存在成员；物理目录边与目录别名边组成有界图后再做迭代环检，合法重复别名共享终点而不展开可能无限的虚拟目录树。 */
    links(
        allowed: readonly Readonly<{ path: string; target: string }>[],
        frameworkRoots: readonly string[] = [],
    ) {
        const links = this.members.filter(
            (m): m is Extract<ArchiveMember, { kind: "link" }> => m.kind === "link",
        );
        const declarations = new Map(
            allowed.map((l) => [
                this.kind === "chrome" ? l.path.slice("browser/".length) : l.path,
                l.target,
            ]),
        );
        if (
            declarations.size !== links.length ||
            links.some((l) => declarations.get(l.path) !== l.target)
        )
            this.tx.fail("PAYLOAD_ARCHIVE_LINK");
        const aliases = new Map(links.map((l) => [l.path, l.target])),
            graph = new Map<string, string[]>();
        for (const [path, value] of this.effective)
            if (value.kind === "directory") graph.set(path, []);
        for (const path of graph.keys()) graph.get(dirname(path))?.push(path);
        for (const link of links) {
            const root =
                this.kind === "node"
                    ? this.top
                    : frameworkRoots
                          .find((r) => link.path.startsWith(r.slice("browser/".length) + "/"))
                          ?.slice("browser/".length);
            if (!root || !graph.has(root) || root.split("/").at(-1) === ".framework")
                this.tx.fail("PAYLOAD_ARCHIVE_LINK");
            let stack = link.path.split("/").slice(0, -1),
                pending = link.target.split("/"),
                hops = 0;
            const floor = root.split("/").length;
            while (pending.length) {
                const component = pending.shift()!;
                if (component === ".") continue;
                if (component === "..") {
                    if (stack.length <= floor) this.tx.fail("PAYLOAD_ARCHIVE_LINK");
                    stack.pop();
                    continue;
                }
                stack.push(component);
                const path = stack.join("/"),
                    item = this.effective.get(path);
                if (!item) this.tx.fail("PAYLOAD_ARCHIVE_LINK");
                const target = aliases.get(path);
                if (target !== undefined) {
                    if (++hops > 32) this.tx.fail("PAYLOAD_ARCHIVE_LINK");
                    stack.pop();
                    pending = [...target.split("/"), ...pending];
                } else if (pending.length && item.kind !== "directory")
                    this.tx.fail("PAYLOAD_ARCHIVE_LINK");
            }
            const terminal = stack.join("/");
            if (
                (terminal !== root && !terminal.startsWith(root + "/")) ||
                !this.effective.has(terminal)
            )
                this.tx.fail("PAYLOAD_ARCHIVE_LINK");
            if (graph.has(terminal)) graph.get(dirname(link.path))!.push(terminal);
        }
        const marks = new Map<string, number>();
        for (const node of graph.keys()) {
            if (marks.has(node)) continue;
            const work: { path: string; index: number }[] = [{ path: node, index: 0 }];
            marks.set(node, 1);
            while (work.length) {
                const head = work.at(-1)!,
                    edges = graph.get(head.path)!;
                if (head.index === edges.length) {
                    marks.set(head.path, 2);
                    work.pop();
                    continue;
                }
                const next = edges[head.index++]!;
                if (marks.get(next) === 1) this.tx.fail("PAYLOAD_ARCHIVE_LINK");
                if (!marks.has(next)) {
                    marks.set(next, 1);
                    work.push({ path: next, index: 0 });
                }
            }
        }
    }
}

/** 唯一 intake 入口同步取得私有配方字节、独立政策与选项标量后再开始真实验证，完整扫描两份独立快照后才执行第二遍私有普通提取；没有安装、执行输入、签名或 Runtime 角色晋升，成功仅交可重新验证的归档封存事实。 */
export async function intakeRuntimeArchives(
    bytes: Uint8Array,
    expected: ExpectedPayloadInputs,
    options: StageOptions,
): Promise<IntakeResult> {
    const admitted = admitRuntimePayloadInputs(bytes, expected);
    const inputRoot = options?.inputRoot,
        outputParent = options?.outputParent,
        candidateName = options?.candidateName,
        signal = options?.signal;
    if (
        typeof inputRoot !== "string" ||
        typeof outputParent !== "string" ||
        typeof candidateName !== "string" ||
        (signal !== undefined && !(signal instanceof AbortSignal))
    )
        throw new RuntimePayloadError("PAYLOAD_INPUT_INVALID");
    const tx = new ArchiveTransaction(inputRoot, outputParent, candidateName, signal);
    let verified = false;
    try {
        const report = await verifyRuntimePayloadInputs(admitted.bytes, admitted.expected, {
            inputRoot,
            ...(signal ? { signal } : {}),
        });
        verified = true;
        tx.check();
        await tx.initialize();
        await tx.observeSources(report);
        const budget = new ArchiveBudget(report);
        await tx.plan(report.recipe.node.file.sizeBytes + report.recipe.chrome.file.sizeBytes, 2);
        await tx.snapshot(report.recipe.node.file, "snapshots/node.tar.gz");
        await tx.snapshot(report.recipe.chrome.file, "snapshots/chrome.zip");
        const scans = [
            new ArchiveScan("node", report.recipe.node.topDirectory, tx, budget),
            new ArchiveScan("chrome", report.recipe.chrome.topDirectory, tx, budget),
        ] as const;
        const nodeStreamBytes = await scanTar(join(tx.scratch, "snapshots/node.tar.gz"), scans[0]);
        await scanZip(
            join(tx.scratch, "snapshots/chrome.zip"),
            scans[1],
            report.recipe.chrome.file.sizeBytes,
        );
        scans[0].links(report.nodeReceipt.inputLinks);
        /** 每个声明 Framework 根都先核独立布局的明确前缀和非空名称，准入不能依赖该根是否恰好含有链接；逐跳物理根与目录图检查仍由原链接流程执行，空链接集合不会再绕过本片新增的命名政策。 */
        const frameworkPrefix = `${report.chromeLayout.layout.bundlePath}/Contents/Frameworks/`;
        for (const root of report.chromeLayout.layout.frameworkRoots) {
            const name = root.slice(frameworkPrefix.length);
            if (
                !root.startsWith(frameworkPrefix) ||
                name.includes("/") ||
                !/^.+\.framework$/.test(name)
            )
                tx.fail("PAYLOAD_ARCHIVE_LINK");
        }
        scans[1].links(
            report.chromeLayout.layout.allowedLinks,
            report.chromeLayout.layout.frameworkRoots,
        );
        if (
            scans[0].effective.get(report.nodeReceipt.nodeMember)?.kind !== "file" ||
            scans[0].effective.get(report.nodeReceipt.npmRoot)?.kind !== "directory" ||
            scans[1].effective.get(
                report.chromeLayout.layout.executablePath.slice("browser/".length),
            )?.kind !== "file"
        )
            tx.fail("PAYLOAD_ARCHIVE_LINK");
        const entries = scans.reduce((n, scan) => n + scan.effective.size, 0);
        await tx.plan(
            scans.reduce(
                (n, scan) =>
                    n +
                    scan.members.reduce((sum, m) => sum + (m.kind === "file" ? m.sizeBytes : 0), 0),
                0,
            ),
            entries,
        );
        await scanTar(
            join(tx.scratch, "snapshots/node.tar.gz"),
            new ArchiveScan("node", scans[0].top, tx, budget, scans[0]),
        );
        await scanZip(
            join(tx.scratch, "snapshots/chrome.zip"),
            new ArchiveScan("chrome", scans[1].top, tx, budget, scans[1]),
            report.recipe.chrome.file.sizeBytes,
        );
        await tx.finishSources();
        await verifyRuntimePayloadInputs(admitted.bytes, admitted.expected, {
            inputRoot,
            ...(signal ? { signal } : {}),
        });
        tx.check();
        await tx.finishSources();
        await tx.audit();
        const receipt: IntakeReceipt = freeze({
            schemaVersion: 1,
            kind: "RUNTIME_ARCHIVE_INTAKE",
            recipeSha256: admitted.recipeSha256,
            archives: scans.map((scan) => ({
                kind: scan.kind,
                snapshot: {
                    ...report.recipe[scan.kind].file,
                    path: scan.kind === "node" ? "snapshots/node.tar.gz" : "snapshots/chrome.zip",
                },
                members: scan.members,
                expandedBytes: scan.expandedBytes,
                streamBytes:
                    scan.kind === "node" ? nodeStreamBytes : report.recipe.chrome.file.sizeBytes,
                checks: {
                    crc: scan.kind === "node" ? "GZIP_STREAM" : "ZIP_EACH_ENTRY",
                    zipLocalDataRanges: scan.kind === "node" ? "NOT_APPLICABLE" : "CHECKED",
                },
            })),
        });
        const content = canonicalBytes(receipt);
        if (content.length > limits.json) tx.fail("PAYLOAD_LIMIT");
        const fact = await tx.write("archive-intake.json", once(content));
        const cleanup = await tx.publish();
        return freeze({
            directory: tx.directory,
            receiptSha256: fact.sha256,
            receipt,
            committed: true,
            cleanup,
        });
    } catch (error) {
        const cleanup = await tx.cleanup();
        if (!verified && error instanceof RuntimePayloadError) throw error;
        if (error instanceof RuntimePayloadError)
            throw new RuntimePayloadError(
                error.code,
                error.causeCode,
                cleanup === "NOT_NEEDED" ? error.cleanup : cleanup,
                {
                    phase:
                        error.phase === "INPUTS" && error.candidateDirectory === null
                            ? tx.phase
                            : error.phase,
                    candidateDirectory: tx.directory,
                },
            );
        const known = controlledIoFailure(error);
        return tx.fail(
            signal?.aborted ? "PAYLOAD_CANCELLED" : (known?.code ?? "PAYLOAD_IO"),
            cleanup,
            known?.causeCode ?? null,
        );
    }
}
/** 小型规范回执使用同一个流写入和 fsync 路径，而非额外宽松文件写入捷径；单块来源已受四 MiB 限制，不用于归档正文缓存，所有普通文件仍由事务独占权限和最终复核共同约束。 */
async function* once(bytes: Uint8Array) {
    yield bytes;
}
