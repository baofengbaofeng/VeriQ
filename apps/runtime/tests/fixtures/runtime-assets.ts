import "../../scripts/runtime-payload-inputs.ts";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_SOURCES, type SourceFacts } from "../../scripts/runtime-assets-observation.ts";
import type { Ref } from "../../scripts/runtime-payload-inputs.ts";
import { tarBytes, zipBytes } from "./runtime-payload-archives.ts";

/** 微型夹具只为真实扫描器和流校验器提供可独立计算的普通字节，从不将它们伪装成固定官方归档；来源清单始终读取真实十九个宿主文件并复制其原字节，测试不会改动仓库源码或官方摘要。 */
export function fact(path: string, bytes: Uint8Array): Ref {
    return {
        path,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
/** 每个测试独占两个互不覆盖的私有目录，源清单及证据都使用真实六百权限普通文件；finally 只清除本次夹具的目录，未知事务资源必须先由测试明确结束后才能进入夹具收尾。 */
export async function assetsFixture<T>(
    run: (value: {
        root: string;
        output: string;
        source: { commit: string; evidence: Ref };
        facts: SourceFacts;
    }) => Promise<T>,
) {
    const base = await mkdtemp(join(tmpdir(), "veriq-assets-")),
        root = join(base, "input"),
        output = join(base, "output");
    await mkdir(root, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    await mkdir(join(root, "evidence"), { mode: 0o700 });
    try {
        const files: Ref[] = [];
        for (const source of ASSET_SOURCES) {
            const bytes = await readFile(fileURLToPath(source.url));
            files.push(fact(source.path, bytes));
            const copy = join(root, "code", source.path);
            await mkdir(join(copy, ".."), { recursive: true, mode: 0o700 });
            await writeFile(copy, bytes, { mode: 0o600 });
        }
        const facts: SourceFacts = {
            schemaVersion: 1,
            kind: "ASSET_OBSERVER_SOURCE",
            commit: "a".repeat(40),
            runId: "123",
            runAttempt: 1,
            arch: "x64",
            osVersion: "15.7.1",
            nodeVersion: "24.22.1",
            nodeSha256: fact("node", Buffer.from("observed developer tool identity")).sha256,
            files,
        };
        const bytes = Buffer.from(JSON.stringify(facts));
        await writeFile(join(root, "evidence/source.json"), bytes, { mode: 0o600 });
        return await run({
            root,
            output,
            facts,
            source: { commit: facts.commit, evidence: fact("evidence/source.json", bytes) },
        });
    } finally {
        await rm(base, { recursive: true, force: true });
    }
}
/** 两种归档均由已锁 tar 编码器及成熟 Python zipfile 生成真实压缩体，Framework 和外部链接特意同时存在以检验候选分类；归档成员不会被落地提取或作为 Node、Chrome 及其它目标程序执行。 */
export function tinyAssets(arch: "x64" | "arm64" = "x64") {
    const nodeTop = `node-v24.22.1-darwin-${arch}`,
        chromeTop = `chrome-mac-${arch}`;
    const bundle = `${chromeTop}/Google Chrome for Testing.app`,
        framework = `${bundle}/Contents/Frameworks/Tiny.framework`;
    return [
        tarBytes([{ path: `${nodeTop}/bin/node`, body: "tiny observed bytes", mode: 0o755 }]),
        zipBytes([
            {
                path: `${bundle}/Contents/MacOS/Google Chrome for Testing`,
                body: "tiny browser bytes",
                mode: 0o755,
            },
            { path: `${framework}/Versions/A/Tiny`, body: "tiny framework" },
            { path: `${framework}/Versions/Current`, kind: "link", target: "A" },
            { path: `${chromeTop}/outside`, kind: "link", target: "LICENSE" },
            { path: `${chromeTop}/LICENSE`, body: "tiny license" },
        ]),
    ] as const;
}
