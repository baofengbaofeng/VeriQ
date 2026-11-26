import { RuntimePayloadError, type InputInspection, type Ref } from "./runtime-payload-inputs.ts";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { InputReader, freeze, limits, sha } from "./runtime-payload-tree.ts";

const contractEntry = new URL(import.meta.resolve("@veriq/contracts"));
const core = [
    "stage",
    "npm",
    "bins",
    "manifest",
    "generation",
    "archive",
    "tar",
    "zip",
    "transaction",
    "inputs",
    "tree",
    "receipts",
    "graph",
];
/**
 * 固定源码清单只从当前模块 URL 与实际 contracts 入口相邻位置定位宿主字节，配方永远不能指定任意宿主路径；仓库相对键保持
 * 审核合同中的二十项身份，即使共享依赖来自工作区实际模块位置也不改变来源含义。
 */
export const GENERATOR_SOURCES: readonly Readonly<{ path: string; url: string }>[] = Object.freeze(
    [
        ...core.map((name) => ({
            path: `apps/runtime/scripts/runtime-payload-${name}.ts`,
            url: new URL(`runtime-payload-${name}.ts`, import.meta.url),
        })),
        {
            path: "apps/runtime/scripts/stage-macos-runtime.mjs",
            url: new URL("stage-macos-runtime.mjs", import.meta.url),
        },
        ...["distribution-manifest-v2", "node-version"].map((name) => ({
            path: `apps/runtime/src/${name}.ts`,
            url: new URL(`../src/${name}.ts`, import.meta.url),
        })),
        { path: "packages/contracts/src/index.ts", url: contractEntry },
        {
            path: "packages/contracts/src/validators.ts",
            url: new URL("validators.ts", contractEntry),
        },
        {
            path: "packages/contracts/schemas/platform-v1.schema.json",
            url: new URL("../schemas/platform-v1.schema.json", contractEntry),
        },
        { path: "pnpm-lock.yaml", url: new URL("../../../pnpm-lock.yaml", import.meta.url) },
    ].map((source) => Object.freeze({ path: source.path, url: source.url.href })),
);

/**
 * 源码绑定结果保留真正读取的固定源码事实与收尾复验动作，所有生成模板和清单只能引用这些已匹配的 Ref；此受控 checkout 一
 * 致性不认证宿主已加载机器指令或第三方包，实际来源构建仍交后续 CI 验证。
 */
export type GeneratorBinding = Readonly<{ files: readonly Ref[]; finish: () => Promise<void> }>;

/**
 * 生成之前必须同时匹配独立 SourceBinding、输入根源码副本与实际宿主固定源码，结束时再观察并重读同一集合；同步伪造输入副
 * 本和全部自报摘要也不能使与本次生成器不同的代码获得候选来源身份。
 */
export async function bindGeneratorSources(
    report: InputInspection,
    inputRoot: string,
    signal?: AbortSignal,
): Promise<GeneratorBinding> {
    const input = new InputReader(inputRoot, signal, []);
    await input.initialize();
    const hosts: { reader: InputReader; ref: Ref }[] = [],
        files: Ref[] = [];
    for (const source of GENERATOR_SOURCES) {
        const ref = report.sourceBinding.files.find((file) => file.path === source.path);
        if (!ref) throw new RuntimePayloadError("PAYLOAD_RECEIPT_MISMATCH");
        const full = fileURLToPath(source.url),
            reader = new InputReader(dirname(full), signal, []);
        await reader.initialize();
        const hostRef = { ...ref, path: basename(full) };
        try {
            const content = await reader.input(hostRef.path);
            if (content.length !== ref.sizeBytes || sha(content) !== ref.sha256)
                throw new RuntimePayloadError("PAYLOAD_SOURCE_CHANGED");
        } catch (error) {
            if (error instanceof RuntimePayloadError && error.code === "PAYLOAD_TREE_MISMATCH")
                throw new RuntimePayloadError("PAYLOAD_SOURCE_CHANGED");
            throw error;
        }
        await input.ref(ref, false, limits.file, false);
        hosts.push({ reader, ref: hostRef });
        files.push({ ...ref });
    }
    return Object.freeze({
        files: freeze(files),
        finish: async () => {
            for (const host of hosts) {
                await host.reader.finish();
                const content = await host.reader.input(host.ref.path);
                if (content.length !== host.ref.sizeBytes || sha(content) !== host.ref.sha256)
                    throw new RuntimePayloadError("PAYLOAD_SOURCE_CHANGED");
                await host.reader.finish();
            }
            for (const ref of files) await input.ref(ref, false, limits.file, false);
            await input.finish();
        },
    });
}
