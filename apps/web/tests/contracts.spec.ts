import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

test("shared canonical source bytes run in a real browser without Node APIs", async ({ page }) => {
    // 静态同源文档隔离浏览器契约验证与应用启动，使依赖首次优化引发的开发客户端重载不干扰断言。
    // 页面导航使用同源的包清单地址。
    await page.goto("/@fs" + fileURLToPath(new URL("../../../packages/contracts/package.json", import.meta.url)));
    const modulePath = "/@fs" + fileURLToPath(new URL("../../../packages/contracts/src/index.ts", import.meta.url));
    const result = await page.evaluate(async (modulePath) => {
        // Vite 将工作区契约作为浏览器 ESM 提供，编码与校验直接使用浏览器能力，无需 Node 加密或缓冲区垫片。
        const contracts = await import(/* @vite-ignore */ modulePath);
        const bytes = contracts.canonicalBytes({ z: -0, a: 1.0 });
        const source = contracts.assetSourceBytes({
            schemaVersion: "1.0",
            workspaceId: "test",
            engineVersion: "0.1.0",
            entryCaseVersionIds: [],
            assets: [],
            validationTarget: { revision: 1 },
        });
        const binding = contracts.resolveBinding({ value: "{{data.answer}}" }, { data: { answer: 42 }, vars: {} });
        const missing = contracts.resolvePointer({ present: null }, "/missing");
        const present = contracts.resolvePointer({ present: null }, "/present");
        const eventIssues = contracts.validateSchema("ObserverV1", {
            id: "popup",
            kind: "newPage",
            pageKey: "detail",
        });
        return {
            canonical: new TextDecoder().decode(bytes),
            source: new TextDecoder().decode(source),
            binding,
            missing,
            present,
            eventIssues,
        };
    }, modulePath);
    expect(result.canonical).toBe('{"a":1,"z":0}');
    expect(JSON.parse(result.source)).not.toHaveProperty("validationTarget");
    expect(result.binding).toEqual({ value: 42 });
    expect(result.missing).toEqual({ present: false });
    expect(result.present).toEqual({ present: true, value: null });
    expect(result.eventIssues).toEqual([]);
});
