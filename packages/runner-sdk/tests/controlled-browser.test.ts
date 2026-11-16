/** 真实 Playwright CLI 在本机拒绝 WebSocket 握手的服务上验证失败保密，不依赖 Chrome、模型或引擎复制；
 * 单行私有配置保存随机端点，报告及归档只返回布尔计数，任何断言都不能打印原始错误或私密标记。
 */
import { test, expect } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
    mkdtemp,
    mkdir,
    writeFile,
    readFile,
    readdir,
    lstat,
    rm,
    statfs,
    realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Socket } from "node:net";
import { analyze } from "../../compiler/src/index.js";
import { snapshot } from "../../compiler/tests/helpers.js";
const require = createRequire(import.meta.url);
const LIMIT = 5 * 1024 * 1024,
    RESERVE = 2 * 1024 * 1024;

/** 子进程输出仅进入有界内存供扫描，错误对象不会进入诊断；超时只终止本次原始 ChildProcess 并等待真实退出，既不扫描 PID，
 * 也不把命令或参数中塞入控制端点，标准输入只给归档解析器使用。
 */
async function command(executable: string, args: string[], cwd: string, input?: string) {
    const child = spawn(executable, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
    let bytes = 0,
        overflow = false,
        timer: ReturnType<typeof setTimeout> | undefined;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
            overflow = true;
            child.kill("SIGKILL");
        } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", () => reject(new Error("PRIVACY_TEST_COMMAND_FAILED")));
            child.once("exit", resolve);
            timer = setTimeout(() => child.kill("SIGKILL"), 12000);
        });
        if (overflow) throw new Error("PRIVACY_TEST_OUTPUT_LIMIT");
        return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    } finally {
        clearTimeout(timer);
    }
}

/** Python 标准 zipfile 保持既有成熟解析路径以及输入、成员、总展开额度，静态 viewer HTML 只扫描原字节而不误当主报告；
 * 若私有配置被复制进 trace source，该归档成员仍会扫描，不能为通过测试而排
 * 除。
 */
const scanProgram = String.raw`
import base64,io,json,pathlib,re,sys,urllib.parse,zipfile
v=json.load(sys.stdin)
root=pathlib.Path(v['root'])
forms=set()
for value in [v['endpoint'],v['token']]:
    for text in [value,urllib.parse.quote(value,safe=''),urllib.parse.quote(value,safe=':/'),json.dumps(value)[1:-1]` +
    `,base64.b64encode(value.encode()).decode(),base64.urlsafe_b64encode(value.encode()).decode(),base64.urlsafe_b64e` +
        `ncode(value.encode()).decode().rstrip('=')]:
        forms.add(text.encode())
r={'hits':0,'containers':{},'files':0,'traceFiles':0,'traceEntries':0,'sourceEntries':0,'htmlZipEntries':0,'referenc` +
`edFiles':0,'mainReport':False,'fixedFailure':False}
def check(body,kind):
    hits=sum(marker in body for marker in forms)
    r['hits']+=hits
    if hits:r['containers'][kind]=r['containers'].get(kind,0)+hits
    if b'VERIQ_BROWSER_CONNECTION_FAILED' in body:r['fixedFailure']=True
def archive(body,kind):
    if len(body)>33554432:raise ValueError('ZIP_INPUT_LIMIT')
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        entries=z.infolist()
        if len(entries)>4096:raise ValueError('ZIP_ENTRY_LIMIT')
        total=0
        for e in entries:
            total+=e.file_size
            if e.file_size>16777216 or total>67108864:raise ValueError('ZIP_OUTPUT_LIMIT')
            check(e.filename.encode(),kind);check(z.read(e),kind)
            if kind=='trace.zip:decoded':r['traceEntries']+=1
            else:r['htmlZipEntries']+=1
            if 'src@' in e.filename:r['sourceEntries']+=1
for folder in ['reports','results']:
    base=root/folder
    if not base.exists():continue
    for path in base.rglob('*'):
        if not path.is_file():continue
        r['files']+=1
        if r['files']>4096:raise ValueError('FILE_COUNT_LIMIT')
        rel=path.relative_to(root).as_posix();body=path.read_bytes();kind='referenced-data'
        if rel=='reports/playwright.json':kind='json'
        elif rel=='reports/junit.xml':kind='junit'
        elif rel=='reports/html/index.html':kind='report.html'
        elif rel.endswith('.zip'):kind='trace.zip'
        check(body,kind)
        if kind=='trace.zip':r['traceFiles']+=1;archive(body,'trace.zip:decoded')
        if kind=='report.html':
            found=re.search(rb'data:application/zip;base64,([A-Za-z0-9+/=\r\n]+)',body)
            if not found:raise ValueError('REPORT_ZIP_REQUIRED')
            r['mainReport']=True;archive(base64.b64decode(found.group(1)),'report.html:decoded')
        if rel.startswith('reports/html/data/') or rel.startswith('reports/html/trace/'):r['referencedFiles']+=1
for field in ['stdout','stderr']:check(base64.b64decode(v[field]),field)
print(json.dumps(r))
`;

test.skipIf(process.platform === "win32")(
    "real public Playwright connection failure keeps private endpoint out of every delivered report",
    async () => {
        const parent = await realpath(tmpdir()),
            free = await statfs(parent);
        expect(free.bavail * free.bsize >= LIMIT + RESERVE).toBe(true);
        const root = await mkdtemp(join(parent, "veriq-connect-")),
            marker = randomUUID(),
            identity = await lstat(root);
        await writeFile(join(root, ".owner"), marker, { mode: 0o600, flag: "wx" });
        const token = randomBytes(32).toString("hex"),
            sockets = new Set<Socket>();
        let upgrades = 0,
            correctPath = true,
            correctHeader = true;
        const server = createServer((_request, response) => {
            response.writeHead(403);
            response.end();
        });
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        });
        server.on("upgrade", (request, socket) => {
            upgrades++;
            correctPath &&= request.url === "/" + token;
            correctHeader &&= request.headers["x-veriq-privacy-test"] === "required";
            socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}/${token}`;
            const source = snapshot([{ id: "open", action: "goto", path: "/" }]),
                plan = analyze(source).cases[0]!;
            const register = fileURLToPath(new URL("../src/register-case.ts", import.meta.url));
            await writeFile(join(root, "package.json"), '{"type":"module"}', {
                mode: 0o600,
                flag: "wx",
            });
            await writeFile(
                join(root, "connection.spec.ts"),
                `import {registerCase} from ${JSON.stringify(register)};registerCase(${JSON.stringify(plan)},` +
                    `${JSON.stringify(source)});`,
                { mode: 0o600, flag: "wx" },
            );
            await mkdir(join(root, "reports"), { mode: 0o700 });
            const finalReporter = fileURLToPath(
                new URL("../src/endpoint-json-reporter.ts", import.meta.url),
            );
            const configuration = {
                testDir: root,
                testMatch: "connection.spec.ts",
                workers: 1,
                retries: 0,
                timeout: 3000,
                projects: [{ name: "first" }, { name: "second" }],
                reporter: [
                    ["json", { outputFile: join(root, "reports/playwright.json") }],
                    ["junit", { outputFile: join(root, "reports/junit.xml") }],
                    ["html", { outputFolder: join(root, "reports/html"), open: "never" }],
                    [finalReporter, { outputFile: join(root, "reports/playwright.json") }],
                ],
                outputDir: join(root, "results"),
                use: {
                    browserName: "chromium",
                    trace: "on",
                    connectOptions: {
                        wsEndpoint: endpoint,
                        timeout: 1000,
                        headers: { "x-veriq-privacy-test": "required" },
                    },
                },
            };
            await writeFile(
                join(root, "playwright.config.mjs"),
                `export default ${JSON.stringify(configuration)};`,
                { mode: 0o600, flag: "wx" },
            );
            const actual = await command(
                process.execPath,
                [
                    require.resolve("@playwright/test/cli"),
                    "test",
                    "--config",
                    join(root, "playwright.config.mjs"),
                ],
                root,
            );
            let treeBytes = 0;
            const count = async (path: string): Promise<void> => {
                for (const entry of await readdir(path, { withFileTypes: true })) {
                    const file = join(path, entry.name);
                    if (entry.isDirectory()) await count(file);
                    else {
                        treeBytes += (await lstat(file)).size;
                        expect(treeBytes <= LIMIT).toBe(true);
                    }
                }
            };
            await count(root);
            const reserve = await statfs(parent);
            expect(reserve.bavail * reserve.bsize >= RESERVE).toBe(true);
            const scan = await command(
                process.platform === "darwin" ? "python3" : "python",
                ["-c", scanProgram],
                root,
                JSON.stringify({
                    root,
                    endpoint,
                    token,
                    stdout: actual.stdout.toString("base64"),
                    stderr: actual.stderr.toString("base64"),
                }),
            );
            expect(scan.code).toBe(0);
            const facts = JSON.parse(scan.stdout.toString());
            process.stdout.write(
                JSON.stringify({
                    controlledBrowserPrivacy: {
                        ...facts,
                        treeBytes,
                        upgrades,
                        correctPath,
                        correctHeader,
                        cliCode: actual.code,
                    },
                }) + "\n",
            );
            expect(actual.code).toBe(1);
            expect(upgrades).toBeGreaterThanOrEqual(2);
            expect(correctPath && correctHeader).toBe(true);
            expect(facts.mainReport).toBe(true);
            expect(facts.traceFiles).toBeGreaterThan(0);
            expect(facts.htmlZipEntries).toBeGreaterThan(0);
            expect(facts.fixedFailure).toBe(true);
            expect(facts.hits).toBe(0);
            // 单独的无浏览器通过用例验证公开 reporter 的顺序和状态覆盖，错误配置负例不会混入上述完整保密扫描结果，
            // 也不能被当作可交付报告。
            const { verifyEndpointJsonFile } = await import("../src/endpoint-json-reporter.js");
            const statusRoot = join(root, "status");
            await mkdir(statusRoot, { mode: 0o700 });
            const statusJson = join(statusRoot, "playwright.json"),
                statusConfig = join(root, "public-status.config.mjs");
            const publicManifest = require.resolve("@playwright/test/package.json"),
                publicExports = JSON.parse(await readFile(publicManifest, "utf8"));
            expect(publicExports.exports["."].import).toBe("./index.mjs");
            const publicModule = fileURLToPath(
                new URL(publicExports.exports["."].import, pathToFileURL(publicManifest)),
            );
            await writeFile(
                join(root, "public-status.spec.ts"),
                `import {test} from ${JSON.stringify(publicModule)};test("public reporter status",()=>{});`,
                { mode: 0o600, flag: "wx" },
            );
            const statusConfiguration = {
                testDir: root,
                testMatch: "public-status.spec.ts",
                workers: 1,
                retries: 0,
                use: configuration.use,
                outputDir: join(statusRoot, "results"),
                reporter: [
                    ["json", { outputFile: statusJson }],
                    [finalReporter, { outputFile: statusJson }],
                ],
            };
            await writeFile(
                statusConfig,
                `export default ${JSON.stringify(statusConfiguration)};`,
                { mode: 0o600, flag: "wx" },
            );
            const passed = await command(
                process.execPath,
                [require.resolve("@playwright/test/cli"), "test", "--config", statusConfig],
                root,
            );
            let statusReport: any;
            try {
                statusReport = JSON.parse(await readFile(statusJson, "utf8"));
            } catch {}
            const statusFacts = {
                reportPresent: statusReport !== undefined,
                expected: Number(statusReport?.stats?.expected ?? -1),
                unexpected: Number(statusReport?.stats?.unexpected ?? -1),
                topErrors: Array.isArray(statusReport?.errors) ? statusReport.errors.length : -1,
                moduleMissing: false,
                namedExport: false,
                unexpectedTestCall: false,
                syntax: false,
                endpointResidual: false,
            };
            const diagnostic = Buffer.concat([
                passed.stdout,
                passed.stderr,
                Buffer.from(JSON.stringify(statusReport ?? {})),
            ]).toString();
            statusFacts.moduleMissing = /ERR_MODULE_NOT_FOUND|Cannot find module/.test(diagnostic);
            statusFacts.namedExport = /does not provide an export|Named export .* not found/.test(
                diagnostic,
            );
            statusFacts.unexpectedTestCall =
                /did not expect test\(|test\(\) to be called|No tests found/.test(diagnostic);
            statusFacts.syntax = /SyntaxError|Cannot use import statement/.test(diagnostic);
            statusFacts.endpointResidual = diagnostic.includes(endpoint);
            process.stdout.write(
                JSON.stringify({ publicReporterProbe: { cliCode: passed.code, ...statusFacts } }) +
                    "\n",
            );
            expect(passed.code).toBe(0);
            await verifyEndpointJsonFile(statusJson, [endpoint]);
            const passedJson = JSON.parse(await readFile(statusJson, "utf8"));
            expect(passedJson.stats.expected).toBe(1);
            expect(passedJson.stats.unexpected).toBe(0);
            await writeFile(
                statusConfig,
                `export default ` +
                    `${
                        JSON.stringify({ ...statusConfiguration, reporter: [...statusConfiguration.reporter, [
                            "dot"]] })};`,
            );
            const refused = await command(
                process.execPath,
                [require.resolve("@playwright/test/cli"), "test", "--config", statusConfig],
                root,
            );
            expect(refused.code).toBe(1);
            const refusedJson = JSON.parse(await readFile(statusJson, "utf8"));
            expect(refusedJson.stats.expected).toBe(1);
            expect(refusedJson.stats.unexpected).toBe(0);
            await expect(verifyEndpointJsonFile(statusJson, [endpoint])).rejects.toThrow(
                "REPORT_PRIVACY_UNCONFIRMED",
            );
            treeBytes = 0;
            await count(root);
            const afterStatus = await statfs(parent);
            expect(afterStatus.bavail * afterStatus.bsize >= RESERVE).toBe(true);
            process.stdout.write(
                JSON.stringify({
                    publicReporterStatus: {
                        correctOrderExit: passed.code,
                        incorrectOrderExit: refused.code,
                        actualPassed: refusedJson.stats.expected,
                        actualUnexpected: refusedJson.stats.unexpected,
                        incorrectOrderDeliveryBlocked: true,
                        fullPrivacyGroup: false,
                        treeBytes,
                    },
                }) + "\n",
            );
        } finally {
            for (const socket of sockets) socket.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            const current = await lstat(root);
            expect(
                current.dev === identity.dev &&
                    current.ino === identity.ino &&
                    (await readFile(join(root, ".owner"), "utf8")) === marker,
            ).toBe(true);
            await rm(root, { recursive: true, force: true });
        }
    },
);

/** 独立小堆子进程先真实解析完整 JSON，再用透明代理计数宽容器的成员读取；只输出固定状态与计数，不改变解析结果或生产接口
 * ，借此区分及时拒绝和先物化全部子节点后才拒绝，避免故意触发宿主内存耗尽。
 */
async function traversalProbe(kind: "array" | "object", members: number) {
    const program = String.raw`
import { verifyEndpointJson } from ${JSON.stringify(new URL("../src/endpoint-json-reporter.ts", import.meta.url).href)};
const kind = process.argv[1], members = Number(process.argv[2]);
if (!["array", "object"].includes(kind) || !Number.isInteger(members) || members < 1 || members > 200001) process.ex` +
`it(2);
const wide = kind === "array" ? "[" + "0,".repeat(members - 1) + "0]" : "{" + Array.from({ length: members }, (_, in` +
`dex) => '"m' + index + '":0').join(",") + "}";
const bytes = Buffer.from('{"config":{"projects":[],"filteredProjects":[{"use":{"connectOptions":{"wsEndpoint":"VERI` +
`Q_PRIVATE_ENDPOINT"}}}]},"suites":[],"stats":{},"wide":' + wide + '}');
if (bytes.length > 3 * 1024 * 1024) process.exit(3);
const original = JSON.parse;
let reads = 0, status = "ACCEPTED";
JSON.parse = (...args) => {
    const value = original(...args);
    value.wide = new Proxy(value.wide, { get(target, key, receiver) {
        if (typeof key === "string" && Object.hasOwn(target, key) && key !== "length") reads++;
        return Reflect.get(target, key, receiver);
    } });
    return value;
};
try { verifyEndpointJson(bytes, ["ws://127.0.0.1:12345/0123456789abcdef0123456789abcdef"]); }
catch (error) { status = error instanceof Error && error.message === "REPORT_PRIVACY_UNCONFIRMED" ? error.message : ` +
`"UNEXPECTED_FAILURE"; }
finally { JSON.parse = original; }
process.stdout.write(JSON.stringify({ status, reads, bytes: bytes.length }));
`;
    const result = await command(
        process.execPath,
        ["--max-old-space-size=128", "--input-type=module", "-e", program, kind, String(members)],
        process.cwd(),
    );
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBe(0);
    const counts = JSON.parse(result.stdout.toString()) as {
        status: string;
        reads: number;
        bytes: number;
    };
    expect(counts.bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    process.stdout.write(
        "JSON_TRAVERSAL_PROBE " + JSON.stringify({ kind, members, ...counts }) + "\n",
    );
    return counts;
}

test("endpoint JSON traversal probe accepts small real parsed containers", async () => {
    for (const kind of ["array", "object"] as const) {
        const counts = await traversalProbe(kind, 1024);
        expect(counts.status).toBe("ACCEPTED");
        expect(counts.reads).toBe(2048);
    }
});

test.each(["array", "object"] as const)(
    "endpoint JSON traversal bounds wide %s child admission",
    async (kind) => {
        const counts = await traversalProbe(kind, 200001);
        expect(counts.status).toBe("REPORT_PRIVACY_UNCONFIRMED");
        expect(counts.reads).toBeLessThan(200000);
    },
);

test("endpoint JSON traversal preserves exact node and depth limits", async () => {
    const { verifyEndpointJson } = await import("../src/endpoint-json-reporter.js");
    const endpoint = "ws://127.0.0.1:12345/0123456789abcdef0123456789abcdef";
    const report = () => ({
        config: {
            projects: [],
            filteredProjects: [
                { use: { connectOptions: { wsEndpoint: "VERIQ_PRIVATE_ENDPOINT" } } },
            ],
        },
        suites: [],
        stats: {},
    });
    const verify = (extra: unknown) =>
        verifyEndpointJson(Buffer.from(JSON.stringify({ ...report(), extra })), [endpoint]);
    let nested: unknown = 0;
    for (let depth = 0; depth < 63; depth++) nested = { nested };
    expect(() => verify(nested)).not.toThrow();
    expect(() => verify({ nested })).toThrow("REPORT_PRIVACY_UNCONFIRMED");
    const counts = await traversalProbe("array", 199989);
    expect(counts.status).toBe("ACCEPTED");
    expect(counts.reads).toBe(399978);
    expect((await traversalProbe("array", 199990)).status).toBe("REPORT_PRIVACY_UNCONFIRMED");
});

/** 纯 JSON 门禁对已知配置字段以外的残留保持失败，未知结果字段绝不被删除来换取通过；文件测试都使用独占私有目录，
 * 超限样本仅建立一份稀疏 inode 并先由同一描述符元数据拒绝，绝不分配三十二兆内容。
 */
test.skipIf(process.platform === "win32")(
    "endpoint JSON gate refuses missing malformed residual symlink oversized and nonprivate files",
    async () => {
        const fs = await import("node:fs/promises");
        const { verifyEndpointJson, verifyEndpointJsonFile } = await import(
            "../src/endpoint-json-reporter.js"
        );
        const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-json-gate-"));
        const endpoint = "ws://127.0.0.1:12345/" + randomBytes(32).toString("hex"),
            path = join(root, "playwright.json");
        const report = () => ({
            config: {
                projects: [],
                filteredProjects: [
                    { use: { connectOptions: { wsEndpoint: "VERIQ_PRIVATE_ENDPOINT" } } },
                ],
            },
            suites: [],
            stats: {},
        });
        const rejected = async () => {
            await expect(verifyEndpointJsonFile(path, [endpoint])).rejects.toThrow(
                "REPORT_PRIVACY_UNCONFIRMED",
            );
        };
        try {
            await rejected();
            await writeFile(path, JSON.stringify(report()), { mode: 0o600, flag: "wx" });
            await verifyEndpointJsonFile(path, [endpoint]);
            const residual = { ...report(), errors: [{ message: endpoint }] };
            expect(() =>
                verifyEndpointJson(Buffer.from(JSON.stringify(residual)), [endpoint]),
            ).toThrow("REPORT_PRIVACY_UNCONFIRMED");
            expect(() =>
                verifyEndpointJson(
                    Buffer.from(
                        JSON.stringify({ ...report(), secret: encodeURIComponent(endpoint) }),
                    ),
                    [endpoint],
                ),
            ).toThrow("REPORT_PRIVACY_UNCONFIRMED");
            let nested: unknown = 0;
            for (let depth = 0; depth < 66; depth++) nested = { nested };
            expect(() =>
                verifyEndpointJson(Buffer.from(JSON.stringify({ ...report(), nested })), [
                    endpoint,
                ]),
            ).toThrow("REPORT_PRIVACY_UNCONFIRMED");
            expect(() =>
                verifyEndpointJson(
                    Buffer.from(
                        JSON.stringify({
                            ...report(),
                            nodes: Array.from({ length: 200001 }, () => 0),
                        }),
                    ),
                    [endpoint],
                ),
            ).toThrow("REPORT_PRIVACY_UNCONFIRMED");
            await writeFile(path, "{");
            await rejected();
            await fs.unlink(path);
            const target = join(root, "target.json");
            await writeFile(target, JSON.stringify(report()), { mode: 0o600 });
            await fs.symlink(target, path);
            await rejected();
            await fs.unlink(path);
            const sparse = await fs.open(path, "wx", 0o600);
            try {
                await sparse.truncate(32 * 1024 * 1024 + 1);
                expect((await sparse.stat()).blocks * 512 <= 4096).toBe(true);
                await rejected();
            } finally {
                await sparse.close();
                await fs.unlink(path);
            }
            await writeFile(path, JSON.stringify(report()), { mode: 0o600 });
            await fs.chmod(root, 0o755);
            await rejected();
            await fs.chmod(root, 0o700);
            await fs.link(path, join(root, "linked.json"));
            await rejected();
        } finally {
            await fs.chmod(root, 0o700);
            await rm(root, { recursive: true, force: true });
        }
    },
);

/** 公开 reporter 只接受实际配置的最后位置及同一内建 JSON 输出路径，缺少输入、其他字段泄漏和错误排序都返回 failed；
 * 原子替换失败保持原件与独立门禁失败，成功后保留内建 schema 与业务统计，不把错误状态改
 * 写成通过。
 */
test.skipIf(process.platform === "win32")(
    "final JSON reporter preserves builtin results and fails closed on finalization uncertainty",
    async () => {
        const fs = await import("node:fs/promises");
        const { default: EndpointReporter, verifyEndpointJsonFile } = await import(
            "../src/endpoint-json-reporter.js"
        );
        const { syncBuiltinESMExports } = await import("node:module");
        const mutableFs = fs.default;
        const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-json-final-")),
            path = join(root, "playwright.json");
        const endpoint = "ws://127.0.0.1:12345/" + randomBytes(32).toString("hex");
        const module = fileURLToPath(new URL("../src/endpoint-json-reporter.ts", import.meta.url));
        const project = { use: { connectOptions: { wsEndpoint: endpoint } } };
        const report = () => ({
            config: { projects: [], filteredProjects: [project] },
            suites: [{ title: "case", specs: [] }],
            stats: { unexpected: 1 },
        });
        const config = {
            projects: [project],
            filteredProjects: [project],
            reporter: [
                ["json", { outputFile: path }],
                [module, { outputFile: path }],
            ],
        };
        const run = async (configuration = config) => {
            const reporter = new EndpointReporter({ outputFile: path });
            reporter.onBegin(
                configuration as unknown as import("@playwright/test/reporter").FullConfig,
            );
            return reporter.onEnd({
                status: "failed",
            } as import("@playwright/test/reporter").FullResult);
        };
        try {
            expect((await run())?.status).toBe("failed");
            await writeFile(path, JSON.stringify(report()), { mode: 0o600 });
            expect(
                (await run({ ...config, reporter: [...config.reporter].reverse() }))?.status,
            ).toBe("failed");
            const original = await readFile(path);
            const originalRename = mutableFs.rename;
            let renames = 0;
            mutableFs.rename = async () => {
                renames++;
                throw new Error("unprinted-source");
            };
            syncBuiltinESMExports();
            try {
                expect((await run())?.status).toBe("failed");
                expect(renames).toBe(1);
            } finally {
                mutableFs.rename = originalRename;
                syncBuiltinESMExports();
            }
            expect((await readFile(path)).equals(original)).toBe(true);
            expect((await readdir(root)).length).toBe(1);
            await expect(verifyEndpointJsonFile(path, [endpoint])).rejects.toThrow(
                "REPORT_PRIVACY_UNCONFIRMED",
            );
            mutableFs.rename = async (...args) => {
                await originalRename(...args);
                await writeFile(path, "{");
                throw new Error("unprinted-interruption");
            };
            syncBuiltinESMExports();
            try {
                expect((await run())?.status).toBe("failed");
            } finally {
                mutableFs.rename = originalRename;
                syncBuiltinESMExports();
            }
            expect((await readFile(path)).equals(Buffer.from("{"))).toBe(true);
            await expect(verifyEndpointJsonFile(path, [endpoint])).rejects.toThrow(
                "REPORT_PRIVACY_UNCONFIRMED",
            );
            await writeFile(path, original);
            const originalOpen = mutableFs.open;
            let writes = 0;
            Reflect.set(mutableFs, "open", async (...args: Parameters<typeof fs.open>) => {
                const handle = await originalOpen(...args);
                if (String(args[0]).endsWith(".tmp"))
                    Reflect.set(handle, "writeFile", async () => {
                        writes++;
                        throw new Error("UNPRINTED_WRITE_FAULT");
                    });
                return handle;
            });
            syncBuiltinESMExports();
            try {
                expect((await run())?.status).toBe("failed");
                expect(writes).toBe(1);
            } finally {
                mutableFs.open = originalOpen;
                syncBuiltinESMExports();
            }
            expect((await readFile(path)).equals(original)).toBe(true);
            expect((await readdir(root)).length).toBe(1);
            expect(await run()).toBeUndefined();
            await verifyEndpointJsonFile(path, [endpoint]);
            let reads = 0;
            Reflect.set(mutableFs, "open", async (...args: Parameters<typeof fs.open>) => {
                if (args[0] === path) {
                    reads++;
                    throw new Error("UNPRINTED_READ_FAULT");
                }
                return originalOpen(...args);
            });
            syncBuiltinESMExports();
            try {
                await expect(verifyEndpointJsonFile(path, [endpoint])).rejects.toThrow(
                    "REPORT_PRIVACY_UNCONFIRMED",
                );
                expect(reads).toBe(1);
            } finally {
                mutableFs.open = originalOpen;
                syncBuiltinESMExports();
            }
            const originalStat = mutableFs.lstat;
            let identities = 0;
            Reflect.set(mutableFs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
                const stat = await originalStat(...args);
                if (args[0] === path) {
                    identities++;
                    return Object.assign(Object.create(stat), { ino: Number(stat.ino) + 1 });
                }
                return stat;
            });
            syncBuiltinESMExports();
            try {
                await expect(verifyEndpointJsonFile(path, [endpoint])).rejects.toThrow(
                    "REPORT_PRIVACY_UNCONFIRMED",
                );
                expect(identities).toBe(1);
            } finally {
                mutableFs.lstat = originalStat;
                syncBuiltinESMExports();
            }
            const result = JSON.parse(await readFile(path, "utf8"));
            expect(result.stats.unexpected).toBe(1);
            expect(result.suites[0].title).toBe("case");
            expect((await lstat(path)).mode & 0o777).toBe(0o600);
            await writeFile(path, JSON.stringify({ ...report(), errors: [{ message: endpoint }] }));
            expect((await run())?.status).toBe("failed");
            await expect(verifyEndpointJsonFile(path, [endpoint])).rejects.toThrow(
                "REPORT_PRIVACY_UNCONFIRMED",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

/** 当前模块的私有发布门禁专用于受信 POSIX 源码浏览器流程，Windows 缺少该 uid 与模式证明时应明确拒绝而非修补 DACL；
 * 此合同只验证拒绝，不宣称 Windows 原生附件、安装或浏览器通过，既有 Windows
 * 内核证明保持独立。
 */
test.runIf(process.platform === "win32")(
    "POSIX endpoint file gate fails closed on unsupported Windows metadata",
    async () => {
        const { verifyEndpointJsonFile } = await import("../src/endpoint-json-reporter.js");
        await expect(
            verifyEndpointJsonFile(join(tmpdir(), "playwright.json"), [
                "ws://127.0.0.1:12345/0123456789abcdef0123456789abcdef",
            ]),
        ).rejects.toThrow("REPORT_PRIVACY_UNCONFIRMED");
    },
);

/** 两个公开 connect 重载都使用真实拒绝握手验证接收者和原选项传递，包含业务必需头部及随机路径；原始异常从不输出，
 * 结束后准确恢复原有属性描述符，避免 worker 之间的连接保护遗留或错误的提前还原，不需要启动 Chrom
 * e 或创建替代 Browser。
 */
test("public connection overloads preserve actual handshake options and restore the original method", async () => {
    const { chromium } = await import("@playwright/test");
    const { protectBrowserConnection } = await import("../src/controlled-browser.js");
    const original = chromium.connect,
        descriptor = Object.getOwnPropertyDescriptor(chromium, "connect");
    const sockets = new Set<Socket>(),
        token = randomBytes(32).toString("hex");
    let upgrades = 0,
        optionsPreserved = true;
    const server = createServer();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket) => {
        upgrades++;
        optionsPreserved &&=
            request.url === "/" + token && request.headers["x-veriq-overload"] === "required";
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const restore = protectBrowserConnection(chromium),
        endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}/${token}`;
    try {
        const options = { timeout: 1000, headers: { "x-veriq-overload": "required" } };
        let fixed = 0;
        for (const connect of [
            () => chromium.connect(endpoint, options),
            () => chromium.connect({ ...options, wsEndpoint: endpoint }),
        ]) {
            try {
                await connect();
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message === "VERIQ_BROWSER_CONNECTION_FAILED" &&
                    error.cause === undefined &&
                    Object.keys(error).length === 0
                )
                    fixed++;
            }
        }
        expect(upgrades).toBe(2);
        expect(fixed).toBe(2);
        expect(optionsPreserved).toBe(true);
        restore();
        restore();
        expect(chromium.connect === original).toBe(true);
        expect(
            Object.getOwnPropertyDescriptor(chromium, "connect")?.value === descriptor?.value,
        ).toBe(true);
        expect(Object.hasOwn(chromium, "connect")).toBe(descriptor !== undefined);
    } finally {
        restore();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
