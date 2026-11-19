/**
 * 浏览器从真实横幅定位全局工作区和个人菜单，即使页面或弹层也有同类控件，测试仍只操作登录外壳。
 */
import type { Page } from "@playwright/test";

/**
 * 语言切换也会翻译工作区选择器的无障碍名称，横幅内始终只有这一处当前登录身份的成员空间目录。
 */
export function workspacePicker(page: Page) {
    return page.getByRole("banner").getByRole("combobox");
}

/**
 * 用户名随当前登录身份变化，因此通过菜单触发器的无障碍属性找到当前账户提供的个人操作入口。
 */
export function profileButton(page: Page) {
    return page.getByRole("banner").locator('button[aria-haspopup="menu"]');
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
    await page.getByRole("menuitemradio", { name: language === "zh" ? "中文" : "English" }).click();
}
