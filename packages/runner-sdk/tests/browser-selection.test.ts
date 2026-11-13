/** 浏览器选择验收通过真实 fixture 启动测试浏览器并检查其实际版本，默认必须等于已锁定 Playwright 元数据声明的版本，防止开发机器的系统 Chromium 悄悄替换正式门禁的运行输入。
 * 显式 VERIQ_TEST_CHROMIUM 仍是操作员可用的可移植覆盖。
 * 覆盖存在时只验证实际启动成功，不声称它等于官方发行。
 * 此测试不增加取消超时，也不改变全套测试的工作进程数量。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "./helpers.js";

test("uses the pinned browser unless an explicit executable override is supplied", async () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("playwright-core/package.json"));
    const metadata = JSON.parse(readFileSync(join(root, "browsers.json"), "utf8"));
    const expected = metadata.browsers.find((entry: { name: string }) => entry.name === "chromium");
    const current = await fixture();
    try {
        const browser = current.page.context().browser();
        if (!browser) throw new Error("Browser fixture returned no browser");
        const version = browser.version();
        expect(version).toBeTruthy();
        if (!process.env.VERIQ_TEST_CHROMIUM) expect(version).toBe(expected.browserVersion);
    } finally {
        await current.close();
    }
});
