/**
 * 在真实 Chromium 中挂载会话使用的 Markdown 组件，核对文本格式和显式链接，并观察渲染是否主动请求远程资源。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "vite";

test("Agent Markdown renders formatting and links without loading remote assets", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const entry = "virtual:agent-markdown-test";
    const moduleId = `\0${entry}`;
    // 使用生产依赖编译实际组件并放入浏览器空页，保持测试独立于工作区、后端和模型供应商夹具。
    const fixture = await build({
        root,
        configFile: false,
        logLevel: "silent",
        esbuild: { jsx: "automatic" },
        plugins: [
            {
                name: "agent-markdown-test",
                resolveId: (id) => (id === entry ? moduleId : undefined),
                load: (id) =>
                    id === moduleId
                        ? [
                              'import { createElement } from "react";',
                              'import { createRoot } from "react-dom/client";',
                              'import { Markdown } from "/src/features/agent/Markdown.tsx";',
                              'const target = document.querySelector("main");',
                              "createRoot(target).render(createElement(Markdown, null, target.textContent));",
                          ].join("\n")
                        : undefined,
            },
        ],
        build: {
            write: false,
            rollupOptions: { input: entry, output: { format: "iife" } },
        },
    });
    const result = Array.isArray(fixture) ? fixture[0] : fixture;
    assert.ok("output" in result);
    const bundled = result.output.find((asset) => asset.type === "chunk");
    assert.ok(bundled);

    const browser = await chromium.launch(
        process.env.VERIQ_TEST_CHROMIUM ? { executablePath: process.env.VERIQ_TEST_CHROMIUM } : {},
    );
    try {
        const page = await browser.newPage();
        const remote = "https://example.invalid";
        const requests: string[] = [];
        await page.route(`${remote}/**`, (route) => {
            requests.push(route.request().url());
            return route.abort();
        });
        await page.setContent("<main></main>");
        const stylesheet = await readFile(new URL("../../src/features/agent/agent.css", import.meta.url), "utf8");
        await page.addStyleTag({ content: stylesheet });
        const markdown = [
            "# Draft summary",
            `**Reviewed** [Documentation](${remote}/docs) [Other](ftp://example.invalid/file).`,
            "",
            `- [Unordered documentation](${remote}/unordered)`,
            "",
            `1. [Ordered documentation](${remote}/ordered)`,
            "",
            `![Example](${remote}/chart.png)`,
            "<video poster='https://example.invalid/movie.png'></video>",
            "<span style='background-image: url(https://example.invalid/background.png)'>More notes</span>",
            "",
            "| Item | Detail |",
            "| --- | --- |",
            `| Alpha | [Table documentation](${remote}/table) |`,
            "| Beta | **Checked** |",
        ].join("\n");
        await page.locator("main").evaluate((target, body) => (target.textContent = body), markdown);
        await page.addScriptTag({ content: bundled.code });
        await page.getByRole("heading", { name: "Draft summary" }).waitFor();
        assert.equal(await page.locator("main strong").getByText("Reviewed", { exact: true }).count(), 1);
        const documentation = page.getByRole("link", { name: "Documentation", exact: true });
        assert.equal(await documentation.getAttribute("href"), `${remote}/docs`);
        assert.equal(await documentation.evaluate((link) => getComputedStyle(link).textDecorationLine), "underline");
        const lists = [
            ["ul", "unordered"],
            ["ol", "ordered"],
        ];
        for (const [list, path] of lists) {
            const link = page.locator(`${list} li`).getByRole("link");
            assert.equal(await link.getAttribute("href"), `${remote}/${path}`);
            assert.equal(await link.evaluate((element) => getComputedStyle(element).textDecorationLine), "none");
        }
        assert.equal(await page.getByRole("link", { name: "Other" }).count(), 0);
        assert.equal(await page.locator("main img, main video, main table [style]").count(), 0);
        assert.equal(await page.getByText("More notes", { exact: true }).getAttribute("style"), null);
        const table = page.getByRole("table", { name: "Message table 1" });
        await table.getByRole("columnheader", { name: "Item" }).waitFor({ timeout: 1500 });
        assert.equal(
            await table.getByRole("link", { name: "Table documentation" }).getAttribute("href"),
            `${remote}/table`,
        );
        await page.getByRole("searchbox", { name: "Search message table 1" }).fill("checked");
        assert.equal(await table.getByRole("row").count(), 2);
        assert.equal(await table.getByRole("row").last().textContent(), "BetaChecked");
        await page.getByText("Showing 1 to 1 of 1 entries", { exact: true }).waitFor();
        await page.getByRole("searchbox", { name: "Search message table 1" }).fill("absent");
        await table.getByRole("cell", { name: "No matching rows." }).waitFor();
        assert.equal(await table.getByRole("columnheader").count(), 2);
        assert.equal(await page.getByRole("button", { name: "Download" }).isDisabled(), true);
        assert.deepEqual(requests, []);
    } finally {
        await browser.close();
    }
});
