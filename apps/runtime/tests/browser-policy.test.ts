import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "../src/browser-policy.ts";
import { ExecutionSupervisor, type SupervisorOptions } from "../src/execution/supervisor.ts";

/**
 * Runtime 的可信宿主配置仍须严格拒绝非枚举模式，避免拼写错误或宽松布尔转换把原本预期的无头任务意外变成可见浏览器执行。
 */
test("supervisor rejects invalid private browser modes before accepting any Attempt", () => {
    for (const browserMode of [false, true, null, "", "HEADLESS", "headed\n", {}, 1]) {
        assert.throws(
            () =>
                new ExecutionSupervisor({
                    root: "/unused",
                    client: {} as SupervisorOptions["client"],
                    releaseDirectory: "/unused",
                    browserExecutable: "/unused",
                    browserMode,
                } as unknown as SupervisorOptions),
            /INVALID_BROWSER_MODE/,
        );
    }
});

/**
 * 已知无头专用分发不能成为有头候选，未知重命名也不获得完整浏览器资格；官方完整发行的名称只用于窄类型识别，授权仍由原有
 * 库存、版本与内容哈希校验承担，不能把名称识别结果当作安装发行的真实性证明。
 */
test("browser distribution identifies known headless shells and official full Chromium names", async () => {
    assert.equal(typeof policy.browserDistribution, "function");
    for (const name of ["chrome-headless-shell", "headless_shell", "headless_shell.exe", "custom-shell"]) {
        assert.equal(policy.browserDistribution(`/trusted/${name}`), "headless-shell");
        await assert.rejects(
            policy.requireBrowserExecutableMode(`/trusted/${name}`, "headed"),
            /HEADED_BROWSER_REQUIRED/,
        );
        assert.equal(await policy.requireBrowserExecutableMode(`/trusted/${name}`, "headless"), `/trusted/${name}`);
    }
    for (const name of ["chrome", "chrome.exe", "Chromium", "chromium.exe", "Google Chrome for Testing"]) {
        assert.equal(policy.browserDistribution(`/trusted/${name}`), "headed");
    }
    assert.equal(policy.browserDistribution("/trusted/renamed-browser"), "unknown");
    await assert.rejects(
        policy.requireBrowserExecutableMode("/trusted/renamed-browser", "headed"),
        /HEADED_BROWSER_REQUIRED/,
    );
});
