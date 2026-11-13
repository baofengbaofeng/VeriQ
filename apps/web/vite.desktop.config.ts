import { defineConfig } from "vite";
import { desktopValidators } from "./desktop-validators.mjs";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/** 桌面共享包把 Monaco worker 和样式一起生成到本地资源目录，React 与状态库保持工作区单例以防 hooks 身份分裂；构建不会注入服务地址或把远端脚本作为运行依赖。 */
export default defineConfig({
    plugins: [desktopValidators(), react()],
    base: "./",
    build: {
        outDir: "dist-desktop",
        emptyOutDir: false,
        commonjsOptions: { include: [/node_modules/, /validators\.cjs$/] },
        lib: { entry: resolve("src/desktop.ts"), formats: ["es"], fileName: () => "index.js" },
        rollupOptions: {
            external: [
                "react",
                "react/jsx-runtime",
                "react-dom",
                "@tanstack/react-query",
                "i18next",
                "react-i18next",
            ],
        },
        minify: true,
    },
});
