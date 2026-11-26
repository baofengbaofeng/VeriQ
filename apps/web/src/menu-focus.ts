/**
 * Radix 通过程序化聚焦处理菜单指针移动，而浏览器可能沿用上一次键盘操作的焦点可见状态。记录菜单交互来源，
 * 使纯鼠标移动显示较浅的悬停色，键盘导航立即恢复焦点填色。根节点上的标记也可供 Portal 中的选项读取。
 */

const popup = ".vq-menu, .vq-dropdown, .vq-select-content";
const trigger = '.vq-select-trigger, [aria-haspopup="menu"]';

/**
 * 在 Radix 处理同一次事件之前更新菜单标记，指针打开弹层时即使没有移动到选项上，也不沿用键盘的填充色。
 * 页面其它区域的指针移动不改变菜单状态；关闭后下一次触发器操作重新确定输入来源。
 */
function trackMenuInput(event: Event) {
    const target = event.target;
    const content = event.type === "pointermove" ? popup : `${popup}, ${trigger}`;
    if (!(target instanceof Element) || !target.closest(content)) return;
    document.documentElement.toggleAttribute("data-vq-pointer-menu", event.type !== "keydown");
}

document.addEventListener("pointermove", trackMenuInput, { capture: true, passive: true });
document.addEventListener("pointerdown", trackMenuInput, { capture: true, passive: true });
document.addEventListener("keydown", trackMenuInput, true);
