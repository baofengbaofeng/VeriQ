import { expect, type _electron } from "../../apps/desktop/tests/fixtures";

type DesktopPage = Awaited<ReturnType<Awaited<ReturnType<typeof _electron.launch>>["firstWindow"]>>;

/**
 * 选择控件的 DOM 事件不会等待 React 异步成员检查，测试必须观察宿主真实授权作用域和页面忙碌结束，才能发出后续云端操作。
 * 不直接调用内部选择方法或绕过工作区守卫，所有重登、恢复及新登记入口共用真实界面选择路径。
 */
export async function selectDesktopWorkspace(page: DesktopPage, workspaceId: string): Promise<void> {
    const select = page.getByLabel("平台工作区 / Platform workspace");
    await expect(select.locator(`option[value="${workspaceId}"]`)).toHaveCount(1);
    await select.selectOption(workspaceId);
    await expect.poll(async () => (await page.evaluate(() => window.veriq.state())).workspace?.id).toBe(workspaceId);
    await expect(page.getByRole("status").filter({ hasText: /^(正在读取…|Loading…)$/ })).toHaveCount(0);
    await expect(select).toHaveValue(workspaceId);
}
