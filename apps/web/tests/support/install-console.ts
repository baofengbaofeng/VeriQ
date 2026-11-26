import { expect, type Page } from "@playwright/test";

/**
 * 空白测试库先经真实安装接口配置初始管理员，已安装时保留其它场景创建的用户、会话和工作空间。
 */
export async function installed(page: Page, baseURL?: string): Promise<void> {
    const response = await page.request.get("/api/v1/setup");
    expect(response.status()).toBe(200);
    const setup = (await response.json()).data;
    if (setup.initialized) return;
    const created = await page.request.post("/api/v1/setup", {
        headers: { Origin: new URL(baseURL ?? response.url()).origin, "X-CSRF-Token": setup.csrfToken },
        data: {
            installationSecret: "browser-operator-secret",
            email: "browser-admin@example.com",
            displayName: "Browser Administrator",
            password: "Browser password 123!",
        },
    });
    expect(created.status()).toBe(201);
}
