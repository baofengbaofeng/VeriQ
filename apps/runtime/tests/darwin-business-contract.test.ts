/** 可移植回归只验证可信能力拒绝和既有内核后端的合同，不修改 process.platform、不模拟 Mac 文件语义，也不把这组通过数算入
 * 真实 Mac 业务；新接口缺省与坏数据都必须在业务下载或受控派生之前保持失败关闭。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    mkdtemp,
    rm,
    realpath,
    mkdir,
    writeFile,
    copyFile,
    unlink,
    symlink,
} from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionSupervisor, type SupervisorOptions } from "../src/execution/supervisor.ts";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { runOffline, type OfflineConfig } from "../src/offline/run.ts";
import {
    requireDarwinSource,
    type DarwinSourceCapability,
} from "../src/execution/darwin-source.ts";
import { updatePrivate, readPrivate } from "../src/offline/config.ts";
import { leaseDeadline } from "../src/lease.ts";
import { businessLeaseWindow } from "./fixtures/business-engine.ts";

/** 失去激活回执的第三次探针必须提供恰好六十秒的租约窗口，注入固定及前进一毫秒的真实时间样本后交给生产截止计算校验，避免
 * 独立墙钟采样让有效探针提前失败而掩盖后续激活丢失断言。
 */
for (const step of [1, 0]) {
    test(`business lease window accepts a ${step === 1 ? "one-millisecond advancing" : "fixed"} clock`, () => {
        const timestamp = Date.parse("2026-11-15T12:00:00.000Z");
        let reads = 0;
        const window = businessLeaseWindow(() => timestamp + step * reads++);
        const deadline = leaseDeadline(
            {
                serverTime: window.serverTime,
                leaseExpiresAt: window.expiresAt,
                leaseDurationMs: 60000,
            },
            100,
            110,
        );
        assert.equal(deadline, 59100);
        assert.equal(Date.parse(window.expiresAt) - Date.parse(window.serverTime), 60000);
    });
}

test("serialized or asserted source objects cannot enable online or offline business", async () => {
    for (const value of [
        {},
        Object.freeze({ supported: true, platform: "darwin" }),
        JSON.parse('{"darwinSource":true}'),
    ]) {
        const capability = value as DarwinSourceCapability;
        assert.throws(() => requireDarwinSource(capability), /DARWIN_SOURCE_CAPABILITY_REQUIRED/);
        assert.throws(
            () => new ExecutionSupervisor({ darwinSource: capability } as SupervisorOptions),
            /DARWIN_SOURCE_CAPABILITY_REQUIRED/,
        );
        await assert.rejects(
            runOffline({ directory: "must-not-be-read" }, {
                darwinSource: capability,
            } as OfflineConfig),
            /DARWIN_SOURCE_CAPABILITY_REQUIRED/,
        );
    }
});

test("private JSON updates retain the one MiB caller cap and previous committed state", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-config-cap-"));
    try {
        await updatePrivate(root, "config.json", () => ({ value: "retained" }));
        await assert.rejects(
            updatePrivate(root, "config.json", () => ({ value: "x".repeat(1024 * 1024) })),
            /CONFIGURATION_LIMIT/,
        );
        assert.deepEqual(await readPrivate(root, "config.json"), { value: "retained" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test(
    "the optional Darwin deadline leaves the actual Linux kernel drain unchanged",
    { skip: process.platform !== "linux" },
    async () => {
        const root = await mkdtemp(join(tmpdir(), "veriq-legacy-deadline-"));
        const processes = new ProcessSupervisor(root);
        try {
            const child = await processes.start("legacy-deadline", {
                executable: process.execPath,
                args: ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
                cwd: root,
            });
            await child.firstLine();
            const stop = await processes.terminateAttempt(
                "legacy-deadline",
                "TEST_STOP",
                Number.NaN,
            );
            assert.equal(stop.processStopped, true);
            assert.equal(stop.processStopScope, "FULL_DESCENDANT_TREE");
            await child.exited;
        } finally {
            await processes.terminateAttempt("legacy-deadline", "TEST_FINALLY");
            await rm(root, { recursive: true, force: true });
        }
    },
);

/** 诊断等待器使用真实 HTTP 监听对象和 AbortSignal 验证提前完成、拒绝与取消都会返回控制流，finally 必须关闭本次资源并移
 * 除监听；这些 Promise 只表示夹具调度结果，不伪造 SDK 用例结果、原生停止
 * 证明或浏览器退出事实。
 */
for (const scenario of ["fulfilled", "rejected", "cancelled", "ready"] as const)
    test(`business diagnostic watch releases owned resource after ${scenario}`, async () => {
        const { createServer } = await import("node:http");
        const { default: EventEmitter } = await import("node:events");
        const helper = await import("./fixtures/business-engine.ts");
        const server = createServer((_request, response) => response.end());
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const controller = new AbortController(),
            before = EventEmitter.getEventListeners(controller.signal, "abort").length;
        let finish!: (value: number) => void, reject!: (error: Error) => void;
        const running = new Promise<number>((resolve, fail) => {
            finish = resolve;
            reject = fail;
        });
        let watch:
            | {
                  waitFor(ready: Promise<unknown>, phase: "BARRIER" | "STOP"): Promise<void>;
                  result(): Promise<number>;
                  close(): void;
              }
            | undefined;
        try {
            const factory = Reflect.get(helper, "watchBusinessRun");
            assert.equal(
                typeof factory,
                "function",
                "Business diagnostics need an immediate run completion/rejection observer",
            );
            watch = factory(running, controller.signal);
            const readiness =
                scenario === "ready" ? Promise.resolve() : new Promise<void>(() => {});
            const observed = watch!.waitFor(readiness, "BARRIER");
            if (scenario === "fulfilled") {
                finish(7);
                await assert.rejects(observed, /BUSINESS_RUN_COMPLETED_BEFORE_BARRIER/);
            }
            if (scenario === "rejected") {
                reject(new Error("private-unprinted-source"));
                await assert.rejects(observed, /BUSINESS_RUN_REJECTED_BEFORE_BARRIER/);
            }
            if (scenario === "cancelled") {
                controller.abort(new Error("private-unprinted-cancellation"));
                await assert.rejects(observed, /BUSINESS_TEST_CANCELLED/);
            }
            if (scenario === "ready") {
                await observed;
                finish(7);
                assert.equal(await watch!.result(), 7);
            }
        } finally {
            finish(7);
            watch?.close();
            await new Promise<void>((resolve, fail) =>
                server.close((error) => (error ? fail(error) : resolve())),
            );
        }
        assert.equal(server.listening, false);
        assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, before);
    });

/** 主报告角色来自实际收集器的固定路径及交付别名，viewer 和被引用 HTML 依然保留原始字节扫描，但不能被要求拥有主报告内嵌
 * ZIP；这个合同避免普通 viewer 资产使退出事实观察器变成异步拒绝并污染下一项夹具的恢复顺
 * 序。
 */
test("business report roles distinguish actual report entry from referenced viewer HTML", async () => {
    const helper = await import("./fixtures/business-engine.ts");
    const classify = Reflect.get(helper, "businessArtifactRole");
    assert.equal(typeof classify, "function");
    for (const path of ["html/index.html", "report.html"])
        assert.equal(classify(path), "MAIN_HTML");
    for (const path of [
        "html/trace/index.html",
        "html/trace/snapshot.html",
        "html/data/attachment.html",
    ])
        assert.equal(classify(path), "DATA");
    assert.equal(classify("playwright.json"), "JSON");
    assert.equal(classify("case/trace.zip"), "TRACE");
});

/** 真实小目录保留私有配置及其成对编译缓存，以相同端点标记检验操作输入不会冒充交付文件；复制到报告、伪造缓存目录、损坏来
 * 源、引用缓存及缓存内 Trace 都必须重新触发扫描，不能靠目录名排除阳性。
 */
test(
    "business artifact walk separates proven private input cache and still rejects delivered copies and references",
    { skip: process.platform === "win32" },
    async () => {
        const { visitBusinessArtifacts } = await import("./fixtures/business-engine.ts");
        const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-cache-role-"));
        const work = join(root, "work"),
            tmp = join(root, "tmp"),
            marker = "ws://127.0.0.1:12345/private-operational-test-marker";
        try {
            await mkdir(work, { mode: 0o700 });
            await mkdir(tmp, { mode: 0o700 });
            const config = join(work, "playwright.config.mjs"),
                source = `export default ${JSON.stringify({ use: { connectOptions: { wsEndpoint: marker } } })};`;
            await writeFile(config, source, { mode: 0o600 });
            const canonical = await realpath(config),
                hash = createHash("sha1").update(canonical).digest("hex").slice(0, 10);
            const cache = join(
                tmp,
                `playwright-transform-cache-${process.geteuid?.()}`,
                hash.slice(0, 2),
            );
            await mkdir(cache, { recursive: true, mode: 0o700 });
            const stem = `${hash}_abcdef0_playwrightconfig`,
                js = join(cache, stem + ".js"),
                map = join(cache, stem + ".map");
            const code = `// ${createHash("sha1").update(source).digest("hex")}\n${source}`;
            const mapping = JSON.stringify({
                version: 3,
                sources: [canonical],
                sourcesContent: [source],
                names: [],
                mappings: "",
            });
            await writeFile(js, code, { mode: 0o600 });
            await writeFile(map, mapping, { mode: 0o600 });
            await writeFile(join(tmp, "playwright.json"), '{"safe":true}', { mode: 0o600 });
            let inventoryFiles = 0,
                inventoryBytes = 0,
                reference: (bytes: Buffer) => boolean = () => false;
            const seen: string[] = [];
            const inspect = async (bytes: Buffer, name: string) => {
                seen.push(name);
                if (bytes.includes(marker) || reference(bytes))
                    throw new Error("PRIVATE_ENDPOINT_DISCLOSURE");
            };
            const walk = () =>
                visitBusinessArtifacts(tmp, work, inspect, (inventory) => {
                    inventoryFiles = inventory.files;
                    inventoryBytes = inventory.bytes;
                    reference = inventory.containsReference;
                    assert.equal(inventory.sha256.length, inventory.files);
                });
            await walk();
            assert.equal(inventoryFiles, 2);
            assert.equal(inventoryBytes, Buffer.byteLength(code + mapping));
            assert.deepEqual(seen, ["playwright.json"]);
            assert.ok(Buffer.byteLength(source + code + mapping) < 16 * 1024);
            const alias = join(root, "work-alias");
            await symlink(work, alias);
            await visitBusinessArtifacts(tmp, alias, inspect, (inventory) =>
                assert.equal(inventory.files, 2),
            );
            await assert.rejects(
                visitBusinessArtifacts(tmp, work, inspect, () => {
                    const replacement = join(cache, "replacement.js");
                    writeFileSync(replacement, code, { mode: 0o600 });
                    renameSync(replacement, js);
                }),
                /OPERATIONAL_INPUT_CHANGED/,
            );
            await assert.rejects(
                visitBusinessArtifacts(tmp, work, inspect, () => {
                    writeFileSync(config, source + " ");
                }),
                /OPERATIONAL_INPUT_CHANGED/,
            );
            await writeFile(config, source);
            const data = join(tmp, "html", "data");
            await mkdir(data, { recursive: true, mode: 0o700 });
            for (const original of [js, map]) {
                const copy = join(data, "attachment");
                await copyFile(original, copy);
                await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
                await unlink(copy);
            }
            const disguised = join(
                data,
                `playwright-transform-cache-${process.geteuid?.()}`,
                hash.slice(0, 2),
            );
            await mkdir(disguised, { recursive: true, mode: 0o700 });
            await copyFile(map, join(disguised, stem + ".map"));
            await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
            await rm(join(data, `playwright-transform-cache-${process.geteuid?.()}`), {
                recursive: true,
            });
            for (const [path, corrupt, original] of [
                [map, mapping.replace(source.replaceAll('"', '\\"'), "OTHER_SOURCE"), mapping],
                [js, code.replace(/^\/\/ [a-f0-9]{40}/, "// invalid"), code],
            ] as const) {
                await writeFile(path, corrupt);
                await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
                await writeFile(path, original);
            }
            await unlink(map);
            await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
            await symlink(config, map);
            await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
            await unlink(map);
            await writeFile(map, mapping, { mode: 0o600 });
            await writeFile(join(cache, "trace.zip"), marker);
            await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
            assert.ok(seen.some((path) => path.endsWith("/trace.zip")));
            await unlink(join(cache, "trace.zip"));
            for (const value of [
                js,
                stem + ".map",
                encodeURIComponent(map),
                Buffer.from(js).toString("base64"),
            ]) {
                await writeFile(join(data, "reference.txt"), value);
                await assert.rejects(walk(), /PRIVATE_ENDPOINT_DISCLOSURE/);
            }
            await unlink(join(data, "reference.txt"));
            assert.equal(reference(Buffer.from(JSON.stringify({ source: js }))), true);
            assert.equal(reference(Buffer.from("safe decoded archive member")), false);
            await walk();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

test("failed artifact observation preserves actual resource exit facts and blocks delivery", async () => {
    const { createServer } = await import("node:http");
    const helper = await import("./fixtures/business-engine.ts");
    const observe = Reflect.get(helper, "observeBusinessExit");
    assert.equal(typeof observe, "function");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const facts = { code: 1, signal: null };
        const exit = new Promise<typeof facts>((resolve) => server.close(() => resolve(facts)));
        const observation = observe(exit, async () => {
            throw new Error("private-unprinted-source");
        });
        assert.equal(await observation.exited, facts);
        assert.throws(() => observation.assertClean(), /BUSINESS_ARTIFACT_SCAN_FAILED/);
        assert.equal(server.listening, false);
    } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

/** 真实 HTTP 观察保持在本次拥有的资源内，扫描故障必须立即被粘性门禁吸收而非派生退出拒绝；旧补丁直到观察完成才恢复，下一
 * 补丁只能在收尾完成后取得所有权，验证异步解析失败不会越过测试边界覆写后续用例的函数。
 */
test("business observation settles before owned patch restoration and the next fixture", async () => {
    const { createServer } = await import("node:http");
    const { observeBusinessExit } = await import("./fixtures/business-engine.ts");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const server = createServer((_request, response) => {
        release = () => response.end();
        entered();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const target = { patch: "original" },
        facts = { code: 1, signal: null };
    target.patch = "first";
    const observation = observeBusinessExit(Promise.resolve(facts), async () => {
        await fetch(origin);
        throw new Error("OBSERVATION_TEST_FAILURE");
    });
    let derivedRejected = false;
    const derived = observation.exited.then(
        () => {},
        () => {
            derivedRejected = true;
        },
    );
    const cleanup = (async () => {
        try {
            return await Promise.allSettled([observation.exited]);
        } finally {
            target.patch = "original";
        }
    })();
    try {
        await started;
        assert.equal(target.patch, "first");
        release();
        const settled = await cleanup;
        await derived;
        assert.equal(settled[0]!.status, "fulfilled");
        assert.equal(derivedRejected, false);
        assert.throws(() => observation.assertClean(), /BUSINESS_ARTIFACT_SCAN_FAILED/);
        assert.equal(target.patch, "original");
        target.patch = "next";
        await Promise.resolve();
        assert.equal(target.patch, "next");
    } finally {
        release?.();
        await cleanup;
        await derived;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
