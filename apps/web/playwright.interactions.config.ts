/**
 * 真实组件回归单独启动开发服务器，以生产组件和样式验证抽屉交互，不引入数据库、引擎或完整业务初始化。
 * 输出隔离到忽略的缓存目录，便于持续集成在失败时保留截图、追踪与结构化结果。
 * 主业务配置显式排除此文件对应的用例，因此本配置是该组件切片的唯一浏览器入口。
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    testMatch: "interactions.spec.ts",
    workers: 1,
    retries: 0,
    outputDir: "../../.superpowers/cache/r02-web-components/results",
    reporter: [["list"], ["junit", { outputFile: "../../.superpowers/cache/r02-web-components/junit.xml" }]],
    use: {
        baseURL: "http://127.0.0.1:5173",
        viewport: { width: 1280, height: 800 },
        actionTimeout: 5_000,
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    webServer: {
        command: "pnpm dev --host 127.0.0.1 --port 5173",
        url: "http://127.0.0.1:5173/tests/interaction-fixture.html",
        reuseExistingServer: false,
    },
});
