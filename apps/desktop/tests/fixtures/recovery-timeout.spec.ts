import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { recoveryTest as test } from "../../../../tests/e2e/owned-recovery";
import { stopFixture, trackFixture } from "../../../../tests/e2e/lifecycle";

/**
 * 由外层单测在私有目录单独启动真实测试进程，故意让正文用完预算，同时让后继启动等到夹具实际撤销所有权才完成。
 */
test("the runner tears down an owner while its body is suspended", async ({ owned }) => {
    test.setTimeout(1500);
    const root = process.env.VERIQ_TEST_RECOVERY_DIRECTORY;
    if (!root) throw new Error("RECOVERY_PROBE_DIRECTORY_REQUIRED");
    const record = (state: string) => appendFileSync(join(root, "events"), state + "\n");
    const child = trackFixture(
        spawn(
            process.execPath,
            [
                "-e",
                `
        const {DatabaseSync}=require('node:sqlite');
        const db=new DatabaseSync(process.argv[1]);
        db.exec('CREATE TABLE held(id); BEGIN EXCLUSIVE');
        process.on('SIGTERM',()=>{db.close();process.exit(0)});
        setTimeout(()=>process.exit(9),10000);
        console.log('ready');
    `,
                join(root, "held.db"),
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
        ),
    );
    owned.defer(async () => {
        await stopFixture(child);
        record("server-closed");
    });
    await once(child.stdout, "data");
    let complete!: () => void;
    owned.defer(async () => complete());
    record("started");
    try {
        await owned.acquire(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                }),
            async () => record("late-disposed"),
        );
        record("late-delivered");
    } catch {
        record("revoked");
    }
});
