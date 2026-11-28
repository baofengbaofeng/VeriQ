// 首页首屏渲染前只读取已保存的深浅主题，不改写未知值；存储被禁用或读取失败时沿用样式表默认主题。
try {
    const theme = localStorage.getItem("veriq-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
