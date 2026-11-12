/**
 * 本文件实现 UI 断言：在定位器上取值并比对期望：失败时保留可安全投影的实际值摘要，供调用方理解 ui 路径上的输入与失败语义。
 */

import { expect } from "@playwright/test";
import type { AssertionV1, JsonValue, Presence } from "@veriq/contracts";
import { budget, locator, type StepContext } from "../context.js";
type UIAssertion = Extract<AssertionV1, { type: "ui" | "url" }>;
/**
 * 公开函数 assertUI 按 UI 断言类型读取定位器实际值并比对期望：超时与取消映射为失败结果（assertUI）。
 */
export async function assertUI(
    a: UIAssertion,
    expected: JsonValue,
    ctx: StepContext,
): Promise<Presence> {
    const timeout = budget(ctx, a.timeoutMs ?? 5000);
    if (a.type === "url") {
        if (a.operator === "equals")
            await expect(ctx.page).toHaveURL(String(expected), { timeout });
        else
            await expect
                .poll(() => ctx.page.url(), { timeout })
                .toContain(String(expected));
        return { present: true, value: ctx.page.url() };
    }
    const target = locator(a.target, ctx);
    if (
        a.operator !== "countEquals" &&
        !(a.operator === "attached" && expected === false) &&
        !(a.operator === "visible" && expected === false)
    )
        await expect(target).toHaveCount(1, { timeout });
    const assertion = expected === false ? expect(target).not : expect(target);
    switch (a.operator) {
        case "visible":
            await assertion.toBeVisible({ timeout });
            break;
        case "enabled":
            await assertion.toBeEnabled({ timeout });
            break;
        case "checked":
            await assertion.toBeChecked({ timeout });
            break;
        case "attached":
            await assertion.toBeAttached({ timeout });
            break;
        case "editable":
            await assertion.toBeEditable({ timeout });
            break;
        case "textEquals":
            await expect(target).toHaveText(String(expected), { timeout });
            break;
        case "textContains":
            await expect(target).toContainText(String(expected), { timeout });
            break;
        case "valueEquals":
            await expect(target).toHaveValue(String(expected), { timeout });
            break;
        case "countEquals":
            await expect(target).toHaveCount(Number(expected), { timeout });
            break;
    }
    return uiActual(a, ctx);
}
/**
 * 公开函数 uiActual 提取用于断言比较的 UI 实际值摘要：避免把过大 DOM 文本写入报告（uiActual）。
 */
export async function uiActual(
    a: UIAssertion,
    ctx: StepContext,
): Promise<Presence> {
    if (a.type === "url") return { present: true, value: ctx.page.url() };
    const l = locator(a.target, ctx),
        n = await l.count();
    if (a.operator === "countEquals") return { present: true, value: n };
    if (a.operator === "attached") return { present: true, value: n > 0 };
    if (a.operator === "visible")
        return { present: true, value: n === 1 && (await l.isVisible()) };
    if (n !== 1) return { present: false };
    const timeout = budget(ctx, 100);
    const value =
        a.operator === "enabled"
            ? await l.isEnabled({ timeout })
            : a.operator === "checked"
                ? await l.isChecked({ timeout })
                : a.operator === "editable"
                    ? await l.isEditable({ timeout })
                    : a.operator === "valueEquals"
                        ? await l.inputValue({ timeout })
                        : await l.textContent({ timeout });
    return { present: true, value };
}
