import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * 桌面构建把独立 Agent 和 main 作为不同入口并保留原生 Node 依赖，工作区源码直接编入宿主产物以消除开发 tsx 别名；
 * 两个隔离 preload 各自打包为独立 CommonJS 文件，满足 sandbox 的有限加载器要求。
 */
export default defineConfig(({ mode }) => {
    const source = mode === "source-workbench";
    return {
        main: {
            define: { __VERIQ_SOURCE_WORKBENCH__: JSON.stringify(source) },
            build: {
                ...(source ? { outDir: resolve("out-source/main") } : {}),
                externalizeDeps: {
                    exclude: [
                        "@electron/fuses",
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
                        cli: resolve("../runtime/src/cli.ts"),
                    },
                    output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
                },
            },
        },
        preload: {
            build: {
                ...(source ? { outDir: resolve("out-source/preload") } : {}),
                externalizeDeps: false,
                rollupOptions: {
                    input: {
                        index: resolve("src/preload/index.ts"),
                        recording: resolve("src/preload/recording.ts"),
                    },
                    output: { format: "cjs", entryFileNames: "[name].cjs" },
                },
            },
        },
        renderer: {
            root: resolve("src/renderer"),
            plugins: [react()],
            base: "./",
            build: {
                ...(source ? { outDir: resolve("out-source/renderer") } : {}),
                rollupOptions: { input: resolve("src/renderer/index.html") },
            },
        },
    };
});
