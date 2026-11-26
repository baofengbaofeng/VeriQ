import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readdir,
    readlink,
    rename,
    rm,
    statfs,
    symlink,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve, posix } from "node:path";
import {
    RuntimePayloadError,
    type Cleanup,
    type InputInspection,
    type PayloadErrorCode,
    type Phase,
    type Ref,
    type NodeReceipt,
    type Bin,
    type LinkFact,
} from "./runtime-payload-inputs.ts";
import { InputReader, limits, relative, sha } from "./runtime-payload-tree.ts";
import type { ArchiveMember } from "./runtime-payload-archive.ts";
import {
    verifyMacRuntimeManifestV2,
    type MacChromeLayout,
    type MacRuntimeArch,
    type MacRuntimeStaticInventory,
} from "../src/distribution-manifest-v2.ts";

/**
 * 私有事务把磁盘、来源身份和当前候选生命周期集中在一个拥有者中，扫描器不能自行选择输出根或删除路径；输入仍按固定配方重
 * 新读取，随机名字与标记只用于清理归属而不授予后续执行能力。
 */
export class ArchiveTransaction {
    readonly nonce = randomUUID();
    readonly directory: string;
    readonly lockPath: string;
    readonly scratch: string;
    phase: Phase = "INTAKE";
    committed = false;
    private lock: FileHandle | undefined;
    private parentIdentity: BigIntStats | undefined;
    private rootIdentity: BigIntStats | undefined;
    private lockIdentity: BigIntStats | undefined;
    private readonly observations = new Map<string, BigIntStats>();
    private readonly ancestors = new Map<string, BigIntStats>();
    private readonly directories = new Set<string>();
    private readonly outputs = new Map<string, Ref>();
    private readonly directoryModes = new Map<string, number>();
    private readonly outputModes = new Map<string, number>();
    private readonly links = new Map<string, string>();
    private runtimePolicy: { arch: MacRuntimeArch; layout: MacChromeLayout; manifestSha256: string } | undefined;
    private finalInventory: MacRuntimeStaticInventory | undefined;
    private remaining = 0;
    private sinceCheck = 0;
    private writers = 0;
    private closureUnconfirmed = false;
    private scratchCreated = false;
    /**
     * 路径和信号已由入口在首次等待之前固定，这里只派生本次随机目录与独占锁名；构造函数不进行任何异步写入，因此准入失败
     * 不会留下缺少身份记录的候选或可被误接管的事务元数据。
     */
    constructor(
        readonly inputRoot: string,
        readonly outputParent: string,
        readonly candidateName: string,
        readonly signal?: AbortSignal,
        readonly profile: "intake" | "work" | "runtime" = "intake",
    ) {
        this.directory = join(outputParent, candidateName);
        this.lockPath = join(outputParent, `.veriq-${candidateName}.lock`);
        this.scratch = join(outputParent, `.veriq-${candidateName}-${this.nonce}`);
    }
    /**
     * 每个真实等待与数据块周围都调用相同取消检查，首个信号后不再准入新写入；已确认提交的目录不因后来取消而撤回，发布前
     * 的最后检查由 publish 明确执行，阶段诊断始终保持固定英文分类。
     */
    check() {
        if (this.signal?.aborted && !this.committed) this.fail("PAYLOAD_CANCELLED");
    }
    /**
     * 所有事务拒绝统一携带实际阶段和最终候选路径，不拼接压缩库消息或原始输入正文；cleanup 只由已执行且确认的资源关闭及
     * 归属检查产生，默认尚未清理时不能预先声称删除已成功完成。
     */
    fail(code: PayloadErrorCode, cleanup: Cleanup = "NOT_NEEDED", causeCode: string | null = null): never {
        throw new RuntimePayloadError(code, causeCode, cleanup, {
            phase: this.phase,
            candidateDirectory: this.directory,
        });
    }
    /**
     * 根目录复用已核 reader 的逐级无链接及 ASAR 检查，输入输出必须是互不覆盖的真实绝对路径；受控父目录由调用者持有，本
     * 实现明确只检测已观察替换，不把普通 JS rename 描述为恶意同 UID 下的原子独占原
     * 语。
     */
    async initialize() {
        this.check();
        relative(this.candidateName);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(this.candidateName) || this.candidateName.includes("/"))
            this.fail("PAYLOAD_PATH");
        for (const root of [this.inputRoot, this.outputParent]) {
            const reader = new InputReader(root, this.signal, []);
            await reader.initialize();
            this.check();
            await reader.finish();
            this.check();
        }
        const a = resolve(this.inputRoot),
            b = resolve(this.outputParent);
        if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) this.fail("PAYLOAD_PATH");
        this.parentIdentity = await lstat(this.outputParent, { bigint: true });
        this.check();
        await this.absent(this.directory);
        try {
            this.lock = await open(
                this.lockPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
            );
        } catch (error) {
            if (errno(error) === "EEXIST") this.fail("PAYLOAD_DESTINATION_EXISTS");
            throw error;
        }
        this.lockIdentity = await this.lock.stat({ bigint: true });
        await this.lock.writeFile(this.nonce);
        await this.lock.sync();
        this.check();
        await mkdir(this.scratch, { mode: 0o700 });
        this.scratchCreated = true;
        this.rootIdentity = await lstat(this.scratch, { bigint: true });
        this.directories.add("");
        this.directoryModes.set("", 0o700);
        this.check();
        if (this.profile === "intake") {
            await this.mkdir("snapshots");
            await this.mkdir("trees");
            await this.mkdir("trees/node");
            await this.mkdir("trees/chrome");
        } else if (this.profile === "work") {
            await this.mkdir("intakes");
            await this.mkdir("views");
            await this.mkdir("projection-evidence");
        } else {
            await this.mkdir("runtime");
            await this.mkdir("input-evidence");
        }
    }
    /**
     * 不存在检查只把明确 ENOENT 当作空位置，其它系统错误必须传播并停止事务；检查既在独占锁之前执行也紧邻 rename 再执行
     * ，避免把已有目录或符号链接当作可覆盖的旧候选而悄悄删除。
     */
    private async absent(path: string) {
        try {
            await lstat(path);
            this.fail("PAYLOAD_DESTINATION_EXISTS");
        } catch (error) {
            if (errno(error) !== "ENOENT") throw error;
        }
        this.check();
    }
    /**
     * 固定空间模型使用真实剩余写入量和保守元数据占用，额外预留至少十六 MiB 而不要求十六 GiB 空闲；每阶段重新制定计划，
     * 每个新条目及八 MiB 数据写入后再次查询，实际 ENOSPC 与配额错误仍会失败关闭。
     */
    async plan(bytes: number, entries: number) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(entries) || entries < 0)
            this.fail("PAYLOAD_LIMIT");
        this.remaining = bytes + entries * 4096 + limits.json + 16384;
        await this.checkSpace();
    }
    /**
     * 空闲量以 statfs 可用块计算并使用 BigInt 避免设备块乘积失去整数精度，调用者不能覆盖保留量或预算；本检查是保守计划
     * 而非物理磁盘精确计量，不能因此忽略后续真实写入失败或删除他人候选腾空间。
     */
    async checkSpace() {
        this.check();
        const facts = await statfs(this.outputParent, { bigint: true });
        this.check();
        const reserve = Math.max(16 * 1024 ** 2, Math.ceil(this.remaining * 0.05));
        if (facts.bavail * facts.bsize < BigInt(Math.ceil(this.remaining + reserve)))
            this.fail("PAYLOAD_DISK_INSUFFICIENT");
        this.sinceCheck = 0;
    }
    /**
     * 目录只按已核可移植组件逐层建立，物理权限固定私有且不沿归档权限落盘；重复推导父目录共享同一已记录身份，任何外来同
     * 名路径都会被 exclusive mkdir 拒绝，无法通过递归 mkdir 默默接受符号链接。
     */
    async mkdir(path: string) {
        if (!path || this.directories.has(path)) return;
        this.validatePath(path);
        const mode = this.publicPath(path) ? 0o755 : 0o700;
        await this.mkdir(dirname(path) === "." ? "" : dirname(path));
        this.check();
        await this.checkSpace();
        await mkdir(join(this.scratch, path), { mode });
        const directory = await open(join(this.scratch, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        // 目录权限或刷新失败必须作为第一错误继续向真实 intake 与 stage 边界传播，关闭只是独立收尾事实；即使真实 close
        // 后又报告异常，也只记录清理不确定，不能把原 ENOSPC 或 EDQUOT 换成后来的
        // EIO。
        let failed = false;
        let closeError: unknown;
        try {
            await directory.chmod(mode);
            await directory.sync();
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            try {
                await directory.close();
            } catch (error) {
                this.noteCloseFailure();
                if (!failed) closeError = error;
            }
        }
        if (closeError !== undefined) throw closeError;
        this.check();
        this.directories.add(path);
        this.directoryModes.set(path, mode);
        this.remaining = Math.max(0, this.remaining - 4096);
    }
    /**
     * 流写入只接受内部扫描器确认的相对路径，使用独占六百权限普通文件并分块写到完整长度；关闭确认前保留 writer 计数，任
     * 何 sync 或 close 失败都会阻止安全清理声明，绝不把仍可能写入的目录递归删除。
     */
    async write(path: string, chunks: AsyncIterable<Uint8Array>, expected?: Ref, requestedMode?: number) {
        let handle: FileHandle | undefined;
        const digest = createHash("sha256");
        let size = 0,
            primary: unknown;
        let closeError: unknown;
        let result: Ref;
        try {
            this.validatePath(path);
            const mode =
                requestedMode ??
                (this.publicPath(path) || (this.profile === "work" && path.startsWith("projection-evidence/"))
                    ? 0o644
                    : 0o600);
            if (
                this.publicPath(path)
                    ? ![0o444, 0o644, 0o555, 0o755].includes(mode)
                    : mode !== (this.profile === "work" && path.startsWith("projection-evidence/") ? 0o644 : 0o600)
            )
                this.fail("PAYLOAD_PATH");
            await this.mkdir(dirname(path) === "." ? "" : dirname(path));
            await this.checkSpace();
            this.check();
            handle = await open(
                join(this.scratch, path),
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
            );
            this.writers++;
            this.check();
            for await (const chunk of chunks) {
                this.check();
                size += chunk.byteLength;
                if (size > (expected?.sizeBytes ?? limits.file)) this.fail("PAYLOAD_LIMIT");
                digest.update(chunk);
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
                    this.check();
                    if (!result.bytesWritten) this.fail("PAYLOAD_IO");
                    offset += result.bytesWritten;
                    this.remaining = Math.max(0, this.remaining - result.bytesWritten);
                    this.sinceCheck += result.bytesWritten;
                    if (this.sinceCheck >= 8 * 1024 ** 2) await this.checkSpace();
                }
            }
            const actual = { path, sizeBytes: size, sha256: digest.digest("hex") };
            if (expected && (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256))
                this.fail("PAYLOAD_SOURCE_CHANGED");
            await handle.chmod(mode);
            await handle.sync();
            this.check();
            this.outputs.set(path, actual);
            this.outputModes.set(path, mode);
            this.remaining = Math.max(0, this.remaining - 4096);
            result = actual;
        } catch (error) {
            primary = error;
            const known = controlledIoFailure(error);
            if (known) this.fail(known.code, "NOT_NEEDED", known.causeCode);
            throw error;
        } finally {
            if (handle) {
                try {
                    await handle.close();
                    this.writers--;
                } catch (error) {
                    this.closureUnconfirmed = true;
                    if (!primary) closeError = error;
                }
            }
        }
        if (closeError !== undefined) throw closeError;
        return result;
    }
    /**
     * I 的来源观察在初次 b1a 成功后独立建立，保存实际消费文件与五树成员及全部父目录身份；它不继承 b1a 私有早期观察，也
     * 不承诺发现两个观察边界间的同字节 inode 替换，最终仍重调 b1a 固定内容政策。
     */
    async observeSources(report: InputInspection) {
        const names = new Set(report.checkedEvidence.map((r) => r.path));
        for (const [kind, tree] of Object.entries(report.trees)) {
            const root = report.recipe[kind as keyof typeof report.trees].root;
            names.add(root);
            for (const path of [
                ...tree.inventory.directories,
                ...tree.inventory.files.map((f) => f.path),
                ...tree.inventory.links.map((l) => l.path),
            ])
                names.add(`${root}/${path}`);
        }
        names.add("");
        const observationBound = (names.size + 5) * 65 + this.inputRoot.split("/").length;
        for (const name of [...names]) {
            let parent = dirname(name);
            while (parent !== "." && parent !== "") {
                names.add(parent);
                parent = dirname(parent);
            }
        }
        if (!Number.isSafeInteger(observationBound) || names.size > observationBound) this.fail("PAYLOAD_LIMIT");
        await this.registerSources(names);
    }
    /**
     * 有限资产观察入口同步复制严格引用后才开始等待，最多八个普通文件并支持私有证据权限；登记只证明当前身份和长度，摘要
     * 必须继续由 snapshot 的真实 held FD 流核验，不能把声明当作可信内容。
     */
    async observeRefs(refs: readonly Ref[]): Promise<void> {
        if (!Array.isArray(refs) || refs.length > 8) this.fail("PAYLOAD_LIMIT");
        const copied = refs.map((value) => {
            if (
                !value ||
                typeof value !== "object" ||
                Object.getPrototypeOf(value) !== Object.prototype ||
                Object.getOwnPropertySymbols(value).length ||
                Object.keys(value).sort().join(",") !== "path,sha256,sizeBytes" ||
                Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !("value" in d))
            )
                this.fail("PAYLOAD_INPUT_INVALID");
            const { path, sizeBytes, sha256 } = value;
            relative(path);
            if (
                !Number.isSafeInteger(sizeBytes) ||
                sizeBytes < 0 ||
                typeof sha256 !== "string" ||
                !/^[a-f0-9]{64}$/.test(sha256)
            )
                this.fail("PAYLOAD_INPUT_INVALID");
            if (sizeBytes > limits.file) this.fail("PAYLOAD_LIMIT");
            return { path, sizeBytes, sha256 };
        });
        if (new Set(copied.map((r) => r.path)).size !== copied.length) this.fail("PAYLOAD_COLLISION");
        if (copied.reduce((n, r) => n + r.sizeBytes, 0) > 4 * 1024 ** 3 + limits.evidence) this.fail("PAYLOAD_LIMIT");
        const names = new Set([""]);
        for (const ref of copied) {
            names.add(ref.path);
            for (let parent = dirname(ref.path); parent !== "."; parent = dirname(parent)) names.add(parent);
        }
        await this.registerSources(names, new Map(copied.map((r) => [r.path, r])));
    }
    /**
     * 旧五树入口与新有限引用共用同一个身份登记点，重复观察绝不覆盖较早事实；旧入口仍保存全部链接和树成员，新入口才额外
     * 限制普通文件权限与父目录，祖先身份收尾依然使用原本的比较政策。
     */
    private async registerSources(names: ReadonlySet<string>, refs?: ReadonlyMap<string, Ref>) {
        let hostParent = dirname(this.inputRoot);
        while (true) {
            const info = await lstat(hostParent, { bigint: true });
            this.check();
            if (!info.isDirectory() || info.isSymbolicLink()) this.fail("PAYLOAD_PATH");
            const prior = this.ancestors.get(hostParent);
            if (prior && !sameNode(prior, info)) this.fail("PAYLOAD_SOURCE_CHANGED");
            this.ancestors.set(hostParent, info);
            const next = dirname(hostParent);
            if (next === hostParent) break;
            hostParent = next;
        }
        for (const name of names) {
            this.check();
            const full = join(this.inputRoot, name),
                info = await lstat(full, { bigint: true });
            this.check();
            const ref = refs?.get(name);
            if (refs) {
                if (ref) {
                    if (
                        !info.isFile() ||
                        info.nlink !== 1n ||
                        info.size !== BigInt(ref.sizeBytes) ||
                        ![0o400, 0o600, 0o444, 0o644].includes(Number(info.mode & 0o7777n))
                    )
                        this.fail("PAYLOAD_PATH");
                } else if (!info.isDirectory() || ![0o700, 0o755, 0o555].includes(Number(info.mode & 0o7777n)))
                    this.fail("PAYLOAD_PATH");
            }
            const prior = this.observations.get(full);
            if (prior && !sameIdentity(prior, info)) this.fail("PAYLOAD_SOURCE_CHANGED");
            this.observations.set(full, info);
            if (info.isSymbolicLink()) await readlink(full);
        }
    }
    /**
     * 收尾重新观察同一来源身份集合，纳秒时间、长度、权限与 inode 均需保持一致，逻辑链接不解引用；所有归档复制和两遍解析
     * 完成后才接受该事实，变化时不重试到某个偶然成功的版本。
     */
    async finishSources() {
        for (const [path, before] of this.ancestors) {
            this.check();
            const now = await lstat(path, { bigint: true });
            this.check();
            if (!sameNode(before, now)) this.fail("PAYLOAD_SOURCE_CHANGED");
        }
        for (const [path, before] of this.observations) {
            this.check();
            const now = await lstat(path, { bigint: true });
            this.check();
            if (!sameIdentity(before, now)) this.fail("PAYLOAD_SOURCE_CHANGED");
        }
    }
    /**
     * 原归档从重新观察的单链接普通文件描述符复制为独立快照，打开前后及收尾均核同一身份与完整原始摘要；复制绝不使用
     * hardlink 或再次按外部路径提取，后续扫描只消费本事务快照。
     */
    async snapshot(ref: Ref, destination: string) {
        this.check();
        const path = join(this.inputRoot, ref.path),
            before = this.observations.get(path);
        if (!before || !before.isFile() || before.nlink !== 1n || before.size !== BigInt(ref.sizeBytes))
            this.fail("PAYLOAD_SOURCE_CHANGED");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let primary: unknown;
        let closeError: unknown;
        try {
            if (
                !sameIdentity(before, await handle.stat({ bigint: true })) ||
                !sameIdentity(before, await lstat(path, { bigint: true }))
            )
                this.fail("PAYLOAD_SOURCE_CHANGED");
            this.check();
            const stream = handle.createReadStream({
                autoClose: false,
                highWaterMark: 64 * 1024,
                signal: this.signal,
            });
            const closed = finished(stream);
            closed.catch(() => {});
            try {
                await this.write(destination, stream, ref);
                await closed;
            } finally {
                if (!stream.readableEnded) stream.destroy();
                await closed.catch(() => {});
            }
            if (
                !sameIdentity(before, await handle.stat({ bigint: true })) ||
                !sameIdentity(before, await lstat(path, { bigint: true }))
            )
                this.fail("PAYLOAD_SOURCE_CHANGED");
        } catch (error) {
            primary = error;
            throw error;
        } finally {
            try {
                await handle.close();
            } catch (error) {
                this.noteCloseFailure();
                if (!primary) closeError = error;
            }
        }
        if (closeError !== undefined) throw closeError;
    }
    /**
     * 次要关闭失败必须进入事务的可观察清理状态，不能被首个路径或内容错误覆盖成虚假成功；扫描器保留原始正式错误，同时用
     * 该记录阻止删除尚未确认资源边界的 scratch，CLI 仍有独立五秒期限处理无法返回的关闭。
     */
    noteCloseFailure() {
        this.closureUnconfirmed = true;
    }
    /**
     * 固定容器不属于发行成员深度与长度预算，移除唯一内部前缀后仍逐组件检查完整逻辑路径；绝对路径、点组件和逃逸不会因为
     * 容器豁免而放行，默认 intake 保持原有路径政策供后续单独整改。
     */
    private validatePath(path: string) {
        if (this.profile === "runtime" && path.startsWith("runtime/")) relative(path.slice(8));
        else if (this.profile === "work" && path.startsWith("views/")) relative(path.slice(6));
        else relative(path);
    }
    /**
     * 只有最终 runtime 与临时 views 两个固定树使用可分发权限，其它证据和事务目录继续保持私有；权限由内部 profile 和路径
     * 共同派生，不开放任意调用者 chmod 或可绕过 audit 的文件系统钩子。
     */
    private publicPath(path: string) {
        return (
            (this.profile === "runtime" && (path === "runtime" || path.startsWith("runtime/"))) ||
            (this.profile === "work" && (path === "views" || path.startsWith("views/")))
        );
    }
    /**
     * Chrome 链接只接受已独立核验布局中明确列出的 Framework 成员，真实普通树先写完再落地精确原目标；登记集合被 audit 逐
     * 项读回，其它任何链接路径都不能借该方法获得一般文件系统写权限。
     */
    async createChromeLinks(layout: MacChromeLayout) {
        if (this.profile !== "runtime") this.fail("PAYLOAD_PATH");
        for (const link of layout.allowedLinks) {
            if (!layout.frameworkRoots.some((root) => link.path.startsWith(root + "/")))
                this.fail("PAYLOAD_ARCHIVE_LINK");
            relative(link.target, true);
            await this.trackedLink(`runtime/${link.path}`, link.target);
        }
    }
    /**
     * 临时 npm alias 只有原收据明确声明并且每跳原始链接都与本次 intake 完全一致时才建立，终点必须是真实普通文件且等于
     * bin 目标；链接仅用于物理内容核验并归一到投影内目标，最终 Runtime 不复制它
     * 们。
     */
    async createProjectionBinAliases(node: NodeReceipt, members: readonly ArchiveMember[]) {
        if (this.profile !== "work") this.fail("PAYLOAD_PATH");
        const byPath = new Map(members.map((member) => [member.path, member]));
        const declared = new Map(node.inputLinks.map((link) => [link.path, link.target]));
        for (const bin of node.npmGraph.bins) {
            if (bin.sourceAlias === null) continue;
            if (bin.sourceAlias !== bin.aliasPath || !bin.sourceAlias.startsWith("npm/"))
                this.fail("PAYLOAD_BIN_UNSUPPORTED");
            let current = `${node.npmRoot}/${bin.sourceAlias.slice(4)}`;
            const original = byPath.get(current);
            if (original?.kind === "file") {
                if (this.outputs.get(`views/${bin.sourceAlias}`)?.sha256 !== original.sha256)
                    this.fail("PAYLOAD_SOURCE_CHANGED");
                continue;
            }
            const seen = new Set<string>();
            while (byPath.get(current)?.kind === "link") {
                const member = byPath.get(current)!;
                if (
                    member.kind !== "link" ||
                    declared.get(current) !== member.target ||
                    seen.has(current) ||
                    seen.size >= 32
                )
                    this.fail("PAYLOAD_ARCHIVE_LINK");
                seen.add(current);
                current = posix.normalize(posix.join(posix.dirname(current), member.target));
                if (!current.startsWith(node.npmRoot + "/")) this.fail("PAYLOAD_ARCHIVE_LINK");
            }
            const terminal = byPath.get(current);
            if (
                !seen.size ||
                terminal?.kind !== "file" ||
                current !== `${node.npmRoot}/${bin.targetPath.slice(4)}` ||
                terminal.sha256 !== bin.targetSha256
            )
                this.fail("PAYLOAD_BIN_UNSUPPORTED");
            const target = posix.relative(posix.dirname(bin.aliasPath), bin.targetPath);
            const actual = this.outputs.get(`views/${bin.targetPath}`);
            if (!actual || actual.sha256 !== terminal.sha256) this.fail("PAYLOAD_SOURCE_CHANGED");
            await this.trackedLink(`views/${bin.aliasPath}`, target);
        }
    }
    /**
     * 依赖 producer 只能重建已有 bin 计划精确声明的原始别名链接，目标必须是同一事务已写入并匹配摘要的普通成员；不能用本
     * 入口为包目录、任意源码或未纳入图的路径建立一般链接能力。
     * 公开赢家和保留私有命名空间的合法性仍由完整 graph 核验，事务这里只负责精确目标与受控视图所有权。
     */
    async createDependencyInputLinks(bins: readonly Bin[], links: readonly LinkFact[]) {
        if (this.profile !== "work") this.fail("PAYLOAD_PATH");
        if (links.length > limits.links || new Set(links.map((link) => link.path)).size !== links.length)
            this.fail("PAYLOAD_BIN_UNSUPPORTED");
        for (const link of links) {
            const matches = bins.filter((bin) => bin.sourceAlias === link.path && bin.aliasPath === link.path);
            if (matches.length !== 1) this.fail("PAYLOAD_BIN_UNSUPPORTED");
            const bin = matches[0]!;
            relative(link.path);
            relative(link.target, true);
            if (
                posix.normalize(posix.join(posix.dirname(link.path), link.target)) !== bin.targetPath ||
                this.outputs.get(`views/dependencies/${bin.targetPath}`)?.sha256 !== bin.targetSha256
            )
                this.fail("PAYLOAD_BIN_UNSUPPORTED");
            await this.trackedLink(`views/dependencies/${link.path}`, link.target);
        }
    }
    /**
     * 有限消费者完成各自政策检查之后才进入同一个私有链接写入点，逐级父目录必须为本事务已登记的真实目录；链接与文件目录
     * 集合互斥，原始目标在 audit 中逐字读回而不会被当作目录递归跟随。
     */
    private async trackedLink(path: string, target: string) {
        this.validatePath(path);
        relative(target, true);
        if (this.links.has(path) || this.outputs.has(path) || this.directories.has(path))
            this.fail("PAYLOAD_COLLISION");
        await this.mkdir(dirname(path));
        for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
            const info = await lstat(join(this.scratch, parent));
            if (!this.directories.has(parent) || !info.isDirectory() || info.isSymbolicLink())
                this.fail("PAYLOAD_SOURCE_CHANGED");
        }
        await this.checkSpace();
        await symlink(target, join(this.scratch, path));
        this.links.set(path, target);
        this.check();
    }
    /**
     * 每个快照与普通输出都通过 held FD 再次完整流 hash，目录则精确枚举已拥有集合拒绝额外或缺失路径；最终路径复核不受已
     * 提交后取消影响，无法确认内容时保留发布事实并返回提交不确定错误。
     */
    async audit(root = this.scratch) {
        const expected = new Set([...this.directories, ...this.outputs.keys(), ...this.links.keys()]);
        const walk = async (path: string): Promise<void> => {
            this.check();
            const full = join(root, path),
                before = await lstat(full, { bigint: true });
            this.check();
            if (!expected.delete(path)) this.fail("PAYLOAD_SOURCE_CHANGED");
            if (this.links.has(path)) {
                if (!before.isSymbolicLink() || (await readlink(full)) !== this.links.get(path))
                    this.fail("PAYLOAD_SOURCE_CHANGED");
            } else if (this.directories.has(path)) {
                if (!before.isDirectory() || Number(before.mode & 0o7777n) !== this.directoryModes.get(path))
                    this.fail("PAYLOAD_SOURCE_CHANGED");
                for (const name of await readdir(full)) await walk(path ? `${path}/${name}` : name);
            } else {
                const fact = this.outputs.get(path)!;
                if (
                    !before.isFile() ||
                    before.nlink !== 1n ||
                    Number(before.mode & 0o7777n) !== this.outputModes.get(path)
                )
                    this.fail("PAYLOAD_SOURCE_CHANGED");
                const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                let closeError: unknown;
                try {
                    if (!sameIdentity(before, await handle.stat({ bigint: true }))) this.fail("PAYLOAD_SOURCE_CHANGED");
                    const hash = createHash("sha256");
                    let size = 0;
                    for await (const chunk of handle.createReadStream({
                        autoClose: false,
                        highWaterMark: 64 * 1024,
                    })) {
                        this.check();
                        size += chunk.length;
                        if (size > fact.sizeBytes) this.fail("PAYLOAD_SOURCE_CHANGED");
                        hash.update(chunk);
                    }
                    if (
                        size !== fact.sizeBytes ||
                        hash.digest("hex") !== fact.sha256 ||
                        !sameIdentity(before, await handle.stat({ bigint: true })) ||
                        !sameIdentity(before, await lstat(full, { bigint: true }))
                    )
                        this.fail("PAYLOAD_SOURCE_CHANGED");
                } finally {
                    try {
                        await handle.close();
                    } catch (error) {
                        this.noteCloseFailure();
                        closeError = error;
                    }
                }
                if (closeError !== undefined) throw closeError;
            }
        };
        await walk("");
        if (expected.size) this.fail("PAYLOAD_SOURCE_CHANGED");
    }
    /**
     * 发布前刷新所有私有目录并再核自有根与锁，然后紧邻 rename 检查不存在和取消；rename 一旦开始即进入不确定边界，任何失
     * 败或最终复核失败都不冒充已回滚，也不会递归删除可能已经发布的目录。
     */
    async publish(): Promise<Cleanup> {
        if (this.profile !== "intake" && !this.runtimePolicy) this.fail("PAYLOAD_PATH");
        this.phase = "PUBLISH";
        await this.audit();
        for (const path of [...this.directories].sort((a, b) => b.length - a.length)) {
            const handle = await open(join(this.scratch, path), constants.O_RDONLY | constants.O_NOFOLLOW);
            let closeError: unknown;
            try {
                await handle.sync();
            } finally {
                try {
                    await handle.close();
                } catch (error) {
                    this.noteCloseFailure();
                    closeError = error;
                }
            }
            if (closeError !== undefined) throw closeError;
            this.check();
        }
        await this.owned();
        await this.absent(this.directory);
        this.check();
        try {
            await rename(this.scratch, this.directory);
            this.committed = true;
        } catch {
            this.closureUnconfirmed = true;
            this.fail("PAYLOAD_COMMIT_UNCONFIRMED", "INCOMPLETE");
        }
        try {
            const final = await lstat(this.directory, { bigint: true });
            if (!this.rootIdentity || !sameNode(this.rootIdentity, final))
                this.fail("PAYLOAD_COMMIT_UNCONFIRMED", "INCOMPLETE");
            await this.audit(this.directory);
            if (this.runtimePolicy) {
                const inventory = await verifyMacRuntimeManifestV2(join(this.directory, "runtime"), {
                    arch: this.runtimePolicy.arch,
                    layout: this.runtimePolicy.layout,
                });
                if (inventory.manifestSha256 !== this.runtimePolicy.manifestSha256)
                    this.fail("PAYLOAD_COMMIT_UNCONFIRMED", "INCOMPLETE");
                this.finalInventory = inventory;
            }
            const parent = await open(this.outputParent, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                await parent.sync();
            } finally {
                await parent.close();
            }
        } catch {
            this.closureUnconfirmed = true;
            this.fail("PAYLOAD_COMMIT_UNCONFIRMED", "INCOMPLETE");
        }
        return this.cleanup();
    }
    /**
     * Runtime 发布复用原独占锁和 rename 边界，但锁收尾前还必须在真正最终目录执行完整 D3a 并匹配同一 manifest 摘要；提交
     * 后无法核验时保留候选并报告不确定，绝不通过替换旧临时 root 字段冒充最
     * 终物理观察。
     */
    async publishRuntime(policy: {
        arch: MacRuntimeArch;
        layout: MacChromeLayout;
        manifestSha256: string;
    }): Promise<{ cleanup: Cleanup; inventory: MacRuntimeStaticInventory }> {
        if (this.profile !== "runtime" || this.runtimePolicy) this.fail("PAYLOAD_PATH");
        this.runtimePolicy = Object.freeze({
            arch: policy.arch,
            layout: structuredClone(policy.layout),
            manifestSha256: policy.manifestSha256,
        });
        const cleanup = await this.publish();
        if (!this.finalInventory) this.fail("PAYLOAD_COMMIT_UNCONFIRMED", "INCOMPLETE");
        return { cleanup, inventory: this.finalInventory };
    }
    /**
     * 清理归属以真实父目录、随机根 inode、独占锁 inode 与 nonce 字节共同确认，标记本身不允许接管旧目录；被观察到替换或
     * 尚有 writer 时拒绝删除，成功提交后只收尾锁而永远保留最终内容。
     */
    private async owned() {
        if (!this.parentIdentity || !sameNode(this.parentIdentity, await lstat(this.outputParent, { bigint: true })))
            this.fail("PAYLOAD_SOURCE_CHANGED", "INCOMPLETE");
        if (
            this.rootIdentity &&
            !sameNode(this.rootIdentity, await lstat(this.committed ? this.directory : this.scratch, { bigint: true }))
        )
            this.fail("PAYLOAD_SOURCE_CHANGED", "INCOMPLETE");
        if (this.lockIdentity) {
            const current = await lstat(this.lockPath, { bigint: true });
            if (
                !sameNode(this.lockIdentity, current) ||
                sha(await readSmall(this.lockPath)) !== sha(Buffer.from(this.nonce))
            )
                this.fail("PAYLOAD_SOURCE_CHANGED", "INCOMPLETE");
        }
    }
    /**
     * 仅当前事务持有的目录与锁可进入删除流程，所有写句柄关闭和原始身份确认是前置条件；清理失败只返回 INCOMPLETE 而不覆
     * 盖原始拒绝分类，既有候选、输入以及其它随机目录都不会按名字模式扫描回收。
     */
    async cleanup(): Promise<Cleanup> {
        if (!this.lock && !this.rootIdentity && !this.scratchCreated) return "NOT_NEEDED";
        if ((this.lock && !this.lockIdentity) || (this.scratchCreated && !this.rootIdentity))
            this.closureUnconfirmed = true;
        if (this.writers || this.closureUnconfirmed) {
            if (this.lock) {
                try {
                    await this.lock.close();
                    this.lock = undefined;
                } catch {
                    this.closureUnconfirmed = true;
                }
            }
            return "INCOMPLETE";
        }
        try {
            await this.owned();
            if (!this.committed && this.rootIdentity) {
                await rm(this.scratch, { recursive: true });
                this.rootIdentity = undefined;
            }
            if (this.lock) {
                await this.lock.close();
                this.lock = undefined;
            }
            if (this.lockIdentity) {
                await unlink(this.lockPath);
                this.lockIdentity = undefined;
            }
            return "CONFIRMED";
        } catch {
            if (this.lock) {
                try {
                    await this.lock.close();
                    this.lock = undefined;
                } catch {
                    this.closureUnconfirmed = true;
                }
            }
            return "INCOMPLETE";
        }
    }
}

/**
 * 身份比较区分会随目录正常写入变化的时间与固定归属字段，根和父目录只比较后者；普通源文件使用完整纳秒事实，避免同长度重
 * 写或权限改变在重新 hash 相同内容后被当作从未变化。
 */
function sameNode(a: BigIntStats, b: BigIntStats) {
    return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
/**
 * 完整来源比较额外保留链接数、长度与纳秒修改状态，读取不会改变参与比较的 atime；这些字段形成有界观察证据，不提供敌对同
 * UID 目录替换时不存在的原子整树快照保证。
 */
function sameIdentity(a: BigIntStats, b: BigIntStats) {
    return (
        sameNode(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
    );
}
/**
 * 错误码提取只接受对象上的字符串系统分类，公开错误映射另外使用白名单；这里不读取或传播底层 message，避免压缩库或文件系
 * 统把不受信任归档路径及输入正文拼入英文诊断。
 */
export function errno(error: unknown): string | null {
    return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
/**
 * 受控文件系统错误在真实写入边界先分类，避免经过压缩适配器后被误当格式错误；仅固定 errno 白名单可产生 IO 或空间不足，压
 * 缩库与未知错误返回空值保留原解释路径，首个分类与次要关闭不确认分别记录。
 */
export function controlledIoFailure(error: unknown): Readonly<{ code: PayloadErrorCode; causeCode: string }> | null {
    const code = errno(error);
    if (
        !code ||
        ![
            "ENOENT",
            "ENOTDIR",
            "ELOOP",
            "EACCES",
            "EPERM",
            "EIO",
            "EMFILE",
            "ENFILE",
            "EBADF",
            "EINVAL",
            "ENOSPC",
            "EDQUOT",
        ].includes(code)
    )
        return null;
    return {
        code: code === "ENOSPC" || code === "EDQUOT" ? "PAYLOAD_DISK_INSUFFICIENT" : "PAYLOAD_IO",
        causeCode: code,
    };
}
/**
 * 独占锁标识使用同一个无链接 held FD 有界读取，仅接受当前事务的短 nonce 长度；它与目录和锁 inode 检查组合使用，不把任意
 * 同名字 JSON 或用户可写标记解释为清理其它目录的权限。
 */
async function readSmall(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        if ((await handle.stat()).size > 128) throw new Error("LOCK_INVALID");
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}
