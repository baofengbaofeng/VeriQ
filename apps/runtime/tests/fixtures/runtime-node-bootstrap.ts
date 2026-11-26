import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarBytes, type ArchiveFixtureEntry } from "./runtime-payload-archives.ts";
import { ArchiveTransaction } from "../../scripts/runtime-payload-transaction.ts";
import { assetBytes } from "../../scripts/runtime-assets-observation.ts";
import type { Arch, Ref } from "../../scripts/runtime-payload-inputs.ts";

/**
 * 微型原归档保留推导父目录、显式空目录和原始普通正文，并刻意包含不同物理根的同名同版本包；夹具只构造静态源材料，不执行
 * 假二进制，也不替换生产入口的官方摘要约束。
 */
export function nodeSourceEntries(arch: Arch = "x64"): ArchiveFixtureEntry[] {
    const top = `node-v24.22.1-darwin-${arch}`,
        npm = `${top}/lib/node_modules/npm`;
    const manifest = (name: string) =>
        JSON.stringify({
            name,
            version: "1.0.0",
            bin: { tool: "bin/tool.js" },
            extra: { untouched: true },
        });
    return [
        { path: `${top}/bin/node`, body: "synthetic Node body", mode: 0o755 },
        { path: `${top}/LICENSE`, body: "original license\n" },
        { path: `${top}/include/empty`, kind: "directory" },
        { path: `${npm}/package.json`, body: manifest("npm") },
        { path: `${npm}/bin/npm-cli.js`, body: "#!/usr/bin/env node\noriginal npm\n", mode: 0o755 },
        { path: `${npm}/docs/package.json`, body: manifest("ignored-docs") },
        { path: `${npm}/node_modules/alias/package.json`, body: manifest("duplicate") },
        { path: `${npm}/node_modules/alias/bin/tool.js`, body: "original bin\n" },
        { path: `${npm}/node_modules/@scope/holder/package.json`, body: manifest("@scope/holder") },
        {
            path: `${npm}/node_modules/@scope/holder/node_modules/duplicate/package.json`,
            body: manifest("duplicate"),
        },
        { path: `${top}/bin/npm`, kind: "link", target: "../lib/node_modules/npm/bin/npm-cli.js" },
        { path: `${npm}/bin/npm-alt.js`, kind: "link", target: "npm-cli.js" },
    ];
}

/**
 * 每次 helper 测试拥有独立输入根和输出父目录，快照由真实事务独占写入并登记摘要；收尾只处理本夹具新建的有限目录，故障保
 * 留场景必须在断言锁及 scratch 后才允许测试 finally 回收。
 */
export async function nodeSourceFixture<T>(
    run: (f: { tx: ArchiveTransaction; snapshot: Ref; base: string; root: string; output: string }) => Promise<T>,
    entries = nodeSourceEntries(),
) {
    const base = await mkdtemp(join(tmpdir(), "veriq-node-source-")),
        root = join(base, "input"),
        output = join(base, "output");
    await mkdir(root, { mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    const tx = new ArchiveTransaction(root, output, "candidate");
    try {
        await tx.initialize();
        const snapshot = await tx.write("snapshots/node.tar.gz", assetBytes(tarBytes(entries)));
        return await run({ tx, snapshot, base, root, output });
    } finally {
        await tx.cleanup();
        await rm(base, { recursive: true, force: true });
    }
}
