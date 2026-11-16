import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
    RuntimePayloadError,
    type Ref,
    type TreeInventory,
    type BoundTree,
    type TreeKind,
    type PayloadErrorCode,
} from "./runtime-payload-inputs.ts";

/**
 * 固定输入预算在声明解析和真实读取时分别执行，不能由调用方通过 options 放宽；五棵树共享成员及内容累计计数，单个 JSON 与
 * 单个 package 正文另受较小上限保护。
 */
export const limits = Object.freeze({
    json: 4 * 1024 ** 2,
    package: 1024 ** 2,
    javascript: 16 * 1024 ** 2,
    javascriptTotal: 64 * 1024 ** 2,
    file: 2 * 1024 ** 3,
    entries: 40000,
    links: 1024,
    total: 16 * 1024 ** 3,
    evidence: 64 * 1024 ** 2,
    instances: 4000,
    edges: 20000,
    bins: 2000,
});
/**
 * 已知源码和树成员按语义文件名选择较小内容类别，package.json 优先于普通 JSON，普通二进制仍保留两 GiB；归档引用不经此分
 * 类，以免任意归档文件名被误当作 JSON 文档限制。
 * 同一个分类函数同时用于声明预检与首次实际流读，不能只在后续 package 或 engine 解码时才补限额。
 */
export function contentLimit(path: string): number {
    return path.split("/").at(-1) === "package.json"
        ? limits.package
        : path.endsWith(".json")
          ? limits.json
          : limits.file;
}
/**
 * 一组已知源码或完整树库存先统一核类别声明，再开始其中任何成员正文读取，防止后排超限成员被早期文件尺寸错误掩盖；实际读
 * 流仍使用同一类别上限并单独累计真实字节，声明检查不替代内容核验。
 */
export function admitContent(files: readonly Ref[]) {
    for (const file of files) if (file.sizeBytes > contentLimit(file.path)) fail("PAYLOAD_LIMIT");
}
/**
 * 内部失败入口只构造正式固定分类，不拼接输入路径、正文或底层异常消息；所有模块共享这一入口，避免某一图核验分支意外泄露
 * 不受信任的 JSON 或系统错误字符串。
 */
export function fail(code: PayloadErrorCode): never {
    throw new RuntimePayloadError(code);
}
/**
 * 系统错误映射只允许明确枚举的 errno 分类，未知异常也转为固定 IO 拒绝；取消和正式合同错误原样传递，但绝不将任意对象的
 * message 或 stack 挂载到公开错误。
 */
export function io(error: unknown): never {
    if (error instanceof RuntimePayloadError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const allowed = new Set([
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
    ]);
    throw new RuntimePayloadError("PAYLOAD_IO", typeof code === "string" && allowed.has(code) ? code : null);
}
/**
 * 原始字节摘要统一交给 Node crypto，避免私造密码学实现或因 JSON 重编码改变证据身份；规范化条目需要由调用方明确先使用现
 * 有 canonicalBytes，不能在这里隐式转换。
 */
export const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
/**
 * 深冻结仅遍历已经完成结构校验的数据，所有子数组和对象都会冻结以阻止异步期间的策略修改；函数不接受循环宿主对象，
 * AbortSignal 始终作为固定引用单独快照。
 */
export function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
/**
 * JSON 解码先检查固定字节上限再使用严格 UTF8，不接受替换字符修补或 BOM 隐式宽容；解析异常只返回固定输入错误，避免引擎诊
 * 断把不受信任正文片段回显给用户。
 */
export function decode(value: Uint8Array): unknown {
    if (value.byteLength > limits.json) fail("PAYLOAD_LIMIT");
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value));
    } catch {
        fail("PAYLOAD_INPUT_INVALID");
    }
}
/**
 * 路径必须保留原始可移植 ASCII 拼写，拒绝点组件、设备名、ASAR 和平台危险符号；链接目标仅在单独语境允许点组件，绝不先
 * normalize 再把越界路径解释为安全成员。
 */
export function relative(value: unknown, link = false): string {
    if (typeof value !== "string") fail("PAYLOAD_INPUT_INVALID");
    if (!value) fail("PAYLOAD_PATH");
    const parts = value.split("/");
    if (Buffer.byteLength(value) > 1024 || parts.length > 64) fail("PAYLOAD_LIMIT");
    for (const part of parts) {
        if (link && (part === "." || part === "..")) continue;
        if (Buffer.byteLength(part) > 255) fail("PAYLOAD_LIMIT");
        if (
            !part ||
            part.normalize("NFC") !== part ||
            /[^\x20-\x7e]/.test(part) ||
            /[\\:<>"|?*]/.test(part) ||
            /[. ]$/.test(part) ||
            part === "." ||
            part === ".." ||
            /\.asar$/i.test(part) ||
            /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(part.split(".")[0]!.trimEnd())
        )
            fail("PAYLOAD_PATH");
    }
    return value;
}
/**
 * 路径集合同时注册累计父组件的大小写身份，能够捕获 A/x 与 a/y 的隐蔽冲突；完整成员不得重复，物理父目录可以被多个孩子共
 * 享但必须在库存目录集合中显式出现。
 */
export function paths(values: readonly string[], directories?: readonly string[]) {
    const seen = new Set<string>(),
        prefixes = new Map<string, string>();
    for (const path of values) {
        relative(path);
        if (seen.has(path)) fail("PAYLOAD_COLLISION");
        seen.add(path);
        let prefix = "";
        for (const part of path.split("/")) {
            prefix = prefix ? `${prefix}/${part}` : part;
            const key = prefix.toLowerCase(),
                prior = prefixes.get(key);
            if (prior !== undefined && prior !== prefix) fail("PAYLOAD_COLLISION");
            prefixes.set(key, prefix);
        }
        if (directories) {
            let parent = dirname(path);
            while (parent !== ".") {
                if (!directories.includes(parent)) fail("PAYLOAD_TREE_MISMATCH");
                parent = dirname(parent);
            }
        }
    }
}
/**
 * 身份比较包含 inode、设备、权限、链接数、精确长度和纳秒修改时间，不以路径存在代替同一来源；这里检测观察到的替换与变化
 * ，纯 JavaScript 不承诺抵抗恶意同 UID 父路径并发替换。
 */
function same(a: BigIntStats, b: BigIntStats) {
    return (
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs
    );
}

/**
 * 证据角色准入与成功读回报告分别维护，固定六十四 MiB 累计预算不接受调用方覆写；此内部组件由真实 Ref reader 消费，声明级
 * 测试可以直接核大长度关系而不创建同等体积的磁盘文件。
 */
export class EvidenceBudget {
    private readonly admitted = new Map<string, Ref>();
    private bytes = 0;
    /**
     * 同一路径的证据声明必须保持相同长度和摘要，重复引用不得重复收费或借替换摘要重新获得预算；该准入只记录声明，真正读
     * 过的事实仍由 reader.checked 在成功读取之后单独登记。
     */
    admit(ref: Ref, budgeted: boolean) {
        if (!budgeted) return;
        const previous = this.admitted.get(ref.path);
        if (previous && (previous.sizeBytes !== ref.sizeBytes || previous.sha256 !== ref.sha256))
            fail("PAYLOAD_RECEIPT_MISMATCH");
        if (previous) return;
        const next = this.bytes + ref.sizeBytes;
        if (next > limits.evidence) fail("PAYLOAD_LIMIT");
        this.admitted.set(ref.path, { ...ref });
        this.bytes = next;
    }
}
/**
 * 每次核验独占只读上下文并持有自己的身份快照及流句柄，不注册进程级监听、不创建暂存目录；外部引用与树成员分别准入，避免
 * receipt 自哈希循环或通过链接解引用扩大读取范围。
 */
export class InputReader {
    readonly checked = new Map<string, Ref>();
    private readonly observations = new Map<string, BigIntStats>();
    private readonly identities = new Set<string>();
    private readonly scripts = new Map<string, number>();
    private scriptBytes = 0;
    private entries = 0;
    private links = 0;
    private fileBytes = 0;
    private readonly evidenceBudget = new EvidenceBudget();
    /**
     * 上下文固定唯一绝对输入根和同一取消信号，树根列表只用于阻断证据进入库存内部；所有可变计数和身份快照由本次核验独占
     * ，不能通过外部 options 放宽固定预算或继承上一份报告。
     */
    constructor(
        readonly root: string,
        readonly signal: AbortSignal | undefined,
        private readonly trees: readonly string[],
    ) {}
    /**
     * 取消检查围绕每个 await 和每个读取块执行，首个中止后停止新的文件准入；库不控制进程退出，CLI 使用同一信号与独立期限
     * 来报告尚未确认的关闭状态。
     */
    abort() {
        if (this.signal?.aborted) fail("PAYLOAD_CANCELLED");
    }
    /**
     * 输入根允许中文和空格，但每一级祖先必须是实际目录且不能经过 symlink 或 ASAR；成员根的安全权限另行检查，宿主系统根
     * 权限不套用库存子目录的权限规则。
     */
    async initialize() {
        this.abort();
        if (
            typeof this.root !== "string" ||
            !isAbsolute(this.root) ||
            this.root.includes("\0") ||
            this.root.split(/[\\/]/).some((p) => p === "." || p === ".." || /\.asar$/i.test(p)) ||
            !constants.O_NOFOLLOW ||
            !constants.O_NONBLOCK
        )
            fail("PAYLOAD_PATH");
        let current = parse(this.root).root;
        for (const part of resolve(this.root).slice(current.length).split("/").filter(Boolean)) {
            current = join(current, part);
            const info = await this.stat(current);
            if (!info.isDirectory() || info.isSymbolicLink()) fail("PAYLOAD_PATH");
        }
        const rootInfo = await this.stat(this.root);
        if (!rootInfo.isDirectory() || ![0o700, 0o755, 0o555].includes(Number(rootInfo.mode & 0o7777n)))
            fail("PAYLOAD_PATH");
        this.observe(this.root, rootInfo);
    }
    /**
     * 路径观察只能保持同一身份；重复读取不是重试修复机制，任何一次看到前后不一致都会拒绝；这样多条 Ref 共享父目录时，也
     * 不能用后读快照覆盖较早的变化证据。
     */
    private observe(path: string, info: BigIntStats) {
        const prior = this.observations.get(path);
        if (prior && !same(prior, info)) fail("PAYLOAD_SOURCE_CHANGED");
        this.observations.set(path, info);
    }
    /**
     * lstat 包装在 await 返回后立即检查取消，再将未知系统异常映射为受控错误；它从不追随最终符号链接，也不把缺失文件自动
     * 当作可接受的 optional 内容。
     */
    private async stat(path: string) {
        this.abort();
        try {
            const result = await lstat(path, { bigint: true });
            this.abort();
            return result;
        } catch (error) {
            io(error);
        }
    }
    /**
     * 每次文件准入都重新确认输入根以下的所有父目录，拒绝经过链接的证据或源码路径；父目录快照会在收尾再次比较，不能只检
     * 查最后一个文件描述符而忽略观察到的父路径变化。
     */
    private async parents(path: string) {
        let current = this.root;
        const rootInfo = await this.stat(current);
        this.observe(current, rootInfo);
        for (const part of path.split("/").slice(0, -1)) {
            current = join(current, part);
            const info = await this.stat(current);
            if (!info.isDirectory() || ![0o700, 0o755, 0o555].includes(Number(info.mode & 0o7777n)))
                fail("PAYLOAD_PATH");
            this.observe(current, info);
        }
    }
    /**
     * Ref 只能位于五棵输入树之外并绑定单链接普通文件，重复路径必须保持相同摘要和长度；所有真正读过的去重 Ref 才进入
     * checkedEvidence，声明存在但未读取的 blob 不会被记录。
     */
    async ref(
        ref: Ref,
        collect = false,
        limit = collect ? limits.json : limits.evidence,
        budgeted = limit !== limits.file,
    ): Promise<Buffer> {
        relative(ref.path);
        if (this.trees.some((root) => ref.path === root || ref.path.startsWith(root + "/"))) fail("PAYLOAD_PATH");
        const prior = this.checked.get(ref.path);
        if (prior && (prior.sha256 !== ref.sha256 || prior.sizeBytes !== ref.sizeBytes))
            fail("PAYLOAD_RECEIPT_MISMATCH");
        this.evidenceBudget.admit(ref, budgeted);
        const content = await this.read(ref.path, ref, limit, collect);
        this.checked.set(ref.path, {
            path: ref.path,
            sizeBytes: ref.sizeBytes,
            sha256: ref.sha256,
        });
        return content;
    }
    /**
     * 成员读取采用固定六十四 KiB 块，并在打开前拒绝超声明或类别预算，实际计数仍单独限制；前后 held FD fstat 与路径
     * lstat 都匹配才接受摘要，finally 负责关闭本次句柄。
     */
    private async read(
        path: string,
        ref: Ref,
        limit: number,
        collect: boolean,
        mode?: number,
        raw = false,
        captureLimit = limit,
    ): Promise<Buffer> {
        this.abort();
        relative(path);
        if (ref.sizeBytes > limit) fail("PAYLOAD_LIMIT");
        await this.parents(path);
        const full = join(this.root, path),
            before = await this.stat(full);
        if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.ino === 0n ||
            !(mode === undefined ? (raw ? [0o400, 0o600, 0o444, 0o644] : [0o444, 0o644]) : [mode]).includes(
                Number(before.mode & 0o7777n),
            )
        )
            fail("PAYLOAD_TREE_MISMATCH");
        if (before.size > BigInt(limit)) fail("PAYLOAD_LIMIT");
        if (before.size !== BigInt(ref.sizeBytes)) fail("PAYLOAD_TREE_MISMATCH");
        this.observe(full, before);
        let handle: import("node:fs/promises").FileHandle | undefined;
        try {
            handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            this.abort();
            if (!same(before, await handle.stat({ bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
            this.abort();
            const digest = createHash("sha256"),
                chunks: Buffer[] = [];
            let size = 0;
            for await (const value of handle.createReadStream({
                autoClose: false,
                highWaterMark: 64 * 1024,
                signal: this.signal,
            })) {
                this.abort();
                const chunk = value as Buffer;
                size += chunk.length;
                if (size > limit || size > ref.sizeBytes) fail("PAYLOAD_LIMIT");
                digest.update(chunk);
                if (collect && size - chunk.length < captureLimit)
                    chunks.push(chunk.subarray(0, Math.min(chunk.length, captureLimit - (size - chunk.length))));
            }
            this.abort();
            if (!same(before, await handle.stat({ bigint: true }))) fail("PAYLOAD_SOURCE_CHANGED");
            this.abort();
            if (!same(before, await this.stat(full))) fail("PAYLOAD_SOURCE_CHANGED");
            if (size !== ref.sizeBytes || (!raw && digest.digest("hex") !== ref.sha256)) fail("PAYLOAD_TREE_MISMATCH");
            return collect ? Buffer.concat(chunks, Math.min(size, captureLimit)) : Buffer.alloc(0);
        } catch (error) {
            this.abort();
            return io(error);
        } finally {
            if (handle)
                try {
                    await handle.close();
                } catch (error) {
                    io(error);
                }
        }
    }
    /**
     * CLI 外层 JSON 尚无摘要声明，只能先按真实大小有界读取并核前后身份，随后核心入口再匹配独立 recipe hash；此内部方法
     * 不产生 checkedEvidence，不允许调用者把未绑定文件伪装成已核 Ref。
     */
    async input(path: string) {
        relative(path);
        await this.parents(path);
        const info = await this.stat(join(this.root, path));
        if (info.size < 0n || info.size > BigInt(limits.json)) fail("PAYLOAD_LIMIT");
        return this.read(path, { path, sizeBytes: Number(info.size), sha256: "" }, limits.json, true, undefined, true);
    }
    /**
     * 已核树成员需要 JSON 或 JavaScript 正文时按较小上限重读同一身份，不能从无界缓存中隐式取得内容；重复读取不会重复累
     * 计树大小，初次完整枚举已独立核过全部文件。
     */
    member(tree: BoundTree, ref: Ref, limit = limits.json) {
        return this.read(
            `${tree.root}/${ref.path}`,
            ref,
            Math.min(limit, contentLimit(ref.path)),
            true,
            (ref as { mode?: number }).mode ?? 0o644,
        );
    }
    /**
     * 所需 AST 文件先集中按声明核单文件十六 MiB 与合计六十四 MiB 预算，再进行任何树正文读取；计划只保存路径和长度，不保
     * 留 AST，重复读取同一来源也不能扩大已冻结的声明长度。
     * 此处在全部库存读取后调用，使后面的某棵树超总额时仍能在读取前拒绝。
     */
    planScripts(tree: BoundTree, files: readonly Ref[]) {
        for (const file of files) {
            const path = `${tree.root}/${file.path}`;
            if (file.sizeBytes > limits.javascript) fail("PAYLOAD_LIMIT");
            const prior = this.scripts.get(path);
            if (prior !== undefined && prior !== file.sizeBytes) fail("PAYLOAD_SOURCE_CHANGED");
            if (prior === undefined) {
                this.scripts.set(path, file.sizeBytes);
                this.scriptBytes += file.sizeBytes;
                if (this.scriptBytes > limits.javascriptTotal) fail("PAYLOAD_LIMIT");
            }
        }
    }
    /**
     * 需要 AST 的正文只能按已核声明顺序读取，单文件上限独立于 JSON 的四 MiB 预算；上层每次解析结束即释放前一棵语法树，
     * 不并发积累整个入口和执行代码集合。
     */
    script(tree: BoundTree, ref: Ref) {
        this.planScripts(tree, [ref]);
        return this.read(
            `${tree.root}/${ref.path}`,
            ref,
            limits.javascript,
            true,
            (ref as { mode?: number }).mode ?? 0o644,
        );
    }
    /**
     * bin shebang 只需要有限首行信息，不应把整个大型 JS 正文收集进内存或误用 AST 限额；仍逐字节重核全文件摘要与身份，只
     * 保留最前面二百五十六字节供固定解释器检查。
     */
    header(tree: BoundTree, ref: Ref) {
        return this.read(
            `${tree.root}/${ref.path}`,
            ref,
            limits.file,
            true,
            (ref as { mode?: number }).mode ?? 0o644,
            false,
            256,
        );
    }
    /**
     * 完整树枚举逐项比较显式库存，目录、文件和有限逻辑链接三集合互斥；五棵树共享预算和 inode 集合，遗漏、额外空目录、
     * hardlink、special 与不安全权限均立即阻断。
     */
    async tree(tree: BoundTree, inventory: TreeInventory, kind: TreeKind) {
        admitContent(inventory.files);
        const all = [
            ...inventory.directories,
            ...inventory.files.map((f) => f.path),
            ...inventory.links.map((l) => l.path),
        ];
        paths(all, inventory.directories);
        if (kind !== "dependencies" && inventory.links.length) fail("PAYLOAD_TREE_MISMATCH");
        this.entries += all.length;
        this.links += inventory.links.length;
        for (const file of inventory.files) {
            this.fileBytes += file.sizeBytes;
            if (file.sizeBytes > limits.file) fail("PAYLOAD_LIMIT");
        }
        if (this.entries > limits.entries || this.links > limits.links || this.fileBytes > limits.total)
            fail("PAYLOAD_LIMIT");
        const files = new Map(inventory.files.map((f) => [f.path, f])),
            links = new Map(inventory.links.map((l) => [l.path, l]));
        const expected = new Set(all);
        const seen = new Set<string>();
        const walk = async (path: string) => {
            this.abort();
            const full = join(this.root, tree.root, path),
                info = await this.stat(full);
            if (!info.isDirectory() || ![0o555, 0o755].includes(Number(info.mode & 0o7777n)))
                fail("PAYLOAD_TREE_MISMATCH");
            this.observe(full, info);
            for await (const entry of await opendir(full)) {
                this.abort();
                const name = entry.name;
                relative(name);
                const member = path ? `${path}/${name}` : name;
                if (!expected.has(member)) fail("PAYLOAD_TREE_MISMATCH");
                seen.add(member);
                const child = await this.stat(join(full, name));
                if (child.isDirectory()) {
                    if (!inventory.directories.includes(member)) fail("PAYLOAD_TREE_MISMATCH");
                    await walk(member);
                } else if (child.isSymbolicLink()) {
                    const link = links.get(member);
                    if (!link) fail("PAYLOAD_TREE_MISMATCH");
                    relative(link.target, true);
                    const target = await readlink(join(full, name));
                    this.abort();
                    if (target !== link.target) fail("PAYLOAD_TREE_MISMATCH");
                    this.observe(join(full, name), child);
                } else {
                    const file = files.get(member);
                    if (!file || !child.isFile() || child.nlink !== 1n) fail("PAYLOAD_TREE_MISMATCH");
                    const key = `${child.dev}:${child.ino}`;
                    if (this.identities.has(key)) fail("PAYLOAD_TREE_MISMATCH");
                    this.identities.add(key);
                    await this.read(`${tree.root}/${member}`, file, contentLimit(file.path), false, file.mode);
                }
            }
        };
        await this.parents(`${tree.root}/placeholder`);
        await walk("");
        if (seen.size !== expected.size) fail("PAYLOAD_TREE_MISMATCH");
        return {
            fileCount: inventory.files.length,
            directoryCount: inventory.directories.length,
            linkCount: inventory.links.length,
            fileBytes: inventory.files.reduce((n, f) => n + f.sizeBytes, 0),
        };
    }
    /**
     * 返回报告前重新观察所有来源与目录身份，目录 mtime 和 ctime 变化可捕获收尾期间的新增遗漏；核验遇到变化不重试到成功
     * ，也不把这次静态观察包装成长期可执行能力。
     */
    async finish() {
        for (const [path, before] of this.observations) {
            const after = await this.stat(path);
            if (!same(before, after)) fail("PAYLOAD_SOURCE_CHANGED");
        }
        this.abort();
    }
}
