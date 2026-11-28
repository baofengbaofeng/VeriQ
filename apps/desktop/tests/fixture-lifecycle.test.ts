import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackFixture, stopFixture } from "../../../tests/e2e/lifecycle.ts";

/**
 * 子进程持有真实 SQLite 排他事务，收到终止信号后仍等待测试明确释放，排空期间下一位拥有者不能进入；
 * 这个回归检查真实 close 与文件锁释放，不用睡眠、强制删锁或重复启动把竞态隐藏。
 */
test("fixture teardown awaits graceful drain and stdio close before releasing the next owner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "veriq-fixture-lock-")));
    const lock = join(root, "database.lock");
    const program = `const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1],{timeout:0});
db.exec('CREATE TABLE IF NOT EXISTS owner(id); BEGIN EXCLUSIVE');
process.on('SIGTERM',()=>console.log('DRAINING'));
process.on('message',()=>{db.exec('COMMIT');db.close();process.disconnect();});
console.log('READY');`;
    const contender = `const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1],{timeout:0});
try {db.exec('BEGIN EXCLUSIVE;COMMIT');db.close();} catch {db.close();process.exitCode=1;}`;
    const child = trackFixture(
        spawn(process.execPath, ["-e", program, lock], {
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
        assert.equal(spawnSync(process.execPath, ["-e", contender, lock]).status, 1);
        child.send("release");
        await stopped;
        assert.equal(child.exitCode, 0);
        assert.equal(spawnSync(process.execPath, ["-e", contender, lock]).status, 0);
    } finally {
        if (child.connected) child.send("release");
        await closed;
        lines.close();
        await rm(root, { recursive: true, force: true });
    }
});
