import { chromium } from "@playwright/test";

/**
 * 物理测试默认从 Runtime 的锁定 Playwright 安装中取得 Chromium 路径，显式覆盖仍由发行自检核对实际版本。
 */
export function chromiumForTest(): string {
    return process.env.VERIQ_TEST_CHROMIUM || chromium.executablePath();
}
