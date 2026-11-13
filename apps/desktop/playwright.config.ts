import { defineConfig } from "@playwright/test";

/** Electron 测试按单 worker 运行且不自动重试，数据库组成场景另持全仓共用 flock；失败保留真实截图与日志，输出进入私有任务证据目录而不是纳入产品源码或冒充目标 OS 安装验收。 */
export default defineConfig({
    testDir: "../../tests/e2e",
    testMatch: "desktop.spec.ts",
    workers: 1,
    retries: 0,
    timeout: 60000,
    outputDir: "../../.superpowers/sdd/veriq-1/evidence/t19/playwright-results",
    reporter: [["line"]],
});
