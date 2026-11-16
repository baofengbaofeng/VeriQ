/** 最后一个公开 Reporter 只处理 Playwright 内建 JSON 中明确的控制端点配置字段，保留所有结果与附件结构；每次发布前后均进行有界完整残留扫描，主机再独立验证磁盘文件，CLI 退出码从不充当保密或交付许可。 */
import type { FullConfig, FullResult, Reporter } from "@playwright/test/reporter";
import { constants, type Stats } from "node:fs";
import { open, lstat, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const LIMIT = 32 * 1024 * 1024,
    MARKER = "VERIQ_PRIVATE_ENDPOINT",
    FAILURE = "REPORT_PRIVACY_UNCONFIRMED";
type ObjectValue = Record<string, unknown>;
function fail(): never {
    throw new Error(FAILURE);
}
function object(value: unknown): value is ObjectValue {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(a: Stats, b: Stats) {
    return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
}
function stable(a: Stats, b: Stats) {
    return same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function pathAllowed(path: string) {
    if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) fail();
}
function endpointsAllowed(endpoints: readonly string[]) {
    if (
        endpoints.length < 1 ||
        endpoints.length > 64 ||
        new Set(endpoints).size !== endpoints.length
    )
        fail();
    for (const endpoint of endpoints) {
        if (typeof endpoint !== "string" || endpoint.length < 16 || endpoint.length > 4096) fail();
        const url = new URL(endpoint);
        if (
            !["ws:", "wss:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname.length < 17
        )
            fail();
    }
}
function forms(endpoints: readonly string[]) {
    const values = new Set<string>();
    for (const endpoint of endpoints) {
        for (const value of [endpoint, new URL(endpoint).pathname.replace(/^\//, "")]) {
            values.add(value);
            values.add(encodeURI(value));
            values.add(encodeURIComponent(value));
            values.add(JSON.stringify(value).slice(1, -1));
            values.add(Buffer.from(value).toString("base64"));
            values.add(Buffer.from(value).toString("base64url"));
        }
    }
    return [...values].map((value) => Buffer.from(value));
}
function parsed(bytes: Buffer): ObjectValue {
    if (!bytes.length || bytes.length > LIMIT) fail();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    /** 根节点先占一个名额，后续节点必须在读取成员与递归之前通过数量和深度检查；数组逐项索引、对象逐项检查自有属性，不物化完整值数组或待处理元组，使显式遍历栈只随已限制的深度增长。 */
    let nodes = 1;
    function visit(entry: unknown, depth: number): void {
        if (!entry || typeof entry !== "object") return;
        const child = (key: string | number) => {
            if (++nodes > 200000 || depth >= 64) fail();
            visit((entry as Record<string | number, unknown>)[key], depth + 1);
        };
        if (Array.isArray(entry)) {
            for (let index = 0; index < entry.length; index++) child(index);
        } else {
            for (const key in entry) if (Object.hasOwn(entry, key)) child(key);
        }
    }
    visit(value, 0);
    if (
        !object(value) ||
        !object(value.config) ||
        !Array.isArray(value.suites) ||
        !object(value.stats)
    )
        fail();
    return value;
}
function endpointFields(value: ObjectValue): ObjectValue[] {
    const config = value.config as ObjectValue,
        fields: ObjectValue[] = [];
    for (const key of ["projects", "filteredProjects"]) {
        const projects = config[key];
        if (!Array.isArray(projects)) fail();
        for (const project of projects) {
            if (!object(project)) fail();
            if (project.use === undefined) continue;
            if (!object(project.use)) fail();
            const connection = project.use.connectOptions;
            if (connection === undefined) continue;
            if (!object(connection) || typeof connection.wsEndpoint !== "string") fail();
            fields.push(connection);
        }
    }
    if (!fields.length) fail();
    return fields;
}

/** 纯验证器同时检查 JSON 结构、确定字段的替换标记及所有原始和规范化字节里的端点编码；不修改未知字段或删除错误、附件与测试结果，任何非预期残留都使整份报告失败而不是把它泛化成自动脱敏框架。 */
export function verifyEndpointJson(bytes: Buffer, endpoints: readonly string[]): void {
    try {
        endpointsAllowed(endpoints);
        const value = parsed(bytes);
        if (endpointFields(value).some((field) => field.wsEndpoint !== MARKER)) fail();
        const normalized = Buffer.from(JSON.stringify(value));
        if (forms(endpoints).some((form) => bytes.includes(form) || normalized.includes(form)))
            fail();
    } catch {
        fail();
    }
}

function rewrite(bytes: Buffer, endpoints: readonly string[]): Buffer {
    endpointsAllowed(endpoints);
    const value = parsed(bytes);
    for (const field of endpointFields(value)) {
        if (!endpoints.includes(field.wsEndpoint as string)) fail();
        field.wsEndpoint = MARKER;
    }
    const result = Buffer.from(JSON.stringify(value, null, 2));
    verifyEndpointJson(result, endpoints);
    return result;
}

/** 打开目标父目录前逐层拒绝符号链接，最终父目录必须属于当前用户且严格私有；保持目录描述符直到读取与发布结束，原有 JSON 可为内建 reporter 的普通模式，新原子成员始终独占创建且只有所有者读写。 */
async function privateParent(path: string): Promise<FileHandle> {
    pathAllowed(path);
    const parent = dirname(path),
        root = parse(parent).root;
    let current = root;
    for (const part of parent.slice(root.length).split("/").filter(Boolean)) {
        current = join(current, part);
        const handle = await open(
            current,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
            if (!(await handle.stat()).isDirectory()) fail();
        } finally {
            await handle.close();
        }
    }
    const directory = await open(
        parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
        const stat = await directory.stat();
        if (
            !stat.isDirectory() ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o777) !== 0o700 ||
            !same(stat, await lstat(parent))
        )
            fail();
        return directory;
    } catch {
        await directory.close();
        fail();
    }
}
async function parentUnchanged(path: string, parent: FileHandle) {
    const stat = await parent.stat(),
        named = await lstat(dirname(path));
    if (
        !same(stat, named) ||
        !named.isDirectory() ||
        named.isSymbolicLink() ||
        named.uid !== process.getuid?.() ||
        (named.mode & 0o777) !== 0o700
    )
        fail();
}
async function readStable(path: string, refresh = false): Promise<{ bytes: Buffer; stat: Stats }> {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            stat.nlink !== 1 ||
            stat.size < 1 ||
            stat.size > LIMIT ||
            !same(stat, await lstat(path))
        )
            fail();
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!chunk.bytesRead) fail();
            offset += chunk.bytesRead;
        }
        if (refresh) await handle.sync();
        if (!stable(stat, await handle.stat()) || !same(stat, await lstat(path))) fail();
        return { bytes, stat };
    } finally {
        await handle.close();
    }
}

/** 主机在读取任何报告附件、计算证据哈希或创建交付元数据之前独立调用这个标准库模块；它仅接受冻结 SDK 的绝对路径，读取同一已验证文件描述符并复核父目录和名字身份，缺失、超限、替换与残留都只抛固定安全错误。 */
export async function verifyEndpointJsonFile(
    path: string,
    endpoints: readonly string[],
): Promise<void> {
    let parent: FileHandle | undefined;
    try {
        endpointsAllowed(endpoints);
        parent = await privateParent(path);
        const file = await readStable(path, true);
        if ((file.stat.mode & 0o777) !== 0o600) fail();
        verifyEndpointJson(file.bytes, endpoints);
        await parent.sync();
        await parentUnchanged(path, parent);
        if (!stable(file.stat, await lstat(path))) fail();
    } catch {
        fail();
    } finally {
        await parent?.close().catch(() => fail());
    }
}

async function finalize(path: string, endpoints: readonly string[]) {
    let parent: FileHandle | undefined,
        temporary: string | undefined,
        temporaryStat: Stats | undefined,
        published = false;
    try {
        parent = await privateParent(path);
        const original = await readStable(path),
            bytes = rewrite(original.bytes, endpoints);
        const expected = createHash("sha256").update(bytes).digest("hex");
        temporary = join(dirname(path), `.${randomUUID()}.tmp`);
        const output = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            temporaryStat = await output.stat();
            await output.writeFile(bytes);
            await output.sync();
        } finally {
            await output.close();
        }
        await parentUnchanged(path, parent);
        if (
            !stable(original.stat, await lstat(path)) ||
            !same(temporaryStat, await lstat(temporary))
        )
            fail();
        await rename(temporary, path);
        published = true;
        await parent.sync();
        const final = await readStable(path);
        if (
            !same(temporaryStat, final.stat) ||
            (final.stat.mode & 0o777) !== 0o600 ||
            createHash("sha256").update(final.bytes).digest("hex") !== expected
        )
            fail();
        verifyEndpointJson(final.bytes, endpoints);
        await parentUnchanged(path, parent);
    } finally {
        if (!published && temporary && temporaryStat) {
            const current = await lstat(temporary).catch(() => undefined);
            if (current && same(temporaryStat, current)) await unlink(temporary);
        }
        await parent?.close();
    }
}

/** Playwright 按配置顺序等待公开 onEnd；本 reporter 必须严格排在内建 JSON、JUnit 与 HTML 后面，端点只取公开 FullConfig 且不改变其枚举或连接语义，失败返回公开 failed
 * 状态，仍需主机独立文件门禁才能交付。 */
export default class EndpointJsonReporter implements Reporter {
    private endpoints: string[] = [];
    private ready = false;
    private readonly outputFile: string;
    /** 构造阶段仅保存宿主生成的固定绝对输出路径，不接收端点、令牌、环境或命令行参数；路径和 reporter 顺序由公开配置到达时共同验证，任何错误都延迟为安全失败状态而不打印可能包含配置内容的第三方异常。 */
    constructor(options: { outputFile: string }) {
        this.outputFile = options?.outputFile;
    }
    /** 从公开 FullConfig 的原始与筛选项目收集去重后的实际连接端点，并确认唯一内建 JSON 写入者与本模块的最后位置；不修改活配置、属性描述符或 worker 连接选项，初始化拒绝只保存关闭状态供最终结果处理。 */
    onBegin(config: FullConfig): void {
        try {
            pathAllowed(this.outputFile);
            const configured = config.reporter;
            const last = configured[configured.length - 1];
            if (
                !last ||
                typeof last[0] !== "string" ||
                (!last[0].endsWith("/endpoint-json-reporter.ts") &&
                    !last[0].endsWith("/endpoint-json-reporter.js")) ||
                !object(last[1]) ||
                last[1].outputFile !== this.outputFile
            )
                fail();
            const json = configured.filter(([name]) => name === "json");
            if (
                json.length !== 1 ||
                !object(json[0]![1]) ||
                json[0]![1].outputFile !== this.outputFile
            )
                fail();
            this.endpoints = [
                ...new Set(
                    [...config.projects, ...config.filteredProjects]
                        .map((project) => project.use.connectOptions?.wsEndpoint)
                        .filter((endpoint): endpoint is string => typeof endpoint === "string"),
                ),
            ];
            endpointsAllowed(this.endpoints);
            this.ready = true;
        } catch {
            this.ready = false;
        }
    }
    /** 所有排在前面的内建 reporter 已经实际完成写入后，执行同目录有界原子刷新与读回复核；成功时不改变 Playwright 原本业务状态，任一不确定只返回公开 failed 状态，独立宿主门禁仍是报告交付必经条件。 */
    async onEnd(_result: FullResult): Promise<void | { status: "failed" }> {
        try {
            if (!this.ready) fail();
            await finalize(this.outputFile, this.endpoints);
        } catch {
            return { status: "failed" };
        }
    }
    /** 本模块没有控制台报告内容，公开 reporter 标志明确返回不打印标准输出；所有失败都通过结构化最终状态与主机固定错误码传递，不回显配置、异常正文、路径内容、控制端点或可能带秘密的动态字段。 */
    printsToStdio(): boolean {
        return false;
    }
}
