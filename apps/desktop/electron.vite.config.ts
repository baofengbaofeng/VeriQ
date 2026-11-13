import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/** 桌面构建把独立 Agent 和 main 作为不同入口并保留原生 Node 依赖，工作区源码直接编入宿主产物以消除开发 tsx 别名；preload 强制单个 CommonJS 文件，满足 sandbox 的有限加载器要求。 */
export default defineConfig({
    main: {
        build: {
            externalizeDeps: {
                exclude: [
                    "@veriq/contracts",
                    "@veriq/compiler",
                    "@veriq/runner-sdk",
                    "@veriq/runtime",
                ],
            },
            rollupOptions: {
                input: {
                    index: resolve("src/main/index.ts"),
                    agent: resolve("src/agent/index.ts"),
                },
                output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
            },
        },
    },
    preload: {
        build: {
            externalizeDeps: false,
            rollupOptions: {
                input: resolve("src/preload/index.ts"),
                output: { format: "cjs", entryFileNames: "index.cjs" },
            },
        },
    },
    renderer: {
        root: resolve("src/renderer"),
        plugins: [react()],
        base: "./",
        build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
    },
});
