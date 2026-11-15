import { readFile } from "node:fs/promises";
import { canonicalBytes } from "@veriq/contracts";
import type { Arch, FileFact } from "../../scripts/runtime-payload-inputs.ts";
import { GENERATOR_SOURCES } from "../../scripts/runtime-payload-generation.ts";
import { archiveModel } from "./runtime-payload-archives.ts";
import { bytes, hash } from "./runtime-payload.ts";

/** 完整 stage 夹具复制当前真正使用的微型源码字节并同步重封原 SourceBinding 和全部构建收据，npm 包也有真实声明与自有树摘要；假 Node 和 Chrome 都是普通测试文本，绝不执行或冒充 Mac 原生验收。 */
export async function stageModel(arch: Arch = "x64") {
    const value = archiveModel(arch);
    value.add("entries", "chunks/shared.js", "export const shared = true;\n");
    value.add("entries", "assets/veriq.css", ".veriq{color:blue}\n");
    value.receipts.entries.outputs.push(
        { path: "chunks/shared.js", kind: "chunk", imports: [] },
        { path: "assets/veriq.css", kind: "asset", imports: [] },
    );
    for (const source of GENERATOR_SOURCES) {
        const content = await readFile(new URL(source.url)),
            ref = value.put(source.path, content);
        const existing = value.sourceBinding.files.find((f) => f.path === source.path);
        if (existing) Object.assign(existing, ref);
        else value.sourceBinding.files.push(ref);
    }
    Object.assign(
        value.recipe.source.pnpmLock,
        value.sourceBinding.files.find((f) => f.path === "pnpm-lock.yaml")!,
    );
    value.expected.pnpmLockSha256 = value.recipe.source.pnpmLock.sha256;
    const pkg = value.nodeEntries.find((e) => e.path.endsWith("/npm/package.json"))!;
    pkg.body = JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } });
    const npmFiles: FileFact[] = value.nodeEntries
        .filter(
            (e) =>
                (e.kind ?? "file") === "file" && e.path.startsWith(value.nodeReceipt.npmRoot + "/"),
        )
        .map(
            (e): FileFact => ({
                path: e.path.slice(value.nodeReceipt.npmRoot.length + 1),
                sizeBytes: Buffer.byteLength(e.body!),
                sha256: hash(Buffer.from(e.body!)),
                mode: e.mode === 0o755 ? 0o755 : 0o644,
            }),
        )
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    const graph = value.nodeReceipt.npmGraph;
    graph.instances[0]!.ownTreeSha256 = hash(
        canonicalBytes({ directories: ["bin"], files: npmFiles }),
    );
    graph.bins.push({
        owner: "p1",
        name: "npm",
        aliasPath: "npm/.bin/npm",
        sourceAlias: null,
        targetPath: "npm/bin/npm-cli.js",
        targetSha256: npmFiles.find((f) => f.path === "bin/npm-cli.js")!.sha256,
        launcher: "node",
        inspection: null,
    });
    let nodeOverride: Buffer<ArrayBuffer> | undefined,
        chromeOverride: Buffer<ArrayBuffer> | undefined;
    const seal = () => {
        value.put(value.recipe.source.binding.path, bytes(value.sourceBinding));
        const bindingSha = hash(bytes(value.sourceBinding));
        value.expected.sourceBindingSha256 = bindingSha;
        for (const receipt of Object.values(value.receipts)) {
            receipt.build.sourceBindingSha256 = bindingSha;
            receipt.build.pnpmLockSha256 = value.recipe.source.pnpmLock.sha256;
        }
        value.receipts.dependencies.linker.sourceLockSha256 = value.recipe.source.pnpmLock.sha256;
        value.receipts.dependencies.linker.lockAfterSha256 = value.recipe.source.pnpmLock.sha256;
        value.bind(nodeOverride, chromeOverride);
        for (const instance of value.nodeReceipt.npmGraph.instances)
            instance.lockSnapshot = `node-archive:${value.recipe.node.file.sha256}:${instance.root === "npm" ? "." : instance.root.slice(4)}`;
        return value.seal();
    };
    seal();
    return {
        ...value,
        seal,
        bind: (node?: Buffer, chrome?: Buffer) => {
            nodeOverride = node ? Buffer.from(node) : undefined;
            chromeOverride = chrome ? Buffer.from(chrome) : undefined;
            return seal();
        },
    };
}

/** npm 反例准备按夹具原归档事实独立推导普通文件与父目录，再按最深实例切分并重封自有树摘要；它不更改 package 声明、依赖边或 bin 关系，因此正文与声明矛盾仍由产品消费者实际发现而不是被测试自动修复。
 */
export function rehashStageNpm(value: Awaited<ReturnType<typeof stageModel>>) {
    const root = value.nodeReceipt.npmRoot,
        graph = value.nodeReceipt.npmGraph;
    const members = new Map(value.nodeEntries.map((entry) => [entry.path, entry]));
    const directories = new Set<string>(["npm"]),
        files: FileFact[] = [];
    for (const entry of value.nodeEntries.filter((entry) => entry.path.startsWith(root + "/"))) {
        const path = `npm/${entry.path.slice(root.length + 1)}`;
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
        if (entry.kind === "directory") {
            directories.add(path);
            continue;
        }
        if (graph.bins.some((bin) => bin.sourceAlias === path)) continue;
        let current = entry;
        const seen = new Set<string>();
        while (current.kind === "link") {
            if (seen.has(current.path)) throw new Error("Fixture link cycle");
            seen.add(current.path);
            const joined = [...current.path.split("/").slice(0, -1), ...current.target!.split("/")],
                normalized: string[] = [];
            for (const component of joined) {
                if (component === "..") normalized.pop();
                else if (component !== ".") normalized.push(component);
            }
            current = members.get(normalized.join("/"))!;
            if (!current) throw new Error("Fixture missing terminal");
        }
        const body = Buffer.from(current.body ?? "");
        files.push({
            path,
            sizeBytes: body.length,
            sha256: hash(body),
            mode: current.mode === 0o755 ? 0o755 : 0o644,
        });
    }
    const owner = (path: string) =>
        graph.instances
            .filter(
                (instance) =>
                    path.startsWith(instance.root + "/") &&
                    !path
                        .slice(instance.root.length + 1)
                        .split("/")
                        .some((component) => component === "node_modules" || component === ".bin"),
            )
            .sort((a, b) => b.root.length - a.root.length)[0];
    for (const instance of graph.instances) {
        const pkg = files.find((file) => file.path === `${instance.root}/package.json`)!;
        instance.packageJson = { sizeBytes: pkg.sizeBytes, sha256: pkg.sha256 };
        instance.ownTreeSha256 = hash(
            canonicalBytes({
                directories: [...directories]
                    .filter((directory) => owner(directory)?.id === instance.id)
                    .map((directory) => directory.slice(instance.root.length + 1))
                    .sort(),
                files: files
                    .filter((file) => owner(file.path)?.id === instance.id)
                    .map((file) => ({ ...file, path: file.path.slice(instance.root.length + 1) }))
                    .sort((a, b) => (a.path < b.path ? -1 : 1)),
            }),
        );
    }
    value.nodeReceipt.npmPackageJson = {
        ...graph.instances.find((instance) => instance.root === "npm")!.packageJson,
    };
    value.nodeReceipt.inputLinks = value.nodeEntries
        .filter((entry) => entry.kind === "link")
        .map((entry) => ({ path: entry.path, target: entry.target! }));
    value.bind();
}
