import "../scripts/runtime-payload-inputs.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { validatedAssetBody, acquireMacRuntimeAssets } from "../scripts/runtime-assets-acquisition.ts";
import type { Ref } from "../scripts/runtime-payload-inputs.ts";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { assetsFixture, fact } from "./fixtures/runtime-assets.ts";

/**
 * 正例直接消费生产下载路径同用的有界流生成器并接入真实私有事务，真实摘要来自测试字节而非替换官方常量；负例逐一改变
 * HTTP 元数据与流事实，确认失败不会被写入成功证据或发布结果。
 */
async function* body(value = Buffer.from("tiny verified body")) {
    yield value;
}
const bytes = Buffer.from("tiny verified body");
for (const digest of [fact("body", bytes).sha256, null])
    test(`validated production body writes and audits with independent hash=${digest !== null}`, async () =>
        assetsFixture(async (f) => {
            const tx = new ArchiveTransaction(f.root, f.output, "stream");
            await tx.initialize();
            try {
                const actual = await tx.write(
                    "body",
                    validatedAssetBody(
                        {
                            statusCode: 200,
                            rawHeaders: ["Content-Length", String(bytes.length)],
                            body: body(),
                        },
                        { sizeBytes: bytes.length, sha256: digest, maximumBytes: 1024 },
                    ),
                );
                assert.deepEqual(actual, fact("body", bytes));
                await tx.audit();
            } finally {
                assert.equal(await tx.cleanup(), "CONFIRMED");
            }
        }));
for (const [name, statusCode, rawHeaders, expectedSize, expectedHash, maximumBytes, code] of [
    ["status", 206, ["Content-Length", String(bytes.length)], bytes.length, null, 1024, "PAYLOAD_IO"],
    ["missing length", 200, [], bytes.length, null, 1024, "PAYLOAD_IO"],
    [
        "duplicate length",
        200,
        ["Content-Length", String(bytes.length), "content-length", String(bytes.length)],
        bytes.length,
        null,
        1024,
        "PAYLOAD_IO",
    ],
    [
        "encoding",
        200,
        ["Content-Length", String(bytes.length), "Content-Encoding", "gzip"],
        bytes.length,
        null,
        1024,
        "PAYLOAD_IO",
    ],
    ["short", 200, ["Content-Length", String(bytes.length + 1)], bytes.length + 1, null, 1024, "PAYLOAD_ARCHIVE_HASH"],
    ["overflow", 200, ["Content-Length", String(bytes.length - 1)], bytes.length - 1, null, 1024, "PAYLOAD_LIMIT"],
    ["hash", 200, ["Content-Length", String(bytes.length)], bytes.length, "0".repeat(64), 1024, "PAYLOAD_ARCHIVE_HASH"],
    ["budget", 200, ["Content-Length", String(bytes.length)], bytes.length, null, 1, "PAYLOAD_LIMIT"],
] as const)
    test(`validated production body rejects ${name}`, async () => {
        await assert.rejects(
            async () => {
                for await (const chunk of validatedAssetBody(
                    { statusCode, rawHeaders, body: body() },
                    { sizeBytes: expectedSize, sha256: expectedHash, maximumBytes },
                ))
                    void chunk;
            },
            { code },
        );
    });
test("body splits large incoming chunks and observes cancellation", async () => {
    const large = Buffer.alloc(150000),
        sizes: number[] = [];
    for await (const chunk of validatedAssetBody(
        {
            statusCode: 200,
            rawHeaders: ["Content-Length", String(large.length)],
            body: body(large),
        },
        { sizeBytes: large.length, sha256: null, maximumBytes: large.length },
    ))
        sizes.push(chunk.length);
    assert.deepEqual(sizes, [65536, 65536, 18928]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        async () => {
            for await (const chunk of validatedAssetBody(
                {
                    statusCode: 200,
                    rawHeaders: ["Content-Length", String(bytes.length)],
                    body: body(),
                },
                { sizeBytes: bytes.length, sha256: null, maximumBytes: 1024 },
                controller.signal,
            ))
                void chunk;
        },
        { code: "PAYLOAD_CANCELLED" },
    );
});
test("bad source refuses acquisition before requests and outputs", async () =>
    assetsFixture(async (f) => {
        await assert.rejects(
            acquireMacRuntimeAssets(
                "x64",
                { ...f.source, commit: "b".repeat(40) },
                { inputRoot: f.root, outputParent: f.output, candidateName: "bad" },
            ),
            { code: "PAYLOAD_RECEIPT_MISMATCH" },
        );
    }));
for (const args of [[], ["--arch", "x64"], ["--unknown", "x64"], ["--arch", "x64", "--arch", "arm64"]])
    test(`acquisition CLI rejects flags ${JSON.stringify(args)}`, () => {
        const child = spawnSync(
            process.execPath,
            ["--import", "tsx", "scripts/acquire-macos-runtime-assets.mjs", ...args],
            { encoding: "utf8" },
        );
        assert.equal(child.status, 1);
        assert.equal(child.stdout, "");
        assert.match(child.stderr, /PAYLOAD_INPUT_INVALID phase=INPUTS cleanup=NOT_NEEDED/);
    });

/**
 * 请求替身只替换内部 node:https.request，并以真实 EventEmitter 与流触发有限网络拒绝路径，不创建 TCP 服务或真实请求；计
 * 划空间在此单独替换以绕开本机七十三 MiB 限制，但输出、来源读取、事务
 * 清理和正文校验仍是真实实现。
 */
test("wrong source and altered actual host facts create zero requests", async () => {
    const https = (await import("node:https")).default;
    const original = https.request;
    let calls = 0;
    https.request = (() => {
        calls++;
        throw Error("UNEXPECTED_REQUEST");
    }) as typeof https.request;
    try {
        await assetsFixture(async (f) => {
            const { writeFile, readdir } = await import("node:fs/promises");
            const { join } = await import("node:path");
            for (const change of [
                "extra",
                "missing",
                "duplicate",
                "host",
                "workflow",
                "commit",
                "arch",
                "version",
                "mode",
            ] as const) {
                const facts = structuredClone(f.facts) as unknown as {
                    [key: string]: unknown;
                    files: Ref[];
                };
                if (change === "extra") facts.extra = true;
                if (change === "missing") facts.files = facts.files.slice(1);
                if (change === "duplicate") facts.files = [...facts.files.slice(1), facts.files[1]!];
                if (change === "host") facts.files[0] = { ...facts.files[0]!, sha256: "0".repeat(64) };
                if (change === "workflow") {
                    const index = facts.files.findIndex(
                        (file) => file.path === ".github/workflows/runtime-payload-macos.yml",
                    );
                    const workflow = facts.files[index];
                    assert.ok(workflow);
                    facts.files[index] = { ...workflow, sha256: "0".repeat(64) };
                }
                if (change === "commit") facts.commit = "b".repeat(40);
                if (change === "arch") facts.arch = "arm64";
                if (change === "version") facts.nodeVersion = "24.0.0";
                const content = Buffer.from(JSON.stringify(facts));
                await writeFile(join(f.root, "evidence/source.json"), content);
                if (change === "mode") {
                    const { chmod } = await import("node:fs/promises");
                    await chmod(join(f.root, "evidence/source.json"), 0o666);
                }
                await assert.rejects(
                    acquireMacRuntimeAssets(
                        "x64",
                        {
                            commit: f.source.commit,
                            evidence: fact("evidence/source.json", content),
                        },
                        { inputRoot: f.root, outputParent: f.output, candidateName: change },
                    ),
                );
                assert.equal(calls, 0);
                assert.deepEqual(await readdir(f.output), []);
            }
        });
    } finally {
        https.request = original;
    }
});

/**
 * 受控网络错误使用真正流及 close 事件来检验 owner 的资源收尾，官方顶层成功仍只能在真实 Mac CI 中证明；超时用测试虚拟时
 * 钟推进固定生产期限，不通过暴露可覆盖限额或放宽描述符来缩短生产政策。
 */
for (const scenario of ["status", "redirect", "headers-timeout", "cancel", "close"] as const)
    test(`acquisition owner bounded rejection ${scenario}`, async (t) => {
        const https = (await import("node:https")).default,
            { EventEmitter } = await import("node:events"),
            { PassThrough } = await import("node:stream");
        const original = https.request,
            space = ArchiveTransaction.prototype.checkSpace;
        let calls = 0,
            requestClosed = false;
        const controller = new AbortController();
        if (["headers-timeout", "close"].includes(scenario)) t.mock.timers.enable({ apis: ["setTimeout"] });
        ArchiveTransaction.prototype.checkSpace = async function () {
            this.check();
        };
        https.request = ((_url: unknown, _options: unknown, callback: (r: unknown) => void) => {
            calls++;
            const req = new EventEmitter() as import("node:http").ClientRequest;
            let destroyed = false;
            req.end = (() => {
                queueMicrotask(() => {
                    if (scenario === "headers-timeout") {
                        t.mock.timers.tick(30001);
                        return;
                    }
                    if (scenario === "cancel") {
                        controller.abort();
                        return;
                    }
                    const res = new PassThrough() as unknown as import("node:http").IncomingMessage;
                    res.statusCode = scenario === "redirect" ? 302 : 500;
                    res.rawHeaders = scenario === "redirect" ? ["Location", "https://unapproved.invalid/"] : [];
                    res.setTimeout = () => res;
                    callback(res);
                    if (scenario === "close") setImmediate(() => t.mock.timers.tick(5001));
                });
                return req;
            }) as typeof req.end;
            req.destroy = ((error?: Error) => {
                if (!destroyed) {
                    destroyed = true;
                    if (error) queueMicrotask(() => req.emit("error", error));
                    if (scenario !== "close")
                        queueMicrotask(() => {
                            requestClosed = true;
                            req.emit("close");
                        });
                }
                return req;
            }) as typeof req.destroy;
            return req;
        }) as typeof https.request;
        try {
            await assetsFixture(async (f) => {
                await assert.rejects(
                    acquireMacRuntimeAssets("x64", f.source, {
                        inputRoot: f.root,
                        outputParent: f.output,
                        candidateName: scenario,
                        signal: controller.signal,
                    }),
                    (e: unknown) => {
                        assert.equal(
                            (e as { code: string }).code,
                            scenario === "cancel" ? "PAYLOAD_CANCELLED" : "PAYLOAD_IO",
                        );
                        if (scenario === "close") assert.equal((e as { cleanup: string }).cleanup, "INCOMPLETE");
                        return true;
                    },
                );
                assert.equal(calls, 1);
                assert.equal(requestClosed, scenario !== "close");
            });
        } finally {
            https.request = original;
            ArchiveTransaction.prototype.checkSpace = space;
            t.mock.timers.reset();
        }
    });

/**
 * 磁盘不足通过事务真实消费的内部空间检查注入固定错误，不能为了测试启动网络或把有限预算改成环境可配置项；请求替身只统计
 * 是否误触发，事务仍执行真实锁、目录及最终清理，输出父根必须恢复为空。
 */
test("forced disk failure issues zero requests and cleans owned transaction", async () => {
    const https = (await import("node:https")).default,
        original = https.request;
    let calls = 0;
    https.request = (() => {
        calls++;
        throw Error("UNEXPECTED_REQUEST");
    }) as typeof https.request;
    const space = ArchiveTransaction.prototype.checkSpace;
    let checks = 0;
    ArchiveTransaction.prototype.checkSpace = async function () {
        if (++checks > 0) this.fail("PAYLOAD_DISK_INSUFFICIENT");
    };
    try {
        await assetsFixture(async (f) => {
            await assert.rejects(
                acquireMacRuntimeAssets("x64", f.source, {
                    inputRoot: f.root,
                    outputParent: f.output,
                    candidateName: "space",
                }),
                { code: "PAYLOAD_DISK_INSUFFICIENT" },
            );
            assert.equal(calls, 0);
            const { readdir } = await import("node:fs/promises");
            assert.deepEqual(await readdir(f.output), []);
        });
    } finally {
        https.request = original;
        ArchiveTransaction.prototype.checkSpace = space;
    }
});

/**
 * 提交夹具保留完整官方校验文本原字节，正例必须同时核长度、真实摘要和生产消费者中的两架构记录，再改变一个字节证明拒绝；
 * 测试不读取私有计划证据、不联网、不替换密码学，也不把微型正文伪装成固定官方归档。
 */
test("actual stored checksum text validates and altered text fails", async () => {
    const { officialNodeChecksumFixture } = await import("./fixtures/runtime-assets.ts");
    const { checkNodeChecksum } = await import("../scripts/runtime-assets-observation.ts");
    const bytes = officialNodeChecksumFixture();
    assert.equal(bytes.length, 3171);
    assert.equal(fact("checksum", bytes).sha256, "fdfbffc969c0f604beff0124d409b33a43b53f5c681d6220f80023e0d6df9dc4");
    checkNodeChecksum(bytes);
    bytes[0] = bytes[0]! ^ 1;
    assert.throws(() => checkNodeChecksum(bytes), { code: "PAYLOAD_ARCHIVE_HASH" });
    checkNodeChecksum(officialNodeChecksumFixture());
});

/**
 * 小型镜像只复制已提交测试及其三份微型夹具，借用现有只读生产脚本和依赖链接以隔离真正缺失的私有证据路径；目标测试必须成
 * 功加载并真实通过，而不是因模块缺失提前失败，也不声称这等同全新独立依赖安装或完整克隆验收。
 */
test("committed checksum regression runs without any private evidence directory", async () => {
    const { mkdtemp, mkdir, copyFile, symlink, lstat, rm } = await import("node:fs/promises"),
        { tmpdir } = await import("node:os"),
        { join } = await import("node:path"),
        { fileURLToPath } = await import("node:url");
    const base = await mkdtemp(join(tmpdir(), "veriq-committed-checksum-")),
        runtime = join(base, "apps/runtime");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    try {
        await mkdir(join(runtime, "tests/fixtures"), { recursive: true, mode: 0o700 });
        for (const name of ["package.json", "tsconfig.json"])
            await copyFile(join(root, "apps/runtime", name), join(runtime, name));
        await copyFile(join(root, "tsconfig.base.json"), join(base, "tsconfig.base.json"));
        await copyFile(fileURLToPath(import.meta.url), join(runtime, "tests/runtime-assets-acquisition.test.ts"));
        for (const name of ["runtime-assets.ts", "runtime-payload.ts", "runtime-payload-archives.ts"])
            await copyFile(join(root, "apps/runtime/tests/fixtures", name), join(runtime, "tests/fixtures", name));
        await symlink(join(root, "apps/runtime/scripts"), join(runtime, "scripts"), "dir");
        await symlink(join(root, "apps/runtime/node_modules"), join(runtime, "node_modules"), "dir");
        await symlink(join(root, "node_modules"), join(base, "node_modules"), "dir");
        await assert.rejects(lstat(join(base, ".superpowers")), { code: "ENOENT" });
        // 嵌套测试进程必须移除父 runner 的内部 IPC 上下文并显式使用文本报告，否则 Node 会把独立 child 当作已有 runner
        // 通道而直接退出；这里仅复制子环境，不修改当前进程或跳过目标回归的任何断言。
        const childEnvironment = { ...process.env };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "--test",
                "--test-reporter=tap",
                "--test-name-pattern",
                "^actual stored checksum text validates and altered text fails$",
                "tests/runtime-assets-acquisition.test.ts",
            ],
            {
                cwd: runtime,
                encoding: "utf8",
                timeout: 15000,
                maxBuffer: 65536,
                env: childEnvironment,
            },
        );
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /tests 1/);
        assert.match(result.stdout, /pass 1/);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
