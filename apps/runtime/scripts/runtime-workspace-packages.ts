import { opendir, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { canonicalBytes } from "@veriq/contracts";
import { DependencyFiles, writeDependencySource } from "./runtime-dependency-files.ts";
import { decode, fail, limits, relative, sha, freeze } from "./runtime-payload-tree.ts";
import type { Ref, SourceBindingV1 } from "./runtime-payload-inputs.ts";

/**
 * 生成包记录明确区分原始 Git 来源、原清单和输出清单，所有 JS 与声明文件来自本次真实 TypeScript 发射；消费者只能将输出文
 * 件当作生成材料，不能把它们倒写入 SourceBinding 冒充已存在的源码。
 */
export type GeneratedWorkspacePackage = Readonly<{
    name: string;
    version: string;
    sourceRoot: string;
    generatedRoot: string;
    originalManifest: Ref;
    generatedManifest: Ref;
    originalSourceRefs: readonly Ref[];
    files: readonly Ref[];
}>;

/**
 * 编译宿主文件保留实际绝对路径供后续同机材料复核，区别于 SourceBinding 中相对源码根的 Ref；第三方声明、标准库和编译器实
 * 现都属于宿主观察，不能借同形摘要结构被解释为原始 Git 文件。
 */
export type WorkspaceCompilerFile = Readonly<{
    absolutePath: string;
    sizeBytes: number;
    sha256: string;
}>;

/**
 * 编译证据记录真实工具版本、选项、读取文件摘要和全部输出，原始源码与生成包路径保持不同根语义；它描述本次宿主操作而不扩
 * 展现有收据的来源认证强度，也不签发引擎批准或最终发行状态。
 */
export type WorkspaceGenerationEvidence = Readonly<{
    typescriptVersion: string;
    compilerImplementation: readonly WorkspaceCompilerFile[];
    compilerOptions: Readonly<Record<string, unknown>>;
    compilerReads: readonly WorkspaceCompilerFile[];
    packages: readonly GeneratedWorkspacePackage[];
}>;

/**
 * 递归源集合先确认每个真实节点类型和路径预算，再与绑定中对应子树完全比较，遗漏的源码或资产都会失败；链接、测试目录和共
 * 享 node_modules 不会通过扫描进入生产工作区生成包。
 */
async function sourceMembers(
    root: string,
    prefix: string,
    files: DependencyFiles,
): Promise<string[]> {
    const output: string[] = [];
    const walk = async (path: string) => {
        relative(path);
        if (output.length > limits.entries) fail("PAYLOAD_LIMIT");
        const info = await lstat(join(root, path));
        if (info.isDirectory()) {
            await files.directory(join(root, path));
            const directory = await opendir(join(root, path));
            for await (const entry of directory) await walk(`${path}/${entry.name}`);
        } else if (info.isFile()) output.push(path);
        else fail("PAYLOAD_TREE_MISMATCH");
    };
    await walk(prefix);
    return output.sort();
}

/**
 * 包 exports 保留原有条件与全部子路径，只把指向已发射 TypeScript 模块的字符串转换为对应 JavaScript；schemas 通配符和其
 * 它资产路径逐字保留，不能用只有点入口的简化清单丢掉 contracts
 * 的 openapi 或 schema 导出。
 */
function emittedExports(value: unknown): unknown {
    if (typeof value === "string") return value.replace(/(?<!\.d)\.ts$/, ".js");
    if (Array.isArray(value)) return value.map(emittedExports);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, emittedExports(child)]),
        );
    if (value === null || value === undefined) return value;
    fail("PAYLOAD_RECEIPT_MISMATCH");
}

/**
 * 生产工作区使用仓库已声明 TypeScript API 发射 contracts 与 SDK 的真实 JS 和声明文件，并保存全部原清单与资产；引擎
 * compiler 的 TS 归档与显式 tsx 调用完全由既有引擎生产器负责
 * ，此函数不安装全局加载器。
 */
export async function materializeRuntimeWorkspacePackages(
    options: Readonly<{
        sourceRoot: string;
        outputRoot: string;
        source: SourceBindingV1;
        files: DependencyFiles;
    }>,
): Promise<WorkspaceGenerationEvidence> {
    const { sourceRoot, outputRoot, source, files } = options;
    if (ts.version !== "5.9.3") fail("PAYLOAD_RECEIPT_MISMATCH");
    const compilerModule = await realpath(fileURLToPath(import.meta.resolve("typescript")));
    const compilerManifest = join(dirname(compilerModule), "../package.json");
    const compilerPackage = decode(await files.read(compilerManifest, limits.package)) as {
        name?: string;
        version?: string;
    };
    if (compilerPackage.name !== "typescript" || compilerPackage.version !== ts.version)
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const compilerImplementation = [] as WorkspaceCompilerFile[];
    for (const path of [compilerModule, compilerManifest]) {
        const fact = await files.fact(path);
        compilerImplementation.push({
            absolutePath: fact.path,
            sizeBytes: fact.sizeBytes,
            sha256: fact.sha256,
        });
    }
    const refs = new Map(source.files.map((ref) => [ref.path, ref]));
    const names = ["contracts", "runner-sdk"];
    const roots: string[] = [];
    const originals = new Map<string, Ref[]>();
    for (const name of names) {
        const prefix = `packages/${name}`;
        const members = await sourceMembers(sourceRoot, `${prefix}/src`, files);
        if (name === "contracts")
            members.push(...(await sourceMembers(sourceRoot, `${prefix}/schemas`, files)));
        members.push(`${prefix}/package.json`, "LICENSE");
        const expected = source.files
            .filter(
                (ref) =>
                    ref.path.startsWith(`${prefix}/src/`) ||
                    (name === "contracts" && ref.path.startsWith(`${prefix}/schemas/`)),
            )
            .map((ref) => ref.path);
        if (
            expected.length !== members.length - 2 ||
            expected.some((path) => !members.includes(path))
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
        const bound: Ref[] = [];
        for (const path of members) {
            const ref = refs.get(path);
            if (!ref) fail("PAYLOAD_RECEIPT_MISMATCH");
            const bytes = await files.read(join(sourceRoot, path), limits.javascript);
            if (bytes.length !== ref.sizeBytes || sha(bytes) !== ref.sha256)
                fail("PAYLOAD_SOURCE_CHANGED");
            bound.push(ref);
            if (path.startsWith(`${prefix}/src/`) && path.endsWith(".ts"))
                roots.push(join(sourceRoot, path));
        }
        originals.set(name, bound);
    }
    const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        declaration: true,
        strict: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        esModuleInterop: true,
        noEmitOnError: true,
        outDir: outputRoot,
        rootDir: join(sourceRoot, "packages"),
        typeRoots: [join(sourceRoot, "packages/runner-sdk/node_modules/@types")],
    };
    // 编译器的同步宿主只记录已实际读取的字节，读取来源包时必须存在独立绑定；第三方声明和 TypeScript 标准库也保留摘要，
    // 后续验证可识别真实宿主工具输入而不会误称它们是 Git 原源码。
    const host = ts.createCompilerHost(compilerOptions);
    const originalRead = host.readFile.bind(host);
    const compilerReads = new Map<string, WorkspaceCompilerFile>();
    host.readFile = (path) => {
        const text = originalRead(path);
        if (text === undefined) return undefined;
        const bytes = Buffer.from(text),
            rel = relativePath(sourceRoot, path).replaceAll("\\", "/");
        if (!rel.startsWith("../") && !rel.split("/").includes("node_modules")) {
            const expected = refs.get(rel);
            if (!expected || expected.sizeBytes !== bytes.length || expected.sha256 !== sha(bytes))
                fail("PAYLOAD_SOURCE_CHANGED");
        }
        compilerReads.set(path, {
            absolutePath: path,
            sizeBytes: bytes.length,
            sha256: sha(bytes),
        });
        return text;
    };
    const outputs = new Map<string, Buffer>();
    host.writeFile = (path, text) => {
        const rel = relativePath(outputRoot, path).replaceAll("\\", "/");
        relative(rel);
        if (!names.some((name) => rel.startsWith(`${name}/`)) || outputs.has(rel))
            fail("PAYLOAD_PATH");
        outputs.set(rel, Buffer.from(text));
    };
    const program = ts.createProgram(roots, compilerOptions, host);
    if (
        ts
            .getPreEmitDiagnostics(program)
            .some((item) => item.category === ts.DiagnosticCategory.Error)
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const emission = program.emit();
    if (
        emission.emitSkipped ||
        emission.diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)
    )
        fail("PAYLOAD_RECEIPT_MISMATCH");
    const packages: GeneratedWorkspacePackage[] = [];
    for (const name of names) {
        const prefix = `packages/${name}`,
            original = refs.get(`${prefix}/package.json`)!;
        const manifest = decode(
            await files.read(join(sourceRoot, original.path), limits.package),
        ) as Record<string, unknown>;
        if (manifest.name !== `@veriq/${name}` || typeof manifest.version !== "string")
            fail("PAYLOAD_RECEIPT_MISMATCH");
        const generated = { ...manifest, exports: emittedExports(manifest.exports) };
        const json = canonicalBytes(generated);
        outputs.set(`${name}/package.json`, json);
        for (const ref of originals.get(name)!) {
            if (ref.path === "LICENSE")
                outputs.set(`${name}/LICENSE`, await files.read(join(sourceRoot, ref.path)));
            else if (
                (!ref.path.endsWith(".ts") || ref.path.endsWith(".d.ts")) &&
                ref.path !== original.path
            )
                outputs.set(
                    `${name}/${ref.path.slice(prefix.length + 1)}`,
                    await files.read(join(sourceRoot, ref.path)),
                );
        }
        const outputRefs: Ref[] = [];
        for (const [path, bytes] of [...outputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
            if (!path.startsWith(`${name}/`)) continue;
            await writeDependencySource(outputRoot, path, bytes);
            outputRefs.push({
                path: path.slice(name.length + 1),
                sizeBytes: bytes.length,
                sha256: sha(bytes),
            });
        }
        if (
            !outputRefs.some((ref) => ref.path === "src/index.js") ||
            (name === "contracts" && !outputRefs.some((ref) => ref.path === "src/api.generated.js"))
        )
            fail("PAYLOAD_RECEIPT_MISMATCH");
        packages.push({
            name: String(manifest.name),
            version: manifest.version,
            sourceRoot: prefix,
            generatedRoot: resolve(outputRoot, name),
            originalManifest: original,
            generatedManifest: outputRefs.find((ref) => ref.path === "package.json")!,
            originalSourceRefs: originals.get(name)!,
            files: outputRefs,
        });
    }
    // emit 结束后重新持有编译器实际读取的全部源文件、声明和工具文件，避免同步读取记录在等待写出之后失效；文本输入要求
    // UTF8 原字节一致，带 BOM 或编码变化不能通过 TypeScript 的解码宽容掩盖。
    for (const ref of compilerReads.values()) {
        const bytes = await files.read(ref.absolutePath, limits.javascript);
        if (bytes.length !== ref.sizeBytes || sha(bytes) !== ref.sha256)
            fail("PAYLOAD_SOURCE_CHANGED");
    }
    return freeze({
        typescriptVersion: ts.version,
        compilerImplementation,
        compilerOptions: { ...compilerOptions },
        compilerReads: [...compilerReads.values()],
        packages,
    });
}
