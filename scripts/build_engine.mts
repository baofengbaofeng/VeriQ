/** 生产引擎候选生成器将真实 SDK 与合同源码编译成可安装包，并收集当前冻结依赖的实际字节，输出独立版本的完整库存；此命令没有签发者配置，也不会把候选自动晋升为批准发行。
 * 编译器归档保留 Runtime compile-entry 当前要求的 src/index.ts 路径。
 * npm 负责生成锁文件，tar 负责固定排序、时间与所有者的归档。
 * 已存在的同版本目录禁止覆盖，旧签名包的发行身份必须保留。
 * 所有临时复制仅发生于 work 下，不修改共享 node_modules 文件。
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
    cpSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    realpathSync,
    existsSync,
    renameSync,
    rmSync,
    mkdtempSync,
    lstatSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "../packages/compiler/node_modules/typescript/lib/typescript.js";
import { canonicalBytes, validateSchema } from "../packages/contracts/src/index.js";
import { archive } from "../apps/runtime/src/execution/archive.mjs";
import { containedPath, developmentExecutionPaths } from "../apps/runtime/src/execution/paths.ts";
import { COMPILER_VERSION } from "../packages/compiler/src/index.js";

const root = resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error("Explicit engine version required");
const output = resolve(process.argv[3] ?? join(root, "work/engines", version));
// 输出目录及全部现有父级必须是真实目录，词法上位于 work 内的符号链接仍可能指向外部状态，因此在创建临时目录和写入任何候选字节前逐级拒绝链接组件。
for (let ancestor = output; dirname(ancestor) !== ancestor; ancestor = dirname(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("Linked engine output path is forbidden");
    }
}
if (!containedPath(join(root, "work"), output) || existsSync(output))
    throw new Error("Engine output must be a new work directory");
mkdirSync(dirname(output), { recursive: true });
const work = mkdtempSync(join(dirname(output), ".engine-"));
const built = join(work, "built");
const release = join(work, "release");
mkdirSync(release);

/** 源文件集合只包含生产 TypeScript 输入，声明文件随编译输出归档，测试夹具不进入引擎；递归前确认节点类型，避免把链接到工作区外的源码作为可信发行输入。
 * 编译器自身仍由 Runtime 的 Node24 类型剥离路径加载。
 * SDK 与合同输出普通 JavaScript，供生成的 Playwright 测试导入。
 */
function sources(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isSymbolicLink()) throw new Error("Linked engine source is forbidden");
        const child = join(path, entry.name);
        return entry.isDirectory() ? sources(child) : entry.name.endsWith(".ts") ? [child] : [];
    });
}

try {
    const packages = join(root, "packages");
    const program = ts.createProgram(
        [...sources(join(packages, "runner-sdk/src")), ...sources(join(packages, "contracts/src"))],
        {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            declaration: true,
            strict: true,
            skipLibCheck: true,
            resolveJsonModule: true,
            esModuleInterop: true,
            outDir: built,
            rootDir: packages,
            typeRoots: [join(packages, "runner-sdk/node_modules/@types")],
        },
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length)
        throw new Error(
            ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                getCanonicalFileName: (value) => value,
                getCurrentDirectory: () => root,
                getNewLine: () => "\n",
            }),
        );
    if (program.emit().emitSkipped) throw new Error("Engine TypeScript emission failed");
    const collected = new Map<
        string,
        { dir: string; pkg: { version: string; dependencies?: Record<string, string> } }
    >();

    /** 依赖解析复用 Node 对已冻结安装树的定位结果，遇到同名不同版本即失败而不自行选择版本；这份发行仅支持已审定的单版本闭包，未来多版本需求必须另行设计与验证。
     * 工作区 SDK 与合同换成刚编译的目录，并保留实际版本号。
     * 第三方文件只复制，不改变其元数据或许可证。
     * 对 workspace 引用的替换使用被引用包实际版本，不硬编码产品号。
     */
    function collect(name: string, from: string): void {
        const local =
            name === "@veriq/runner-sdk"
                ? "runner-sdk"
                : name === "@veriq/contracts"
                  ? "contracts"
                  : undefined;
        let directory: string;
        if (local) {
            directory = join(built, local);
            const manifest = JSON.parse(
                readFileSync(join(packages, local, "package.json"), "utf8"),
            );
            const dependencies = Object.fromEntries(
                Object.entries(manifest.dependencies as Record<string, string>).map(
                    ([key, value]) => [
                        key,
                        value.startsWith("workspace:")
                            ? JSON.parse(
                                  readFileSync(
                                      join(
                                          packages,
                                          key.slice(key.indexOf("/") + 1),
                                          "package.json",
                                      ),
                                      "utf8",
                                  ),
                              ).version
                            : value,
                    ],
                ),
            );
            writeFileSync(
                join(directory, "package.json"),
                JSON.stringify({
                    name,
                    version: manifest.version,
                    type: "module",
                    license: manifest.license,
                    exports: { ".": { types: "./src/index.d.ts", default: "./src/index.js" } },
                    dependencies,
                }),
            );
            cpSync(join(root, "LICENSE"), join(directory, "LICENSE"));
            if (local === "contracts")
                cpSync(join(packages, local, "schemas"), join(directory, "schemas"), {
                    recursive: true,
                });
        } else {
            const lookup = createRequire(join(from, "package.json"));
            directory = dirname(lookup.resolve(name + "/package.json"));
        }
        directory = realpathSync(directory);
        const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        const previous = collected.get(name);
        if (previous) {
            if (previous.pkg.version !== pkg.version)
                throw new Error(
                    "Multiple engine dependency versions require an explicit release design",
                );
            return;
        }
        /** 当前引擎闭包没有原生可选依赖，平台相关的 tsx 与 esbuild 属于外层 Runtime；未来依赖若增加 optionalDependencies 必须先明确跨平台收集策略，不能静默遗漏后仍宣称同一库存可离网执行。 */
        if (Object.keys(pkg.optionalDependencies ?? {}).length)
            throw new Error("Engine optional dependencies require an explicit target closure");
        collected.set(name, { dir: directory, pkg });
        for (const dependency of Object.keys(pkg.dependencies ?? {}))
            collect(dependency, local ? join(packages, local) : directory);
    }

    collect("@veriq/runner-sdk", root);
    collect("typescript", join(packages, "compiler"));
    const dependencies: { name: string; version: string; integrity: string }[] = [];
    const direct: Record<string, string> = {};
    for (const [name, { dir, pkg }] of [...collected].sort(([a], [b]) => a.localeCompare(b))) {
        const filename = `vendor/${name.replaceAll("/", "-").replaceAll("@", "")}-${pkg.version}.tgz`;
        const packed = join(work, "pack");
        cpSync(dir, join(packed, "package"), {
            recursive: true,
            dereference: true,
            filter: (path) => !relative(dir, path).split(/[\\/]/).includes("node_modules"),
        });
        await archive(packed, ["package"], join(release, filename));
        rmSync(packed, { recursive: true });
        const content = readFileSync(join(release, filename));
        dependencies.push({
            name,
            version: pkg.version,
            integrity: "sha512-" + createHash("sha512").update(content).digest("base64"),
        });
        direct[name] = "file:" + filename;
    }
    writeFileSync(
        join(release, "package.json"),
        JSON.stringify(
            {
                name: "veriq-generated",
                version,
                type: "module",
                private: true,
                dependencies: direct,
            },
            null,
            4,
        ) + "\n",
    );
    execFileSync(
        process.execPath,
        [
            developmentExecutionPaths().npmCli,
            "install",
            "--package-lock-only",
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--update-notifier=false",
            "--cache",
            join(work, "npm-cache"),
        ],
        { cwd: release, stdio: "inherit" },
    );
    writeFileSync(join(release, "dependencies.json"), canonicalBytes(dependencies));
    const compiler = join(work, "compiler");
    cpSync(join(packages, "compiler/src"), join(compiler, "src"), { recursive: true });
    cpSync(join(packages, "compiler/package.json"), join(compiler, "package.json"));
    cpSync(join(root, "LICENSE"), join(compiler, "LICENSE"));
    await archive(
        compiler,
        ["src", "package.json", "LICENSE"],
        join(release, "engine/compiler.tgz"),
    );
    const members = [
        "package.json",
        "package-lock.json",
        "dependencies.json",
        "engine/compiler.tgz",
        ...Object.values(direct).map((value) => value.slice(5)),
    ];
    const sdk = collected.get("@veriq/runner-sdk");
    if (!sdk) throw new Error("Runner SDK is missing from the engine closure");
    const engine = {
        engineVersion: version,
        compilerVersion: COMPILER_VERSION,
        runnerSdkVersion: sdk.pkg.version,
        dependencies,
        files: members.sort().map((path) => {
            const bytes = readFileSync(join(release, path));
            return {
                path,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                sizeBytes: bytes.length,
            };
        }),
    };
    const inventory = { schemaVersion: "1.0", engines: [engine] };
    if (validateSchema("ApprovedEngineInventoryV1", inventory).length)
        throw new Error("Invalid engine candidate inventory");
    writeFileSync(join(release, "inventory.json"), canonicalBytes(inventory));
    renameSync(release, output);
    process.stdout.write(
        JSON.stringify({
            engineVersion: version,
            inventoryHash: createHash("sha256").update(canonicalBytes(engine)).digest("hex"),
            output,
        }) + "\n",
    );
} finally {
    rmSync(work, { recursive: true, force: true });
}
