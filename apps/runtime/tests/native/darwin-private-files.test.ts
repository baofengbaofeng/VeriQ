/** Darwin 文件基础首先通过已有正式消费者观察正常私有文件行为，测试不导入尚未实现的原生适配或构建脚本；临时根的系统别名仅由测试准备解析，产品目录访问仍必须自行拒绝链接。
 * 两个消费者都使用公开构造入口，避免直接读取测试自己创建的文件而漏掉平台分派缺口。
 * 合成记录没有凭据、停止证明或发行能力，成功只表示有限文件操作能够连接已有业务接口。
 * 同一文件会在真实 Mac 的两个架构运行，测试名称和断言保持一致以比较实现前后的结果。
 * Linux 上运行只能检查测试准备与现有路径兼容，不能作为 Darwin 的失败或通过证据。
 * 导入全部指向当前已存在的源码，因此首轮失败不会来自未实现的 addon 或构建入口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, mkdir, chmod, symlink, link, rename, readFile, stat, readdir } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync, truncateSync, appendFileSync, openSync, closeSync, fstatSync, writeSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessRecords } from "../../src/execution/records.ts";
import { VaultFiles } from "../../src/credentials/files.ts";
import { darwinNative, type DarwinNative, type DarwinPrivateDirectory } from "../../src/native/darwin.ts";

/** macOS 的临时目录可能经由系统别名暴露，因此先解析宿主临时根再创建本次唯一七百权限目录；清理只接触 mkdtemp 返回的测试目录，不删除已有历史，也不为正式消费者预先放宽权限或模拟文件操作。
 * realpath 只应用于操作系统提供的临时根，正式接口不会得到通过别名访问的授权示例。
 * mkdtemp 创建的随机目录属于当前进程用户，满足只读记录类要求的最终私有目录条件。
 * 回调发生任何断言或消费者错误仍会进入 finally，因此真实 RED 不遗留下一轮可见状态。
 * 每个测试各自创建目录，保险库写入不会影响记录枚举，也不会把并发顺序作为通过条件。
 * fixture 不执行 chmod 或特权操作；正常样本从创建开始就带有要求的访问模式。
 */
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(await realpath(tmpdir()), "veriq-darwin-private-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** 只读历史的正常路径必须真正返回可用会话而不是把缺少目录能力解释成记录不存在；当前 macOS 缺少 Linux 的 proc 文件系统，此断言将保存缺口的实际失败，同时后续读取证明使用了正式记录类。
 * 记录按正式 Attempt 成员语法命名，有限正文采用当前用户拥有的六百模式普通文件。
 * open 返回 undefined 在这里属于失败，因为测试此前已经创建了确切存在的私有目录。
 * 该断言让当前 Mac 的能力缺失显示为产品行为失败，不把缺失记录当作符合预期的成功。
 * names 必须完整返回唯一普通成员，其限额恰为一，不能通过过滤或只读取目录路径替代。
 * read 使用正式六万五千五百三十六字节上限并比较解析结果，覆盖实际字节读取和 JSON 解码。
 * 构造成功后始终关闭会话；读取或枚举断言失败也不能让目录描述符依赖垃圾回收释放。
 * 正常内容没有 STOPPED 状态，因此此基础测试不会为任何进程停止或历史迁移提供授权。
 */
test("ProcessRecords opens an existing private directory and reads its normal record", async () =>
    fixture(async (directory) => {
        const value = { state: "ALLOCATED", attemptId: "mac-normal" };
        await writeFile(join(directory, "mac-normal.json"), JSON.stringify(value), { mode: 0o600 });
        const records = await ProcessRecords.open(directory);
        assert.ok(records, "Existing private records directory must open successfully");
        try {
            assert.deepEqual(await records.names(1), ["mac-normal.json"]);
            assert.deepEqual(await records.read("mac-normal.json", 65536), value);
        } finally {
            await records.close();
        }
    }));

/** 扩展边界仅在实际 Darwin 运行，Linux 的显式跳过只说明平台不适用而不计入 Mac 通过证据；正式加载器仍按固定开发位置加载本架构产物，测试不会用 Linux 文件系统替代 Mac 原生语义。
 * 前两个既有消费者用例继续跨 POSIX 运行，保持 RED 与 GREEN 的同一断言。
 * 后续每个用例独立创建真实私有目录，不复用先前测试留下的权限或文件状态。
 * 故障模块位于独立测试输出，和正式模块同时加载以核对导出隔离。
 * 所有合成内容均公开，无真实凭据或 Chrome 控制端点。
 */
const mac = { skip: process.platform !== "darwin" };
const bytesLimit = 2 * 1024 * 1024;
/** 故障接口只描述独立测试模块追加的三项控制函数，继承的文件操作仍来自与生产一致的正式有限接口；类型不会传给产品加载器，也不允许业务消费者用环境变量取得调度能力。
 * phase 对应系统调用旁的固定观察点，action 只选择有限错误或进展方式。
 * count 受独立原生模块上限限制，持续中断不能变成无限测试循环。
 * setHook 用于已经打开对象的真实文件变化，不接受伪造元数据结果。
 * resetFaults 负责撤销函数引用和剩余计数，资源关闭仍由拥有者负责。
 * 所有测试都从明确 native-tests 路径取得这个更窄的额外测试类型。
 */
interface FaultNative extends DarwinNative {
    setFault(phase: string, action: string, count: number): void;
    setHook(phase: string, callback: (fd: number) => void): void;
    resetFaults(): void;
}

/** 原生 fixture 始终先通过正式目录打开入口获得授权对象，再把真实对象交给行为断言；finally 只关闭本次目录并交外层清理自有文件，不通过伪造 FileHandle 或整数采用绕过任何原生身份检查。
 * 测试调用 read、entries、replace 和 remove 时仍执行生产相同的核心代码。
 * 目录关闭发生在文件清理之前，不把 rm 成功当作原生关闭证明。
 * 独立 fault 目标通过同一 helper 保持普通打开和后续操作顺序一致。
 * native 参数只允许这两个明确模块对象，不从环境变量选择替代实现。
 * finally 仍传播 close 错误，不用清理成功掩盖必要关闭失败。
 * 内层回调可以是同步或异步，原生 API 本身仍保持同步有限操作。
 */
async function nativeFixture(
    run: (directory: string, session: DarwinPrivateDirectory) => Promise<void> | void,
    native: DarwinNative = darwinNative(),
): Promise<void> {
    await fixture(async (directory) => {
        const session = native.openPrivateDirectory(directory, false);
        try { await run(directory, session); }
        finally { session.close(); }
    });
}

/** 错误断言检查固定英文代码与可选阶段，确保拒绝来自预期文件边界而不是不存在的模块、任意异常或测试准备错误；不匹配会让 node:test 保留原失败，不把错误吞成缺失或零字节结果。
 * 系统权限负例另外断言并非 ENOENT，因为真实拒绝不能变成凭据缺失。
 * 函数不记录正文和路径，只向 assert 返回类型与字段检查结果。
 * 代码和阶段来自原生结构化异常，不用源文件字符串作为行为证据。
 * phase 未指定时只比较代码，用于内核允许多个确切拒绝位置的场景。
 * 返回 false 会让 assert 报告不匹配，而非把另一类错误接受为预期。
 */
function failure(code: string, phase?: string): (error: unknown) => boolean {
    return (error) => error instanceof Error &&
        (error as NodeJS.ErrnoException).code === code &&
        (phase === undefined || (error as Error & { phase: string }).phase === phase);
}

/** 独立故障模块只能从本仓库明确 native-tests 产物位置加载，测试总在 finally 撤销调度以免影响下一条正常断言；它与正式模块是不同二进制，正式消费者没有环境变量或运行时切换测试产物的入口。
 * reset 先于目录关闭，避免预期故障继续污染 fixture 的必要资源释放。
 * 两个模块都使用真实 POSIX 和相同核心实现，不用内存文件系统替身。
 * 不在 Linux 调用此函数，因此缺少 Darwin Mach-O 不会被记成产品 RED。
 */
async function faultFixture(
    run: (directory: string, session: DarwinPrivateDirectory, native: FaultNative) => Promise<void> | void,
): Promise<void> {
    const native = createRequire(import.meta.url)("../../build/native-tests/veriq_private_files_fault.node") as FaultNative;
    try {
        await nativeFixture(async (directory, session) => {
            try { await run(directory, session, native); }
            finally { native.resetFaults(); }
        }, native);
    }
    finally { native.resetFaults(); }
}

/** 链接与非普通对象用真实文件系统成员验证 NOFOLLOW、NONBLOCK 和单链接约束，目录名字本身合法也不能授权 FIFO 或子目录；每个负例独立清除对象，后面的断言不会因先前残留意外命中别的拒绝分支。
 * 读取符号链接必须失败而不返回目标公开合成内容。
 * FIFO 的同步读取不能等待另一个写入进程，类型核验在打开后立即拒绝。
 * 硬链接使用同一当前用户文件，精确六百模式仍不够绕过单链接要求。
 * 所有成员都在本次唯一 fixture 内创建，不触碰系统目录或设备节点。
 * source 在建立第二硬链接后从合法样本变成明确不合法，拒绝原因固定为 file.private。
 * 目录和 FIFO 的名字都没有分隔符，所以不会提前在名称检查失败。
 * 最后枚举同一异常目录，不能通过过滤非普通项得到一个看似正常集合。
 * 符号链接只指向 fixture 内部文件，即使目标本身私有也必须拒绝链接。
 */
test("native members reject links, hardlinks, directories and FIFOs", mac, async () =>
    nativeFixture(async (directory, session) => {
        await writeFile(join(directory, "source"), "public", { mode: 0o600 });
        await symlink("source", join(directory, "symbolic"));
        assert.throws(() => session.read("symbolic", 64));
        await link(join(directory, "source"), join(directory, "hard"));
        assert.throws(() => session.read("source", 64), failure("DARWIN_PRIVATE_INVALID", "file.private"));
        await mkdir(join(directory, "directory"), { mode: 0o700 });
        assert.throws(() => session.read("directory", 64), failure("DARWIN_PRIVATE_INVALID", "file.private"));
        execFileSync("mkfifo", [join(directory, "fifo")]);
        assert.throws(() => session.read("fifo", 64), failure("DARWIN_PRIVATE_INVALID", "file.private"));
        assert.throws(() => session.entries(8192));
    }));

/** 目录祖先、最终目录链接以及过宽权限都以真实对象验证只读打开拒绝且不修复，合法创建只在明确 create=true 时发生；测试 harness 已解析系统临时根，因此拒绝不会来自 Mac 的合法系统 tmp 别名。
 * 链接祖先和链接最终目录分别覆盖逐级 openat，而不只检查最后路径字符串。
 * read-only 缺失目录保持不存在，不能通过 mkdir 把正常缺失改造成成功。
 * 原始宽权限在失败后保持，避免初始化操作悄悄收紧旧数据。
 * 新建多级目录成功后检查实际模式，证明创建路径确实连接原生实现。
 * target 先以正确模式创建，链接负例因此不依赖最终目录权限错误。
 * 宽模式负例发生在直接真实路径，拒绝必须定位 directory.private。
 * missing 在只读失败之后仍通过实际 readdir 确认没有被创建。
 * 随后的显式创建会话独立关闭，不复用前一次失败的描述符状态。
 */
test("native directory traversal rejects links and never repairs read-only paths", mac, async () =>
    fixture(async (directory) => {
        const native = darwinNative(), target = join(directory, "target"), alias = join(directory, "alias");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, alias);
        assert.throws(() => native.openPrivateDirectory(alias, false));
        assert.throws(() => native.openPrivateDirectory(join(alias, "child"), true));
        await chmod(target, 0o755);
        assert.throws(() => native.openPrivateDirectory(target, false), failure("DARWIN_PRIVATE_INVALID", "directory.private"));
        assert.equal((await stat(target)).mode & 0o777, 0o755);
        const missing = join(directory, "missing");
        assert.throws(() => native.openPrivateDirectory(missing, false), failure("ENOENT"));
        assert.equal((await readdir(directory)).includes("missing"), false);
        const created = native.openPrivateDirectory(join(missing, "nested"), true);
        try { assert.equal((await stat(join(missing, "nested"))).mode & 0o777, 0o700); }
        finally { created.close(); }
    }));

/** 有限参数负例在真实打开的私有目录上执行，因此失败必须来自名称或额度检查而非缺失 addon；UTF8 额度按字节计算，孤立代理码元也不能被 Node 替换成另一个合法文件名后继续访问。
 * 组件拒绝零字节、两类分隔符、点目录与超过二百五十五字节的名字。
 * 读取限额必须为正，枚举可为零但不能是负数、小数或非有限值。
 * 同一个有效会话随后仍能创建和读取正常文件，参数拒绝没有破坏其状态。
 * 正式 addon 的导出名单同时证明没有故障调度或原始描述符采用接口。
 * 字符串参数中的 UTF8 反例恰好超过字节上限，字符个数不能替代字节检查。
 * 数值数组包含 NaN 与 Infinity，简单大小比较不足以安全转换这些值。
 * 有效成员在所有参数错误之后才创建，说明错误没有静默关闭当前目录。
 * 公开导出比较不检查源码文本，而是观察实际加载的二进制对象。
 */
test("native component and numeric limits are finite and production exports stay narrow", mac, async () =>
    nativeFixture((directory, session) => {
        assert.deepEqual(Object.keys(darwinNative()), ["openPrivateDirectory"]);
        for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(256), "é".repeat(128)])
            assert.throws(() => session.read(name, 64), failure("DARWIN_PRIVATE_INVALID", "name"));
        assert.throws(() => session.read("\ud800", 64), failure("DARWIN_PRIVATE_INVALID", "argument.unicode"));
        for (const limit of [-1, 0.5, NaN, Infinity, 8193, Number.MAX_SAFE_INTEGER])
            assert.throws(() => session.entries(limit), failure("DARWIN_PRIVATE_INVALID", "argument.limit"));
        for (const limit of [0, -1, 0.5, NaN, Infinity, bytesLimit + 1])
            assert.throws(() => session.read("valid", limit), failure("DARWIN_PRIVATE_INVALID", "argument.limit"));
        writeFileSync(join(directory, "valid"), "ok", { mode: 0o600 });
        assert.equal(session.read("valid", 2).toString(), "ok");
    }));

/** 持有目录后父路径重命名和旧路径链接替换都不能把读写转到另一个目录，测试分别放置同名不同正文以观察实际锚定；新发布与删除只作用于原 inode，替代目录内容和成员集合保持不变。
 * 需要重命名的 anchor 是 fixture 内部子目录，清理仍限制在外层唯一根内。
 * 读取既有成员、替换新正文和退休成员全部使用同一个原生会话。
 * 不对生产输入调用 realpath，旧路径符号链接只是被攻击的名字而非新授权。
 * 替代目录保持独立公开合成正文，避免只检查调用返回值漏掉错误写入位置。
 * moved 与 other 是两个真实目录，无法通过同一个字符串路径碰巧返回相同内容。
 * replace 之后直接读取 moved 的物理成员，核对发布真正发生的位置。
 * remove 之后比较完整 moved 名字集合，不只依赖读取缺失错误。
 * other 的同名正文贯穿所有操作保持 substitute，证明锚点没有漂移。
 */
test("held directory operations survive parent rename and old-path link substitution", mac, async () =>
    fixture(async (directory) => {
        const anchor = join(directory, "anchor"), moved = join(directory, "moved"), other = join(directory, "other");
        await mkdir(anchor, { mode: 0o700 }); await mkdir(other, { mode: 0o700 });
        await writeFile(join(anchor, "value"), "original", { mode: 0o600 });
        await writeFile(join(other, "value"), "substitute", { mode: 0o600 });
        const session = darwinNative().openPrivateDirectory(anchor, false);
        try {
            await rename(anchor, moved); await symlink(other, anchor);
            assert.equal(session.read("value", 64).toString(), "original");
            session.replace("value", `.${randomUUID()}.tmp`, Buffer.from("updated"), 64);
            assert.equal(await readFile(join(moved, "value"), "utf8"), "updated");
            session.remove("value", 64);
            assert.deepEqual(await readdir(moved), []);
            assert.equal(await readFile(join(other, "value"), "utf8"), "substitute");
        } finally { session.close(); }
    }));

/** 枚举从零额度到实际边界使用同一目录反复观察，证明游标独立且限额外一个成员产生明确 overflow；上层 empty 与 containsOnly 也必须看见未知普通成员，不因先前扫描推进共享 offset 得到错误空结果。
 * 名字排序只用于比较完整集合，不用于截断或过滤未知项。
 * 三个普通成员具有正确模式，负例只来自扫描限额而非别的元数据拒绝。
 * 后续八千一百九十二额度的完整扫描不能受前一次溢出影响。
 * Vault 的未知临时名字保留 false，不被当成允许恢复的正式清单。
 * entries(2) 提前停止后 entries(3) 仍须观察全部成员，直接覆盖独立游标要求。
 * entries(0) 的 names 故意为空，overflow 才是非空事实。
 * 最大允许额度八千一百九十二也在实际会话执行，区别于只验证无效数字。
 * Vault 另开正式会话，验证该业务消费者同样连接原生枚举而非路径后备。
 */
test("bounded enumeration observes limit plus one and uses independent cursors", mac, async () =>
    nativeFixture(async (directory, session) => {
        for (const name of ["a", "b", "c"]) await writeFile(join(directory, name), name, { mode: 0o600 });
        assert.deepEqual(session.entries(0), { names: [], overflow: true });
        assert.equal(session.entries(2).overflow, true);
        assert.deepEqual(session.entries(3).names.sort(), ["a", "b", "c"]);
        assert.deepEqual(session.entries(8192).names.sort(), ["a", "b", "c"]);
        const files = await VaultFiles.acquire(directory);
        try { assert.equal(await files.empty(), false); assert.equal(await files.containsOnly(["profile.json"]), false); }
        finally { await files.close(); }
    }));

/** 日志 FD 由真实原生独占创建后显式映射到子进程槽四，子进程写入和 fsync 后父层仍从原 inode 定位读取；另一个未映射子进程核对 dev/ino，证明父数字没有被默默继承为同一个日志能力。
 * Node 的子槽四不必等于父层数字，测试只使用 stdio 数组明确建立映射。
 * File 强引用贯穿同步子进程真实退出和最终读取，没有依赖垃圾回收或临时 EOF。
 * 共享写偏移已经前进，父 read 仍必须返回完整开头内容。
 * 重复创建同名日志必须 EEXIST，原字节与原 File 不会被覆盖。
 * 子进程只使用公开合成正文，不运行 C1 协议或 Chrome。
 * 子进程退出状态与 stderr 一起断言，Node 命令准备错误不能冒充 FD 不可继承。
 * 未映射检查允许那个数字被子进程内部其他文件复用，但禁止相同 dev/ino。
 * 父层再次按物理文件读取正文，和 File.read 的定位结果交叉核对。
 * finally 在任一子进程断言失败时仍明确关闭拥有者。
 */
test("exclusive regular FD reaches only explicitly mapped CLI and remains parent-owned", mac, async () =>
    nativeFixture((directory, session) => {
        const file = session.createExclusive("cli.log");
        try {
            const info = fstatSync(file.fd);
            assert.equal(info.isFile(), true); assert.equal(info.mode & 0o777, 0o600);
            assert.equal(info.uid, process.getuid!()); assert.equal(info.nlink, 1);
            assert.throws(() => session.createExclusive("cli.log"), failure("DARWIN_PRIVATE_IO", "create.open"));
            const child = spawnSync(process.execPath, ["-e", 'const fs=require("node:fs");fs.writeSync(4,"public-cli-log");fs.fsyncSync(4);'], {
                stdio: ["ignore", "pipe", "pipe", "ignore", file.fd], encoding: "utf8",
            });
            assert.equal(child.status, 0, child.stderr);
            assert.equal(file.read(1024 * 1024).toString(), "public-cli-log");
            const identity = JSON.stringify({ dev: info.dev, ino: info.ino, fd: file.fd });
            const unrelated = spawnSync(process.execPath, ["-e", 'const fs=require("node:fs"),v=JSON.parse(process.argv[1]);try{const s=fs.fstatSync(v.fd);process.exit(s.dev===v.dev&&s.ino===v.ino?1:0);}catch(e){if(e.code!=="EBADF")throw e;}', identity], { encoding: "utf8" });
            assert.equal(unrelated.status, 0, unrelated.stderr);
            assert.equal(readFileSync(join(directory, "cli.log"), "utf8"), "public-cli-log");
        } finally { file.close(); }
    }));

/** 已交付 File 的关闭责任独立于目录会话，目录关闭和原日志改名之后父层仍应从同 inode 读取；旧名字换入的新文件必须保持另一份内容，不能让 File.read 按路径重新打开一个替代日志。
 * 使用二百五十五字节 ASCII 名字覆盖原生允许的单组件正边界。
 * File 强引用在整个观察期间保持，关闭目录不依赖 GC 决定日志存活。
 * 原 inode 改名后仍为单链接，未绕过 nlink 要求。
 * 已关闭 Directory 的后续读取必须明确拒绝，不自动恢复路径授权。
 * 外层 fixture 最后再次 close 目录，顺便覆盖幂等关闭。
 * retained 与 substitute 分别写进两个不同 inode，比较可以发现按旧路径重开。
 * 父层写入使用最初交付的 File.fd，未重新取得路径授权。
 * 两个文件最终都在同一个唯一 fixture 内，改名不扩大清理范围。
 * File.close 无论中途哪个断言失败都会执行，避免泄漏借用的原数字。
 */
test("a delivered file survives directory close and keeps its inode after name replacement", mac, async () =>
    nativeFixture((directory, session) => {
        const name = "x".repeat(255), file = session.createExclusive(name);
        try {
            renameSync(join(directory, name), join(directory, "saved-original"));
            writeFileSync(join(directory, name), "substitute", { mode: 0o600 });
            session.close();
            writeSync(file.fd, "retained");
            assert.equal(file.read(64).toString(), "retained");
            assert.equal(readFileSync(join(directory, name), "utf8"), "substitute");
            assert.throws(() => session.read(name, 64), failure("DARWIN_PRIVATE_INVALID", "descriptor.closed"));
        } finally { file.close(); }
    }));

/** 重复关闭在内核已经复用同一个数字后仍不得触碰新文件，独立故障目标还验证 close 报错时先撤销状态；测试同步打开最小空闲描述符以确定复用，而非只断言第二次 close 没有抛异常。
 * 首次 close 故障发生在真实内核关闭之后，必须仍让 fd getter 拒绝。
 * 后开的文件由 Node 自己负责关闭，不能转交原生旧对象。
 * 写入和 fstat 验证新文件确实仍活，避免仅看返回码漏掉误关。
 * 故障计划在 finally 清空，目录收尾不继承预期 close 错误。
 * 内核按最小空闲数字分配的新文件必须确实复用旧值，避免测试没有触及复用场景。
 * getter 在故障后立即失败，证明对象状态撤销先于向宿主报告错误。
 * 新文件大小十字节只来自仍打开的替代描述符写入。
 * Node closeSync 仅关闭它自己创建的新拥有者，不借用原对象完成清理。
 */
test("close revokes ownership before errors and repeated close preserves a reused descriptor", mac, async () =>
    faultFixture((directory, session, native) => {
        const file = session.createExclusive("first");
        const original = file.fd;
        native.setFault("close", "error", 1);
        assert.throws(() => file.close(), failure("DARWIN_PRIVATE_IO", "close"));
        assert.throws(() => file.fd, failure("DARWIN_PRIVATE_INVALID", "descriptor.closed"));
        const replacement = openSync(join(directory, "reused"), "wx+", 0o600);
        try {
            assert.equal(replacement, original);
            file.close();
            writeSync(replacement, "still-open");
            assert.equal(fstatSync(replacement).size, 10);
        } finally { closeSync(replacement); file.close(); }
    }));

/** 正式 Records 保留专用 staging 语法和原扫描限额，残缺临时正文只核私有元数据而不解析状态；默认 names 仍拒绝 staging，未知 controlled-stop 名字和非法 UTF8/JSON 也不能变成可信历史。
 * 最长一百字符 Attempt 形成的一百四十二字节 staging 必须保持兼容。
 * 临时成员计入和正式记录相同扫描额度，不在过滤后才计算。
 * interrupted 只定位那个 Attempt，不接受临时正文中的 STOPPED 声明。
 * 正式读取使用固定六万五千五百三十六字节限额。
 * 所有失败之后原字节保留，观察过程不删除历史或修权限。
 * names 默认入口拒绝 staging，与 journalNames 的专用接受入口分别断言。
 * 同一扫描额度只允许一个时，正式与临时两项必须产生超限。
 * 孤立 controlled-stop 名字明确不在 B 的历史白名单中。
 * 临时残缺 JSON 仍保留原字节，成功识别 interrupted 不代表解析或授权它。
 */
test("formal Records preserves staging limits, strict parsing and unknown-history rejection", mac, async () =>
    fixture(async (directory) => {
        const id = "a".repeat(100), staging = `${id}.json.${randomUUID()}`;
        await writeFile(join(directory, staging), '{"state":', { mode: 0o600 });
        await writeFile(join(directory, "normal.json"), '{"state":"ALLOCATED"}', { mode: 0o600 });
        const records = await ProcessRecords.open(directory); assert.ok(records);
        try {
            await assert.rejects(records.names(2), /PROCESS_RECORD_NAME_INVALID/);
            await assert.rejects(records.journalNames(1), /PROCESS_RECORD_LIMIT_OR_TYPE/);
            const observed = await records.journalNames(2);
            assert.deepEqual(observed.names, ["normal.json"]); assert.deepEqual([...observed.interrupted], [id]);
            await writeFile(join(directory, "bad.json"), Buffer.from([0xff]), { mode: 0o600 });
            await assert.rejects(records.read("bad.json", 65536));
            await writeFile(join(directory, "unknown.controlled-stop.json"), "{}", { mode: 0o600 });
            await assert.rejects(records.names(8192), /PROCESS_RECORD_NAME_INVALID/);
            assert.equal(await readFile(join(directory, staging), "utf8"), '{"state":');
        } finally { await records.close(); }
    }));

/** Vault 的原有分层读取额度通过正式消费者验证，已有小成员越界不能因原生两兆能力变成可读；原生 replace 又单独证明已有额度不会误限制新正文，两个参数概念必须保持独立。
 * device 六万五千五百三十六与 local-secrets 一兆分别覆盖较小额度。
 * profile 的两兆硬上限在读取和新写入两侧都受检查。
 * 删除真实不存在成员仍幂等，其他读取错误不能映射 undefined。
 * 未知临时普通成员让 containsOnly 返回 false，空目录判断同样保留非空事实。
 * 大 Buffer 只用于本次 fixture，测试完成由 finally 删除，不留本地 cache。
 * 每个越界成员读后删除，再准备下一用途，避免早期残留改变后续拒绝原因。
 * 小原值配 existingLimit512 与两兆新正文的组合直接验证参数分离。
 * 已写大成员再用65536已有额度替换时必须拒绝，不能顺手修复越界旧文件。
 * unknown 临时成员只影响 containsOnly，未放进保险库正式用途白名单。
 */
test("formal Vault preserves layered limits and native replacement separates existing limit", mac, async () =>
    nativeFixture(async (directory, session) => {
        const files = await VaultFiles.acquire(directory);
        try {
            for (const [name, size] of [["device.json", 65537], ["local-secrets.json", 1024 * 1024 + 1], ["profile.json", bytesLimit + 1]] as const) {
                await writeFile(join(directory, name), Buffer.alloc(size, 65), { mode: 0o600 });
                await assert.rejects(files.read(name), failure("DARWIN_PRIVATE_INVALID", "file.private"));
                await rm(join(directory, name));
            }
            await assert.rejects(files.write("profile.json", "a".repeat(bytesLimit + 1)), /VAULT_ENVELOPE_LIMIT/);
            assert.equal(await files.read("profile.json"), undefined); await files.remove("profile.json");
            await writeFile(join(directory, "device.json"), "small", { mode: 0o600 });
            session.replace("device.json", `.${randomUUID()}.tmp`, Buffer.alloc(bytesLimit, 66), 512);
            assert.equal(session.read("device.json", bytesLimit).length, bytesLimit);
            assert.throws(() => session.replace("device.json", `.${randomUUID()}.tmp`, Buffer.from("new"), 65536), failure("DARWIN_PRIVATE_INVALID", "file.private"));
            await rm(join(directory, "device.json"));
            await writeFile(join(directory, ".old.tmp"), "public", { mode: 0o600 });
            assert.equal(await files.containsOnly(["profile.json"]), false);
        } finally { await files.close(); }
    }));

/** 只读失败用真实宽权限成员前后的字节、模式与名字集合比较，证明拒绝不会自动收紧权限、改写内容或清理残留；错误 uid 另在本次专用标记成员中使用 sudo 改 owner 并在 finally 恢复，绝不修改系统目录或账号。
 * 当前用户无法打开另一个 uid 的六百模式文件时 EACCES 也是正确失败关闭。
 * 权限拒绝必须不是 ENOENT，否则业务读取可能把已有秘密当成缺失。
 * 原 owner 恢复先于 fixture 删除，CI 失败也不能留下 root 拥有者残留。
 * 这里只对唯一 mkdtemp 下固定标记名字执行特权命令。
 * 宽模式快照在 sudo 之前完成，普通只读不变性与真实 uid 拒绝分别可观察。
 * root uid 与当前 runner uid 明确不同，不能在 root 执行中误把正常样本当错 owner。
 * 恢复后再次原生读取完整正文，证明特权 fixture 已回到可检查状态。
 * 没有创建账号、修改全局策略或为测试更改任何系统目录的拥有者。
 */
test("read-only rejection preserves bytes and modes and rejects a real wrong-owner member", mac, async () =>
    nativeFixture(async (directory, session) => {
        const path = join(directory, "owned-wrong-uid.json");
        await writeFile(path, "public-owner-fixture", { mode: 0o600 });
        await chmod(path, 0o644);
        const before = { bytes: await readFile(path), mode: (await stat(path)).mode, names: await readdir(directory) };
        assert.throws(() => session.read("owned-wrong-uid.json", 64), failure("DARWIN_PRIVATE_INVALID", "file.private"));
        assert.deepEqual({ bytes: await readFile(path), mode: (await stat(path)).mode, names: await readdir(directory) }, before);
        await chmod(path, 0o600); assert.notEqual(process.getuid!(), 0);
        execFileSync("sudo", ["-n", "chown", "0", path]);
        try { assert.throws(() => session.read("owned-wrong-uid.json", 64), (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code !== "ENOENT"); }
        finally { execFileSync("sudo", ["-n", "chown", String(process.getuid!()), path]); }
        assert.equal(session.read("owned-wrong-uid.json", 64).toString(), "public-owner-fixture");
    }));

/** 每个替换阶段都在同一真实实现中单独注入固定 EIO，发布前必须保留旧正文且仅清本次临时 inode，发布后必须保留新正文并明确 COMMIT_UNCONFIRMED；目录内另一个 staging 始终不属于当前清理授权。
 * write、文件刷新和 rename 失败发生在正式内容发布之前。
 * 父目录刷新与必要 close 失败发生在内核 rename 成功之后。
 * 断言同时检查异常代码、阶段、最终字节和完整名字集合。
 * 没有自动重试事务或把内容可读当成持久提交成功。
 * 每条参数化用例使用独立 fixture，前一阶段错误不会污染后续阶段。
 * unrelated-staging 的名字和正文在错误前后都保持，不能通过全面清目录达成无残留。
 * 发布后的 value 必须是 new，旧值出现反而说明存在不允许的回滚。
 * 发布前的 value 必须是 old，拒绝返回也不能掩盖提前写入正式成员。
 * 精确名字集合要求本次临时文件已清理或已发布，不接受额外未知残留。
 */
for (const [phase, published] of [
    ["replace.write", false], ["replace.file-sync", false], ["replace.rename", false],
    ["replace.directory-sync", true], ["replace.close", true],
] as const) {
    test(`replace failure preserves the publication contract: ${phase}`, mac, async () =>
        faultFixture((directory, session, native) => {
            writeFileSync(join(directory, "value"), "old", { mode: 0o600 });
            writeFileSync(join(directory, "unrelated-staging"), "untouched", { mode: 0o600 });
            const temporary = `.${randomUUID()}.tmp`;
            native.setFault(phase, "error", 1);
            assert.throws(() => session.replace("value", temporary, Buffer.from("new"), 64),
                failure(published ? "COMMIT_UNCONFIRMED" : "DARWIN_PRIVATE_IO", phase));
            assert.equal(readFileSync(join(directory, "value"), "utf8"), published ? "new" : "old");
            assert.equal(readFileSync(join(directory, "unrelated-staging"), "utf8"), "untouched");
            assert.deepEqual(session.entries(3).names.sort(), ["unrelated-staging", "value"]);
        }));
}

/** 退休故障分别覆盖 unlink 前、目录刷新和必要 close，只有内核实际删除成功之后才要求不确定代码；发布后不存在仍不能升级为持久成功，发布前错误也不能删除旧文件或重写其字节。
 * 每个错误都有精确 remove 阶段，不会意外命中测试准备的打开步骤。
 * 删除后用原目录真实名字集合确认内容不被重新创建回滚。
 * 删除前仍可从同一原生会话读取原始正文。
 * 故障状态在 fixture 关闭前撤销，资源收尾不继承预期错误。
 * removed 布尔来自明确参数表，不从读取失败或异常消息猜测是否提交。
 * 删除前仍通过原生 read 核旧正文，证明未偷偷截断或覆盖。
 * 删除后通过实际枚举观察空集合，异常仍必须是不确定代码。
 * remove.close 的注入发生在真实关闭后，不把未释放 fd 作为测试替身。
 */
for (const [phase, removed] of [
    ["remove.unlink", false], ["remove.directory-sync", true], ["remove.close", true],
] as const) {
    test(`remove failure preserves the retirement contract: ${phase}`, mac, async () =>
        faultFixture((directory, session, native) => {
            writeFileSync(join(directory, "value"), "old", { mode: 0o600 });
            native.setFault(phase, "error", 1);
            assert.throws(() => session.remove("value", 64),
                failure(removed ? "COMMIT_UNCONFIRMED" : "DARWIN_PRIVATE_IO", phase));
            assert.deepEqual(session.entries(1).names, removed ? [] : ["value"]);
            if (!removed) assert.equal(session.read("value", 64).toString(), "old");
        }));
}

/** 普通日志独占创建在文件或父目录刷新失败时不能交付 File，测试要求自身新成员被确切清理且既有目录仍可用；这两个失败不能靠稍后垃圾回收关闭或可见空文件冒充交付成功。
 * 失败只影响新建名字，先前存在的普通成员字节保持不变。
 * 目录刷新失败后清理还需要自身目录刷新，任何不确定都必须传播。
 * 每个阶段独立运行，故障目标与生产同一创建核心路径。
 * 成功日志 FD 的真实子进程交付由前面的独立用例检查。
 * existing 成员在新建之前存在，因此错误清理不能删除整个目录达成空结果。
 * 文件刷新与目录刷新是两个不同阶段，各自在参数化用例中触发一次。
 * native API 抛出而非返回 File，父层无法意外使用未完成刷新日志。
 * 失败后原有成员仍从同一会话读取，目录拥有者没有被一并撤销。
 */
for (const phase of ["create.file-sync", "create.directory-sync"]) {
    test(`exclusive file is not delivered before required durability: ${phase}`, mac, async () =>
        faultFixture((directory, session, native) => {
            writeFileSync(join(directory, "existing"), "old", { mode: 0o600 });
            native.setFault(phase, "error", 1);
            assert.throws(() => session.createExclusive("new-log"), failure("DARWIN_PRIVATE_IO", phase));
            assert.deepEqual(session.entries(1).names, ["existing"]);
            assert.equal(session.read("existing", 64).toString(), "old");
        }));
}

/** 短写、短读与一次 EINTR 使用真实文件完成剩余字节，持续中断和零进展则在固定上限后失败；测试分别核最终完整正文或旧值保留，不能通过放宽长度断言、睡眠或忽略异常获得通过。
 * short 动作把本次真实系统请求收紧为一字节，之后继续正式进展循环。
 * 一次 EINTR 不吞后续系统失败，持续六十四次中断必须终止。
 * 零写在发布之前失败并清理本次临时 inode。
 * 零读在原预期长度前遇到 EOF，必须拒绝部分正文。
 * 所有路径都使用有界公开合成内容，不做无限内存或计时压力测试。
 * 两次成功写入同一名字同时覆盖首次创建与已有成员替换。
 * 六十四次 EINTR 达到原生固定阈值，断言精确 write 阶段而非超时。
 * 零读与零写在不同阶段拒绝，不能用同一泛化错误掩盖部分返回。
 * 最终名字集合只有 value，失败没有留下无主临时成员。
 */
test("short I/O and bounded EINTR preserve complete bytes and reject zero progress", mac, async () =>
    faultFixture((directory, session, native) => {
        for (const action of ["short", "eintr"]) {
            native.setFault("replace.write", action, 1);
            session.replace("value", `.${randomUUID()}.tmp`, Buffer.from("complete"), 64);
            native.setFault("read", action, 1);
            assert.equal(session.read("value", 64).toString(), "complete");
        }
        native.setFault("replace.write", "eintr", 64);
        assert.throws(() => session.replace("value", `.${randomUUID()}.tmp`, Buffer.from("new"), 64), failure("DARWIN_PRIVATE_IO", "replace.write"));
        native.setFault("replace.write", "zero", 1);
        assert.throws(() => session.replace("value", `.${randomUUID()}.tmp`, Buffer.from("new"), 64), failure("DARWIN_PRIVATE_INVALID", "replace.write-zero"));
        native.setFault("read", "zero", 1);
        assert.throws(() => session.read("value", 64), failure("DARWIN_PRIVATE_INVALID", "read.short"));
        native.resetFaults();
        assert.equal(readFileSync(join(directory, "value"), "utf8"), "complete");
        assert.deepEqual(session.entries(1).names, ["value"]);
    }));

/** 读取期间的真实增长、截断和同长度覆盖都在已打开 inode 上执行，原生不得返回半段或变化后的正文；名字替换则只允许读取原 inode 或明确变化拒绝，绝不转向新名字的替代字节。
 * 观察点位于 fstat 后和正文读完后，覆盖读取前后元数据检查。
 * 修改通过同步文件系统操作发生在同一次原生调用内，不依赖竞争时序或睡眠。
 * 变化后的文件保留供测试核对，读取失败不能自动回滚内容。
 * 新名字替代正文与旧正文不同，因此错误路径重开会被实际值比较发现。
 * overwrite 与原文同为八字节，因此只比较长度的实现不能满足这条用例。
 * 增长与截断分别改变上下边界，避免只覆盖单一方向变化。
 * 替换名字后只有 original 或明确 read.changed 合法，substitute 永远不合法。
 * 读完后追加覆盖尾字节检查，不能只核读取开始时的长度。
 */
test("reads reject real growth, truncation and overwrite and retain the opened inode", mac, async () =>
    faultFixture((directory, session, native) => {
        const path = join(directory, "value");
        for (const change of [() => appendFileSync(path, "+"), () => truncateSync(path, 1), () => writeFileSync(path, "changed!")]) {
            writeFileSync(path, "original", { mode: 0o600 });
            native.setHook("read.after-stat", change);
            assert.throws(() => session.read("value", 64), (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "DARWIN_PRIVATE_INVALID");
        }
        writeFileSync(path, "original");
        native.setHook("read.after-stat", () => {
            renameSync(path, join(directory, "saved"));
            writeFileSync(path, "substitute", { mode: 0o600 });
        });
        let result: string | undefined;
        try { result = session.read("value", 64).toString(); }
        catch (error) { assert.equal(failure("DARWIN_PRIVATE_INVALID", "read.changed")(error), true); }
        if (result !== undefined) assert.equal(result, "original");
        assert.equal(readFileSync(path, "utf8"), "substitute");
        writeFileSync(path, "original");
        native.setHook("read.after-bytes", () => appendFileSync(path, "+"));
        assert.throws(() => session.read("value", 64), failure("DARWIN_PRIVATE_INVALID", "read.changed"));
    }));

/** 发布前清理必须按本次临时 inode 身份决定是否删除，测试在真实文件刷新观察点把临时名字换成另一个文件后再注入失败；陌生替代者和旧 staging 都必须保留，原正式正文也不能被改动。
 * 原本自有 inode 被移动到 fixture 内另一个名字，不删除它来掩盖身份变化。
 * 临时替代正文是公开标记，最后读取实际路径以确认没有误删。
 * 故障发生在 rename 前，因此正式目标仍必须是旧内容。
 * 该测试不假定 POSIX 能隔离同 uid 任意恶意代码，只核明确的失败清理范围。
 * owned-saved 保留原临时 inode 及已写新正文，便于核对当前替代者确实不同。
 * 本次失败发生在 file-sync 观察点，尚无正式 rename 成功事实。
 * temporary 真实路径中的 foreign 字节必须在清理后仍可读取。
 * 最终由 fixture 清理两份公开对象，正式失败清理没有越权移除任何一份。
 */
test("failed replacement cleanup never deletes a foreign temporary-name replacement", mac, async () =>
    faultFixture((directory, session, native) => {
        const temporary = `.${randomUUID()}.tmp`;
        writeFileSync(join(directory, "value"), "old", { mode: 0o600 });
        native.setHook("replace.file-sync", () => {
            renameSync(join(directory, temporary), join(directory, "owned-saved"));
            writeFileSync(join(directory, temporary), "foreign", { mode: 0o600 });
        });
        native.setFault("replace.file-sync", "error", 1);
        assert.throws(() => session.replace("value", temporary, Buffer.from("new"), 64), failure("DARWIN_PRIVATE_IO", "replace.file-sync"));
        assert.equal(readFileSync(join(directory, temporary), "utf8"), "foreign");
        assert.equal(readFileSync(join(directory, "value"), "utf8"), "old");
        assert.equal(readFileSync(join(directory, "owned-saved"), "utf8"), "new");
    }));

/** ACL fixture 只用系统 chmod 在本次唯一目录或普通成员上设置合成条目，所有命令都以参数数组执行且 finally 清掉自有测试 ACL；生产实现始终只查询，不调用这个 helper 修复真实档案或系统目录。
 * ACL 的原始 ls 输出用于同一对象前后比较，不把模式位当成 ACL 内容。
 * chmod -N 的目标来自 fixture 固定路径，不能由产品输入或环境配置选择。
 * 公开权限条目仅包含测试身份和公开合成内容，没有真实凭据。
 * 未能准备 ACL 会让测试真实失败，不跳过后宣称 Mac 边界通过。
 */
function acl(path: string, entry?: string): void {
    execFileSync("/bin/chmod", entry ? ["+a", entry, path] : ["-N", path]);
}
/** ACL 快照直接调用系统 ls 的扩展权限列出功能，以原始输出比较同一测试对象是否被原生只读拒绝路径修改；名字与时间在同次检查内保持，因此无需解析或丢弃任何实际条目来制造相等结果。
 * 参数数组不经过 shell，路径中的特殊字符不会变成命令。
 * 输出仅来自公开合成 fixture，不包含真实凭据正文。
 * 未知命令失败直接让测试失败，不返回空字符串冒充没有 ACL。
 */
function aclSnapshot(path: string): string {
    return execFileSync("/bin/ls", ["-lde", path], { encoding: "utf8" });
}

/** 精确七百模式的目录仍可能由扩展 ACL 授予其他身份访问，因此真实 ALLOW 和 only_inherit ALLOW 都必须拒绝，失败前后 ACL 与模式保持原状；只读 Records.open 同样不能把拒绝解释成目录缺失。
 * only_inherit 当前不授予目录自身访问，但可能授权后续新建临时秘密成员。
 * 两个负例分别创建新目录，不在测试之间遗留授予条目。
 * ACL 快照来自系统实际列表，比较时不自动清空以获得通过。
 * 清理仅在断言全部结束后 finally 执行，不是正式消费路径的一部分。
 * 测试目录的祖先没有被修改，用户 home 和系统 tmp ACL 保持。
 */
for (const entry of ["everyone allow search", "everyone allow read,file_inherit,directory_inherit,only_inherit"]) {
    test(`private directory rejects extended grants unchanged: ${entry}`, mac, async () =>
        fixture(async (directory) => {
            acl(directory, entry);
            try {
                assert.equal((await stat(directory)).mode & 0o777, 0o700);
                const before = aclSnapshot(directory);
                assert.throws(() => darwinNative().openPrivateDirectory(directory, false), failure("DARWIN_PRIVATE_INVALID", "acl.allow"));
                await assert.rejects(ProcessRecords.open(directory), failure("DARWIN_PRIVATE_INVALID", "acl.allow"));
                assert.equal(aclSnapshot(directory), before);
            } finally { acl(directory); }
        }));
}

/** 普通六百文件上的 ACL ALLOW 即使授予当前 owner 也属于本有限政策拒绝集合，正式 Vault 不能把检查错误变成 undefined；同一 inode 的正文、模式和 ACL 在失败前后完整比较，证明读取不修复权限。
 * everyone grant 覆盖真实额外读取权限，owner grant 覆盖无需解析 principal 的保守策略。
 * File 先以六百模式创建，再由系统真实 ACL API 设置条目。
 * directory 会话在添加成员 ACL 之前已打开，成员读取仍必须每次独立核验。
 * 最终清理先移除当前测试文件的 ACL，避免 deny 或继承状态污染外层 rm。
 */
test("private member grants including owner ALLOW fail unchanged through native and Vault", mac, async () =>
    nativeFixture(async (directory, session) => {
        const path = join(directory, "profile.json"), owner = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
        await writeFile(path, "public-acl", { mode: 0o600 });
        const files = await VaultFiles.acquire(directory);
        try {
            for (const entry of ["everyone allow read", `user:${owner} allow read`]) {
                acl(path, entry);
                try {
                    assert.equal((await stat(path)).mode & 0o777, 0o600);
                    const before = { bytes: await readFile(path), mode: (await stat(path)).mode, acl: aclSnapshot(path) };
                    assert.throws(() => session.read("profile.json", 64), failure("DARWIN_PRIVATE_INVALID", "acl.allow"));
                    await assert.rejects(files.read("profile.json"), failure("DARWIN_PRIVATE_INVALID", "acl.allow"));
                    assert.deepEqual({ bytes: await readFile(path), mode: (await stat(path)).mode, acl: aclSnapshot(path) }, before);
                } finally { acl(path); }
            }
        } finally { await files.close(); acl(path); }
    }));

/** 无扩展 ACL 与完整 DENY-only 列表都应被有限政策接受，测试在真实目录和文件上分别设置拒绝删除条目并继续读取；继承 DENY 同样不增加其他身份权限，读取仍使用实际公开 API 而不是模式位推断。
 * 对目录添加 file_inherit 后创建的成员会带真实 inherited DENY。
 * DENY 可能阻止后续删除，因此 finally 先移除所有自有对象条目再交 fixture 清理。
 * 读取成功只表示权限政策允许，不承诺该 DENY 下的每种写入操作都能成功。
 * 原始 ACL 不被原生实现清空，成功后系统列表仍应带 deny 记录。
 * 模式与 owner 检查继续生效，DENY 不用于放宽 Unix 私有要求。
 */
test("absent ACL and inherited deny-only ACL retain the private file boundary", mac, async () =>
    fixture(async (directory) => {
        acl(directory);
        let session = darwinNative().openPrivateDirectory(directory, false); session.close();
        acl(directory, "everyone deny delete,file_inherit,directory_inherit");
        const path = join(directory, "value");
        try {
            await writeFile(path, "public-deny", { mode: 0o600 });
            session = darwinNative().openPrivateDirectory(directory, false);
            try {
                assert.match(aclSnapshot(path), /deny/);
                assert.equal(session.read("value", 64).toString(), "public-deny");
                assert.equal(session.entries(1).overflow, false);
                assert.match(aclSnapshot(path), /deny/);
            } finally { session.close(); }
        } finally { acl(path); acl(directory); }
    }));

/** 目录持有后出现继承 ALLOW 时，新临时文件必须在任何正文写入之前被拒绝，测试在真实 acl 查询观察点检查该新 inode 长度仍为零；旧正式内容保留，本次临时成员只按自有身份清理。
 * 目录会话先打开，再添加 only_inherit grant，覆盖后续新建文件继承的风险。
 * 第一次查询针对已有正式成员，第二次针对本次独占临时 inode。
 * 观察回调只读 fstat，不伪造 ACL 或元数据检查结果。
 * 拒绝发生在写入正文前，不能仅靠提交前回滚掩盖曾暴露新秘密。
 * finally 清除目录测试 ACL，正式实现本身没有修复路径。
 */
test("newly inherited ALLOW on a temporary file fails before any secret write", mac, async () =>
    faultFixture((directory, session, native) => {
        const path = join(directory, "value");
        writeFileSync(path, "old", { mode: 0o600 });
        acl(directory, "everyone allow read,file_inherit,only_inherit");
        let observed = false;
        try {
            native.setHook("acl.get", () => native.setHook("acl.get", (fd) => {
                assert.equal(fstatSync(fd).size, 0); observed = true;
            }));
            assert.throws(() => session.replace("value", `.${randomUUID()}.tmp`, Buffer.from("public-new-secret"), 64), failure("DARWIN_PRIVATE_INVALID", "acl.allow"));
            assert.equal(observed, true);
            assert.equal(readFileSync(path, "utf8"), "old");
            assert.deepEqual(session.entries(1).names, ["value"]);
        } finally { acl(directory); }
    }));

/** ACL 查询、验证、迭代、tag 与释放都各自注入真实调用旁的阶段错误，任何错误不能被当成空 ACL 或成员缺失；测试用 deny-only 对象确保成功查询确实返回可迭代列表，不因缺少 ACL 而跳过被测分支。
 * 正式 addon 没有 setFault，独立模块仍执行同一公开 ACL 实现。
 * 释放阶段在真实 acl_free 后注入，验证异常清理不会再次释放同一对象。
 * 每条错误检查固定代码与精确阶段，而不是任意异常都可通过。
 * 清除故障后同一会话可以再次读取，文件正文和 ACL 未被失败路径修改。
 * 最终撤销 ACL 仅属于自有测试 fixture 收尾。
 */
for (const phase of ["acl.get", "acl.valid", "acl.entry", "acl.tag", "acl.free"]) {
    test(`ACL inspection failure stays closed: ${phase}`, mac, async () =>
        faultFixture((directory, session, native) => {
            const path = join(directory, "value");
            writeFileSync(path, "public", { mode: 0o600 }); acl(path, "everyone deny delete");
            try {
                native.setFault(phase, "error", 1);
                assert.throws(() => session.read("value", 64), failure("DARWIN_PRIVATE_IO", phase));
                native.resetFaults();
                assert.equal(session.read("value", 64).toString(), "public");
                assert.match(aclSnapshot(path), /deny/);
            } finally { acl(path); }
        }));
}

/** ACL 属性缺失和真实空列表是两种独立表示，测试目标在存在且已核验的普通成员上分别选择返回；缺失 ENOENT 必须仅在内部消化，查询拒绝或未知空返回则必须抛 ACL 错误而非凭据缺失。
 * acl-empty 动作调用真实 acl_init(0)，随后执行生产相同的 acl_valid 和 Darwin 迭代规则。
 * acl-absent 动作只替换这一轮属性查询返回，文件本身始终存在且具有六百模式。
 * acl-denied 返回真实错误编号 EACCES，不能因查询为空就当作没有 ACL。
 * acl-unknown 没有 errno，仍保持失败关闭而不构造 ENOENT。
 * 第二轮读取撤销动作后重新调用实际宿主 ACL API，证明文件没有被失败路径修改。
 * 测试只验证独立调度边界，不把模拟属性表示声称为宿主文件系统实际返回类型。
 * 正式二进制不包含这四个动作分支，导出隔离由实际加载断言检查。
 * 真实默认无 ACL 与继承 DENY 样本在另一个无注入用例里直接检查。
 */
for (const [action, accepted] of [
    ["acl-absent", true], ["acl-empty", true], ["acl-denied", false], ["acl-unknown", false],
] as const) {
    test(`ACL property representation stays separate from file existence: ${action}`, mac, async () =>
        faultFixture((directory, session, native) => {
            writeFileSync(join(directory, "value"), "public", { mode: 0o600 });
            native.setFault("acl.get", action, 1);
            if (accepted) assert.equal(session.read("value", 64).toString(), "public");
            else assert.throws(() => session.read("value", 64), failure("DARWIN_PRIVATE_ACL", "acl.get"));
            native.resetFaults();
            assert.equal(session.read("value", 64).toString(), "public");
        }));
}

/** 保险库正常路径直接调用已有会话的空目录判断、原子写入、读取和退休接口，确认后续实现必须连接真实业务消费者；测试仅使用公开合成正文，不启动系统凭据库、进程监督或 Chrome，也不依赖任何原生替身。
 * acquire 操作的目标是已存在的私有目录，避免用缺失目录解释当前 Mac 的打开失败。
 * 初始 empty 检查观察新目录，写入后 containsOnly 则观察同一会话内已发布的正式成员。
 * profile.json 是当前保险库白名单成员，不使用测试特权绕过用途名称或文件容量限制。
 * write 完成之后才读取完整合成字符串，后续 native 实现必须保持该调用的持久提交语义。
 * containsOnly 的允许集合仅含这次写入的名字，意外留下的临时成员不能被测试忽略。
 * remove 之后再次检查 empty，要求已发布成员确实退休，而非只让读取接口返回缺失。
 * finally 在写入、读取和删除任一阶段失败时关闭目录会话，保持父层明确拥有描述符生命周期。
 * 这里不注入故障或宣称完整边界覆盖，后续真实 Mac GREEN 后仍须补齐有界读取和提交异常矩阵。
 */
test("VaultFiles acquires a private directory and commits and removes a normal member", async () =>
    fixture(async (directory) => {
        const files = await VaultFiles.acquire(directory);
        try {
            assert.equal(await files.empty(), true);
            await files.write("profile.json", '{"fixture":"public-mac-normal"}');
            assert.equal(await files.read("profile.json"), '{"fixture":"public-mac-normal"}');
            assert.equal(await files.containsOnly(["profile.json"]), true);
            await files.remove("profile.json");
            assert.equal(await files.empty(), true);
        } finally {
            await files.close();
        }
    }));
