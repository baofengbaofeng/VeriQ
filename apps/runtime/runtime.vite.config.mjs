import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/**
 * 配置始终从被绑定的自身位置推导来源根，Vite 的工作目录只负责宿主命令上下文而不能替代来源选择；普通包保持外部依赖，
 * VeriQ 工作区交给 Vite 原有解析与 Rollup 打包并记录真实输入。
 */
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const traceName = ".veriq-entry-trace.json";

/**
 * 私有观察记录实际 Rollup 输出角色和物理输入，既不充当发行收据也不推断目标 Node 解析结果；生产器会独立核查所有路径、
 * 来源绑定及落盘文件，任何外部来源都在构建时直接失败。
 */
function observation() {
    return {
        name: "veriq-entry-input-observation",
        // 显式后序钩子等待 Vite 完成预加载标记改写，再声明写盘前字节；落盘后的独立摘要核验仍由生产器执行。
        generateBundle: {
            order: "post",
            handler(_options, bundle) {
                const sources = new Set();
                for (const id of this.getModuleIds()) {
                    if (id.startsWith("\0")) continue;
                    const info = this.getModuleInfo(id);
                    if (info?.isExternal) continue;
                    if (!isAbsolute(id)) this.error("Non-physical entry input");
                    const path = relative(sourceRoot, id).split("\\").join("/");
                    if (
                        !path ||
                        path.startsWith("../") ||
                        isAbsolute(path) ||
                        path.includes("?") ||
                        path.split("/").includes("node_modules")
                    )
                        this.error("Unbound entry input");
                    sources.add(path);
                }
                const outputs = Object.values(bundle).map((output) => {
                    const bytes = Buffer.from(output.type === "asset" ? output.source : output.code);
                    return {
                        path: output.fileName,
                        kind: output.type === "asset" ? "asset" : output.isEntry ? "entry" : "chunk",
                        sizeBytes: bytes.length,
                        sha256: createHash("sha256").update(bytes).digest("hex"),
                    };
                });
                const bytes = JSON.stringify({
                    sources: [...sources].sort(),
                    outputs: outputs.sort((a, b) => a.path.localeCompare(b.path)),
                });
                if (Buffer.byteLength(bytes) > 4 * 1024 ** 2) this.error("Entry observation limit exceeded");
                this.emitFile({ type: "asset", fileName: traceName, source: bytes });
            },
        },
    };
}

/**
 * 两个 Node 入口明确排除 Electron 主进程与界面，固定入口名并保留共享 chunk 和真正生成的资产；禁用公共目录拷贝、
 * 配置缓存与隐式依赖扫描，避免未绑定文件混入独立构建目录。
 */
export default {
    root: sourceRoot,
    publicDir: false,
    cacheDir: false,
    plugins: [observation()],
    // 服务端消费者仍须显式嵌入 VeriQ 工作区，防止默认外部化绕过真实来源追踪；其它包继续沿用下方外部依赖策略。
    ssr: { noExternal: /^@veriq\// },
    build: {
        // 此处只选择 Node 构建管线，保留模块 URL 的源码回退语义；数据资产和内部观察仍需写盘并接受独立完整性核验。
        ssr: true,
        emitAssets: true,
        target: "node24",
        minify: false,
        sourcemap: false,
        emptyOutDir: false,
        copyPublicDir: false,
        rollupOptions: {
            input: {
                agent: resolve(sourceRoot, "apps/desktop/src/agent/index.ts"),
                cli: resolve(sourceRoot, "apps/runtime/src/cli.ts"),
            },
            external: (id) => !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("@veriq/"),
            output: {
                format: "es",
                entryFileNames: "[name].js",
                chunkFileNames: "chunks/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]",
            },
        },
    },
};
