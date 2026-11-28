import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    desktopCloseReceipts,
    observeDesktopProcess,
    type startTestDesktopClose,
} from "../../../tests/e2e/desktop-close";
import { OwnedRecovery } from "../../../tests/e2e/owned-recovery";

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

type Desktop = Parameters<typeof startTestDesktopClose>[0];
/**
 * 测试直接创建的子进程在收到退出命令后正常结束，其后继进程继续持有所继承的标准流，文件标记只用来控制这个已知持有者。
 */
test("a normal UI exit admits the next window while final recovery still requires both original drains", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-close-child-"));
    const gate = join(directory, "release");
    const holder = [
        "const fs=require('node:fs');",
        "const tick=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(tick)},10);",
        "setTimeout(()=>process.exit(9),8000).unref();",
    ].join("\n");
    const program = `
        const {spawn}=require('node:child_process');
        const stdio=['ignore','inherit','inherit'];
        const descendant=spawn(process.execPath,['-e',process.argv[2],process.argv[1]],{stdio});
        descendant.unref();
        process.once('message',()=>process.exit(0));
        process.send('ready');
    `;
    const children = [0, 1].map(() =>
        spawn(process.execPath, ["-e", program, gate, holder], { stdio: ["ignore", "pipe", "pipe", "ipc"] }),
    );
    const ready = children.map((child) => once(child, "message"));
    const facts = children.map(observeDesktopProcess);
    const windows = children.map((child) => ({ process: () => child }) as unknown as Desktop);
    const acknowledgments = children.map(() => deferred());
    const requests = [0, 0];
    const owner = new OwnedRecovery(
        async () => ({ ok: () => true }),
        (app) => {
            const i = windows.indexOf(app),
                child = children[i],
                fact = facts[i],
                ack = acknowledgments[i];
            if (!child || !fact || !ack) throw new Error("UNKNOWN_TEST_WINDOW");
            requests[i] = (requests[i] ?? 0) + 1;
            child.send("quit");
            return desktopCloseReceipts(
                fact,
                Promise.resolve({ confirmed: Promise.resolve(), framework: ack.promise }),
            );
        },
    );
    try {
        await Promise.all(ready);
        for (const window of windows) owner.defer(() => owner.close(window));
        const [first, second] = windows;
        if (!first || !second) throw new Error("MISSING_FIXTURE_WINDOWS");
        await Promise.all([owner.close(first, "quit"), owner.close(first, "quit"), owner.close(second, "quit")]);
        assert.deepEqual(requests, [1, 1]);
        assert.ok(
            children.every(
                (child) =>
                    child.exitCode === 0 &&
                    child.signalCode === null &&
                    child.stdout?.readable &&
                    child.stderr?.readable,
            ),
        );
        let completed = false;
        const finish = owner.stop().then(() => {
            completed = true;
        });
        acknowledgments[0]?.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(completed, false);
        await writeFile(gate, "release");
        await Promise.all(facts.map((fact) => fact.closed));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(completed, false);
        acknowledgments[1]?.resolve();
        await finish;
        assert.deepEqual(requests, [1, 1]);
        assert.throws(() => observeDesktopProcess(children[0] as (typeof children)[number]), /LIVE_CHILD_REQUIRED/);
    } finally {
        for (const child of children) if (child.connected) child.send("quit");
        await writeFile(gate, "release");
        for (const ack of acknowledgments) ack.resolve();
        await Promise.allSettled(facts.map((f) => f.closed));
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * 回执的任一阶段失败都应保留原异常，已经成功的正常退出不能替换迟到的框架拒绝，异常退出也不能因标准流随后关闭而通过。
 */
for (const failure of ["confirmation", "early-framework", "late-framework", "abnormal-exit"] as const)
    test(`final teardown preserves ${failure}`, async () => {
        const child = spawn(
            process.execPath,
            ["-e", "process.once('message', code=>process.exit(code));process.send('ready');"],
            { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        const ready = once(child, "message"),
            facts = observeDesktopProcess(child),
            native = deferred(),
            ack = deferred();
        const reason = new Error("TEST_EXPECTED_REJECTION");
        const ticket = desktopCloseReceipts(
            facts,
            Promise.resolve({ confirmed: native.promise, framework: ack.promise }),
        );
        try {
            await ready;
            if (failure === "confirmation") native.reject(reason);
            else native.resolve();
            if (failure === "early-framework") ack.reject(reason);
            if (failure === "confirmation" || failure === "early-framework")
                await assert.rejects(ticket.exited, reason);
            child.send(failure === "abnormal-exit" ? 3 : 0);
            if (failure === "late-framework") {
                await ticket.exited;
                ack.reject(reason);
            } else if (failure === "abnormal-exit") {
                await assert.rejects(ticket.exited, /ABNORMAL_EXIT/);
                ack.resolve();
            }
            await assert.rejects(ticket.drained, failure === "abnormal-exit" ? /ABNORMAL_EXIT/ : reason);
        } finally {
            if (child.connected) child.send(0);
            ack.resolve();
            native.resolve();
            await facts.closed.catch(() => {});
        }
    });
