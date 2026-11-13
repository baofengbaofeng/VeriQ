import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProcessSupervisor } from "../src/execution/processes.ts";
import { offlineWorkerEnvironment } from "../src/offline/worker-environment.ts";

/** 实际原生监管器启动一个只观察环境的 Node worker，验证可见连接穿过既有 fresh-env 边界且任意父环境秘密没有被继承；本机此例不声称浏览器可见窗口成功，完整 Chromium 窗口另由专门 CI 实证。 */
test("supervised visible worker receives only trusted display connection fields", async () => {
    const root = await mkdtemp("/tmp/veriq-display-env-");
    const processes = new ProcessSupervisor(join(root, "processes"));
    try {
        const child = await processes.start("display-probe", {
            executable: process.execPath,
            args: [
                "-e",
                "console.log(JSON.stringify({display:process.env.DISPLAY??null,authority:process.env.XAUTHORITY??null,secret:process.env.VERIQ_DEVICE_TOKEN??null}));process.on('message',()=>{});",
            ],
            cwd: root,
            env: offlineWorkerEnvironment(root, join(root, "provider.mjs"), false, {
                DISPLAY: ":123.0",
                XAUTHORITY: "/tmp/veriq-display-authority",
                VERIQ_DEVICE_TOKEN: "must-not-inherit",
                LD_PRELOAD: "/untrusted/library",
            }),
        });
        assert.deepEqual(JSON.parse(await child.firstLine()), {
            display: ":123.0",
            authority: "/tmp/veriq-display-authority",
            secret: null,
        });
        assert.equal(
            (await processes.terminateAttempt("display-probe", "TEST_FINISHED")).processStopped,
            true,
        );
    } finally {
        await processes.terminateAttempt("display-probe", "TEST_FINALLY");
        await rm(root, { recursive: true, force: true });
    }
});

/** 无头执行不携带桌面显示授权，可见模式只认可本机 X11 显示编号与有界绝对 authority 路径；远程显示地址、控制字符和相对路径在进程启动前失败，避免把新选项扩展成通用环境注入。 */
test("display environment rejects unsupported connection input and omits it in headless mode", () => {
    const headless = offlineWorkerEnvironment("/tmp/run", "/tmp/run/provider.mjs", true, {
        DISPLAY: ":99",
        XAUTHORITY: "/tmp/auth",
    });
    assert.equal(headless.DISPLAY, undefined);
    assert.equal(headless.XAUTHORITY, undefined);
    for (const DISPLAY of [undefined, "remote.example:0", ":1\n", "--bad", ":999999"])
        assert.throws(
            () => offlineWorkerEnvironment("/tmp/run", "/tmp/run/provider.mjs", false, { DISPLAY }),
            /VISIBLE_DISPLAY_UNAVAILABLE/,
        );
    for (const XAUTHORITY of ["relative", "/tmp/auth\n", "/" + "x".repeat(4096)])
        assert.throws(
            () =>
                offlineWorkerEnvironment("/tmp/run", "/tmp/run/provider.mjs", false, {
                    DISPLAY: ":99",
                    XAUTHORITY,
                }),
            /VISIBLE_AUTHORITY_INVALID/,
        );
});
