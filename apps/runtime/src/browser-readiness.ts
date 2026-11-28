import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { browserMode, requireBrowserExecutableMode, type BrowserMode } from "./browser-policy.ts";
import { offlineWorkerEnvironment } from "./offline/worker-environment.ts";

/**
 * Doctor 按执行端所选模式真实启动沙箱浏览器，环境只含既有窄白名单，取消或沙箱不可用直接失败；业务任务的浏览器准入
 * 由同一 Attempt 内的受控 Playwright 夹具完成，不调用此函数另起诊断窗口，也不重试禁用沙箱。
 */
export async function browserReadiness(options: {
    executablePath: string;
    browserMode?: BrowserMode;
    signal?: AbortSignal;
    runnerExecutable?: string;
    temporaryDirectory?: string;
}): Promise<{ version: string; rendered: boolean }> {
    const headless = browserMode(options.browserMode) === "headless";
    options.signal?.throwIfAborted();
    const executablePath = await requireBrowserExecutableMode(options.executablePath, options.browserMode);
    const root = await mkdtemp(join(await realpath(options.temporaryDirectory ?? tmpdir()), "veriq-browser-probe-"));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const cancel = () => void browser?.close().catch(() => {});
    try {
        const environment = offlineWorkerEnvironment(root, "", headless, process.env, {
            ...(options.runnerExecutable ? { runnerExecutable: options.runnerExecutable } : {}),
        });
        delete environment.VERIQ_EXECUTION_CONTEXT_MODULE;
        browser = await chromium.launch({
            executablePath,
            chromiumSandbox: true,
            headless,
            timeout: 10_000,
            env: environment,
        });
        options.signal?.addEventListener("abort", cancel, { once: true });
        options.signal?.throwIfAborted();
        const page = await browser.newPage();
        await page.setContent("<title>VeriQ doctor</title>", { timeout: 5_000 });
        const result = { version: browser.version(), rendered: (await page.title()) === "VeriQ doctor" };
        options.signal?.throwIfAborted();
        return result;
    } finally {
        options.signal?.removeEventListener("abort", cancel);
        await browser?.close();
        await rm(root, { recursive: true, force: true });
    }
}
