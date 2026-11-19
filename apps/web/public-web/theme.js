/**
 * 页面开始解析时先应用本地主题，避免等待 React 和编辑器分包期间闪过浅色背景；无法读取偏好时采用浅色。
 */
try {
    document.documentElement.dataset.theme = localStorage.getItem("veriq.theme") === "dark" ? "dark" : "light";
} catch {
    document.documentElement.dataset.theme = "light";
}
document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
