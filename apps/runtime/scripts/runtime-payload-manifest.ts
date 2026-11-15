import { canonicalBytes } from "@veriq/contracts";
import {
    parseMacRuntimeManifestV2,
    type MacChromeLayout,
} from "../src/distribution-manifest-v2.ts";
import type { FileFact, LinkFact, Recipe, Ref, TreeKind } from "./runtime-payload-inputs.ts";

/** 每个输出来源都保留原输入成员和摘要，链接复制逐跳列原始目标摘要，生成成员指向真正绑定的生成器源码；来源事实不能把原归档、源码或未签名候选的不同身份互相代替，也不能授权执行。 */
export type Origin = Readonly<{
    input: "node" | "chrome" | TreeKind | "generated";
    path: string;
    sha256: string;
    transform:
        | "copy"
        | "file-link-copy-v1"
        | "mode-normalize"
        | "role-copy"
        | "bin-shim-v1"
        | "runtime-package-v1"
        | "manifest-v2";
}>;
/** 输出文件事实在外部收据完整包含 manifest 本身及至少一个真实来源，目录集合则由第二版清单绑定；角色文件即使相同字节也必须独立物理写入，不能按摘要去重或通过链接冒充三份执行角色。 */
export type OutputFact = FileFact & Readonly<{ origins: readonly Origin[] }>;
/** 候选回执明确标记开发未签名静态状态，保留来源与原工具声明并列出实际复制的外部证据；文件计数沿 D3a 不含 manifest，外部 receipt 自身摘要只放 Result 避免自引用封印。 */
export type PayloadReceipt = Readonly<{
    schemaVersion: 1;
    kind: "MAC_RUNTIME_PAYLOAD_CANDIDATE";
    status: "DEVELOPMENT_UNSIGNED_STATIC";
    recipeSha256: string;
    target: Recipe["target"];
    source: Recipe["source"];
    tools: Recipe["tools"];
    inputReceipts: readonly Ref[];
    chromeLayoutSha256: string;
    runtimeManifestSha256: string;
    files: readonly OutputFact[];
    links: readonly LinkFact[];
    counts: { files: number; directories: number; links: number; fileBytes: number };
    templateSha256: string;
}>;

/** 清单生成仅序列化已经计划并真实写入的文件目录与独立 Chrome 链接，随后仍由 D3a 在临时与最终路径各自核验；先解析生成字节可以在任何发布前拒绝所需成员缺失、冲突、数量和权限错误。 */
export function manifestBytes(
    recipe: Recipe,
    layout: MacChromeLayout,
    files: readonly OutputFact[],
    directories: readonly string[],
    links: readonly LinkFact[],
): Uint8Array {
    const bytes = canonicalBytes({
        schemaVersion: 2,
        platform: "darwin",
        arch: recipe.target.arch,
        productVersion: recipe.target.productVersion,
        nodeVersion: recipe.target.nodeVersion,
        engineVersion: recipe.target.engineVersion,
        browser: {
            version: "158.0.8127.18",
            revision: "1254",
            bundlePath: layout.bundlePath,
            executablePath: layout.executablePath,
        },
        directories: [...directories].sort(),
        files: [...files]
            .sort((a, b) => (a.path < b.path ? -1 : 1))
            .map(({ origins: _origins, ...fact }) => fact),
        links: [...links].sort((a, b) => (a.path < b.path ? -1 : 1)),
    });
    parseMacRuntimeManifestV2(bytes, { arch: recipe.target.arch, layout });
    return bytes;
}
