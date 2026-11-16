import assert from "node:assert/strict";
import { test } from "node:test";
import { runBoundedAssetCli } from "../scripts/runtime-assets-ci-process.mjs";

// 真实微型子进程用二进制输出验证生命周期边界，去掉任一 close 等待或字节上限都会改变这里的可观察结果；不创建官方归档、不
// 替换摘要算法，也不运行被提取的程序或扩展清理到未登记后代。
const run = (source, timeoutMs = 4000) =>
    runBoundedAssetCli({
        executable: process.execPath,
        args: ["--input-type=module", "-e", source],
        cwd: process.cwd(),
        timeoutMs,
    });
const gone = (result) => {
    if (result.admitted) assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
    assert.equal(result.closeConfirmed, true);
};

test("success preserves exact raw bytes and closes the admitted child", async () => {
    const result = await run(
        "process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(Buffer.from([254,0,13]));",
    );
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 10]));
    assert.deepEqual(result.stderr, Buffer.from([254, 0, 13]));
    assert.equal(result.exit, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.equal(result.admitted, true);
    assert.equal(result.error, null);
    gone(result);
});

test("nonzero exit retains both streams without inventing transaction cleanup", async () => {
    const result = await run(
        'process.stdout.write("receipt"); process.stderr.write("diagnostic"); process.exitCode=23;',
    );
    assert.equal(result.stdout.toString(), "receipt");
    assert.equal(result.stderr.toString(), "diagnostic");
    assert.equal(result.exit, 23);
    assert.equal(result.signal, null);
    assert.equal(result.cleanup, undefined);
    gone(result);
});

test("missing executable settles error then close without admitting a child", async () => {
    const result = await runBoundedAssetCli({
        executable: "/veriq-missing-executable",
        args: [],
        cwd: process.cwd(),
        timeoutMs: 1000,
    });
    assert.equal(result.admitted, false);
    assert.equal(result.pid, null);
    assert.equal(result.error, "ENOENT");
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr.length, 0);
    assert.equal(result.exit, -2);
    gone(result);
});

test("stderr cap retains bounded prefix and an explicit marker", async () => {
    const result = await run("process.stderr.write(Buffer.alloc(5*1024**2, 97));");
    const marker = Buffer.from("\nLOG_TRUNCATED: hash binds this truncated log only\n");
    assert.equal(result.stderr.length, 4 * 1024 ** 2);
    assert.deepEqual(result.stderr.subarray(-marker.length), marker);
    assert.ok(result.stderr.subarray(0, -marker.length).every((byte) => byte === 97));
    assert.equal(result.truncated, true);
    assert.equal(result.exit, 0);
    gone(result);
});

test("stdout overflow stops admission at exactly the raw byte cap", async () => {
    const result = await run("process.stdout.write(Buffer.alloc(128*1024, 98)); setInterval(()=>{},1000);");
    assert.deepEqual(result.stdout, Buffer.alloc(65536, 98));
    assert.equal(result.truncated, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, "SIGTERM");
    gone(result);
});

test("timeout permits actual SIGTERM cleanup and preserves its diagnostic", async () => {
    const result = await run(
        'process.on("SIGTERM",()=>{process.stderr.write("stopped");process.exit(0)});process.stdout.write("ready");s' +
            "etInterval(()=>{},1000);",
        1000,
    );
    assert.equal(result.stdout.toString(), "ready");
    assert.equal(result.stderr.toString(), "stopped");
    assert.equal(result.timedOut, true);
    assert.equal(result.truncated, false);
    assert.equal(result.exit, 0);
    gone(result);
});

test("ignored SIGTERM is forcibly closed within the fixed outer grace", async () => {
    const start = performance.now();
    const result = await run(
        'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);',
        1000,
    );
    assert.equal(result.stdout.toString(), "ready");
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.exit, null);
    assert.ok(performance.now() - start >= 5900);
    assert.ok(performance.now() - start < 8500);
    gone(result);
});

// stdout 溢出也必须进入相同的有限强制关闭通道，不能只有超时分支才安排 SIGKILL；这里让真实子进程忽略首个信号，观察最终信
// 号与完整前缀，确保停止原因不被后来的定时器改写成 timeout。
test("stdout overflow also forcibly closes a child that ignores SIGTERM", async () => {
    const result = await run(
        'process.on("SIGTERM",()=>{});process.stdout.write(Buffer.alloc(128*1024,99));setInterval(()=>{},1000);',
        15000,
    );
    assert.deepEqual(result.stdout, Buffer.alloc(65536, 99));
    assert.equal(result.truncated, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.exit, null);
    gone(result);
});
