/**
 * 线上真实业务夹具与 Mac source suite 共用同一冻结引擎、HTTP 控制夹具及上传摘要核验，Linux 仍验证内核全部后代范围；本
 * 入口保留原有失败、重试成功、丢失激活与受限 Trace 回归，不依赖任何付费模型或
 * 外部平台。
 */
import { test } from "node:test";
import { mkdtemp, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onlineBusiness } from "./fixtures/business-engine.ts";
test(
    "actual approved generated TS runs with fresh browser/fixture/workdir and real restricted traces",
    { timeout: 180000 },
    async () => {
        await onlineBusiness();
    },
);

/**
 * 实际在线 Attempt 移除浏览器先决条件后仍走真实清单、租约与受控执行器，必须在激活、业务凭据解析、身份查询及夹具调用之前
 * 失败关闭，不能让缺失浏览器的错误延迟到已经产生业务副作用之后。
 */
test(
    "missing sandboxed browser fails an online Attempt before credentials or fixtures",
    { timeout: 180000 },
    async () => {
        await onlineBusiness({ browserExecutable: "/absent/veriq-browser", expectPreflightFailure: true });
    },
);

/**
 * 可执行文件存在却无法启动 Chromium 时，真实 Playwright worker 必须在 SDK 请求业务凭据或夹具之前失败；实际 guardian
 * 已经派生，停止证明必须保留全部后代范围而不能回写为未启动进程。
 */
test(
    "real browser launch rejection closes the owned Attempt before credentials or fixtures",
    { timeout: 180000 },
    async () => {
        await onlineBusiness({ browserExecutable: "/usr/bin/false", expectBrowserStartFailure: true });
    },
);

/**
 * 有头 Linux 任务缺少本机会话显示连接时必须在启动前拒绝，测试只移除当前用例的显示变量并恢复原值，不能把有头选择静默
 * 降级成无头，也不能先向平台请求业务凭据再发现无法打开窗口。
 */
test("headed Attempt without a display fails before credentials or fixtures", { timeout: 180000 }, async () => {
    const previous = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
        await onlineBusiness({
            browserMode: "headed",
            expectPreflightFailure: true,
            expectedPreflightReason: "VISIBLE_DISPLAY_UNAVAILABLE",
        });
    } finally {
        if (previous === undefined) delete process.env.DISPLAY;
        else process.env.DISPLAY = previous;
    }
});

/**
 * Linux 受控 TEST 不能把现存无头专用可执行文件解释成有头浏览器，真实控制面与业务夹具仍须零认证和零副作用；候选只用于
 * 测试拒绝顺序，不能因为测试文件可执行就授予运行时发行或来源信任。
 */
test("headed shell alias fails before credentials or fixtures", { timeout: 180000 }, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-headed-shell-"));
    const browserExecutable = join(root, "chrome-headless-shell");
    try {
        await writeFile(browserExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        const alias = join(root, "chrome");
        await symlink(browserExecutable, alias);
        await onlineBusiness({
            browserExecutable: alias,
            browserMode: "headed",
            expectPreflightFailure: true,
            expectedPreflightReason: "HEADED_BROWSER_REQUIRED",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
