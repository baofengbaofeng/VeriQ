try {
    const theme = localStorage.getItem("veriq-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
