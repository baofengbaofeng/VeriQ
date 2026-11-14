import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { trackFixture, stopFixture } from "../../../tests/e2e/lifecycle.ts";

/** 真实 flock 子进程收到 SIGTERM 后保持受控排空状态，只有测试明确释放才退出，下一位锁拥有者在此之前必须无法进入；这个回归检查真实 close 与文件锁释放，不用睡眠、强制删锁或重复启动把竞态隐藏。 */
test("fixture teardown awaits graceful drain and stdio close before releasing the next owner", async () => {
    const root = await mkdtemp("/tmp/veriq-fixture-lock-");
    const lock = join(root, "database.lock");
    const program = `process.on('SIGTERM',()=>console.log('DRAINING')); process.on('message',()=>{process.disconnect();}); console.log('READY');`;
    const child = trackFixture(
        spawn("flock", ["-n", "-F", lock, process.execPath, "-e", program], {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        }),
    );
    const closed = once(child, "close");
    assert(child.stdout);
    const lines = createInterface({ input: child.stdout });
    try {
        assert.deepEqual(await once(lines, "line"), ["READY"]);
        let finished = false;
        const stopped = stopFixture(child).then(() => {
            finished = true;
        });
        assert.deepEqual(await once(lines, "line"), ["DRAINING"]);
        assert.equal(finished, false);
        assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 1);
        child.send("release");
        await stopped;
        assert.equal(child.exitCode, 0);
        assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 0);
    } finally {
        if (child.connected) child.send("release");
        await closed;
        lines.close();
        await rm(root, { recursive: true, force: true });
    }
});
