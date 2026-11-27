try {
    const theme = localStorage.getItem("veriq-theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}

document.addEventListener("DOMContentLoaded", () => {
    const root = document.documentElement;
    const languageButton = document.getElementById("language");
    const themeButton = document.getElementById("theme");
    const translations = Array.from(document.querySelectorAll("[data-en]"), (element) => ({
        element,
        zh: element.textContent.trim(),
        en: element.dataset.en.replace(/\s+/g, " "),
    }));
    const navigation = document.querySelector("nav");
    const description = document.querySelector('meta[name="description"]');
    let language = "zh";
    try {
        if (localStorage.getItem("veriq-language") === "en") language = "en";
    } catch {}

    function renderTheme() {
        const light = root.dataset.theme === "light";
        themeButton.textContent = language === "en" ? (light ? "Dark mode" : "Light mode") : light ? "深色" : "浅色";
        themeButton.setAttribute(
            "aria-label",
            language === "en"
                ? light
                    ? "Switch to dark mode"
                    : "Switch to light mode"
                : light
                  ? "切换到深色主题"
                  : "切换到浅色主题",
        );
    }

    function renderLanguage() {
        const english = language === "en";
        root.lang = english ? "en" : "zh-CN";
        document.title = english ? "VeriQ · Reproducible web testing" : "VeriQ · 可复现的 Web 测试";
        translations.forEach(({ element, zh, en }) => {
            element.textContent = english ? en : zh;
        });
        navigation.setAttribute("aria-label", english ? navigation.dataset.enLabel : navigation.dataset.zhLabel);
        description.content = document.querySelector(".lede").textContent;
        languageButton.textContent = english ? "中文" : "EN";
        languageButton.lang = english ? "zh-CN" : "en";
        languageButton.setAttribute("aria-label", english ? "切换到中文" : "Switch to English");
        renderTheme();
    }

    languageButton.addEventListener("click", () => {
        language = language === "en" ? "zh" : "en";
        try {
            localStorage.setItem("veriq-language", language);
        } catch {}
        renderLanguage();
    });
    themeButton.addEventListener("click", () => {
        root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
        try {
            localStorage.setItem("veriq-theme", root.dataset.theme);
        } catch {}
        renderTheme();
    });
    renderLanguage();
});
