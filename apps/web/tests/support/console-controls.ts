/**
 * 浏览器从真实横幅定位全局工作区和个人菜单，即使页面或弹层也有同类控件，测试仍只操作登录外壳。
 */
import { expect, type Page } from "@playwright/test";

/**
 * 语言切换也会翻译工作区选择器的无障碍名称，横幅内始终只有这一处当前登录身份的成员空间目录。
 */
export function workspacePicker(page: Page) {
    return page.getByRole("banner", { includeHidden: true }).locator("button.vq-workspace-picker");
}

/**
 * 目录项在 Radix 的可见浮层内具有真实成员标识，因此不同工作区使用相同显示名时仍能选中目标。
 */
export function workspaceOption(page: Page, id: string) {
    return page.getByRole("menuitemradio").and(page.locator(`[data-workspace-id="${id}"]`));
}

/**
 * 已经展开的浮层可直接继续分页或选择，避免再次点击触发器反而关闭菜单；等待实际可见后才操作其内容。
 */
export async function openWorkspaceMenu(page: Page) {
    const trigger = workspacePicker(page);
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    const menu = page.getByRole("menu").and(page.locator(".vq-workspace-menu"));
    await expect(menu).toBeVisible();
    return menu;
}

/**
 * 通过真实菜单逐页寻找已知成员空间，点击实际选项；只接受新增的记录或最后一页，不轮询隐藏控件。
 */
export async function chooseWorkspace(page: Page, id: string) {
    const menu = await openWorkspaceMenu(page);
    const options = menu.getByRole("menuitemradio");
    await expect(options.first()).toBeVisible();
    const target = workspaceOption(page, id);
    const more = menu.getByRole("menuitem", { name: /^(More Workspaces|更多空间)$/ });
    while (!(await target.count()) && (await more.count())) {
        const count = await options.count();
        await more.click();
        await expect.poll(() => options.count()).toBeGreaterThan(count);
    }
    await target.click();
    await expect(workspacePicker(page)).toHaveAttribute("data-workspace-id", id);
}

/**
 * 从顶栏的真实按钮获取当前已选标识，后续成员、邀请和资源的服务端操作使用同一个授权工作区。
 */
export async function selectedWorkspaceId(page: Page) {
    const id = await workspacePicker(page).getAttribute("data-workspace-id");
    if (!id) throw new Error("No workspace selected");
    return id;
}

/**
 * 用户名随当前登录身份变化，因此通过横幅中独立的个人菜单触发器找到当前账户提供的个人操作入口。
 */
export function profileButton(page: Page) {
    return page.getByRole("banner").locator("button.vq-user-trigger");
}

/**
 * 登出操作从当前账户的真实个人菜单进入，使后端撤销旧会话和重新登录的过程都可被浏览器观察。
 */
export async function signOut(page: Page) {
    await profileButton(page).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
}

/**
 * 菜单中的语言原名不随当前选定语言改变，切换后仍可从同一用户入口验证实际的界面语言和表单状态。
 */
export async function chooseLanguage(page: Page, language: "en" | "zh") {
    await profileButton(page).click();
    await page.getByRole("menuitem", { name: /^(Language|语言)/ }).click();
    await page.getByRole("menuitemradio", { name: language === "zh" ? "中文" : "English" }).click();
}
