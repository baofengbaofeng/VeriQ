import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
    cpSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    realpathSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import type { EngineDistribution } from "../../compiler/src/index.js";
/** Builds real SDK/contracts JS + declarations and exact local dependency archives; no fixture SDK. */
export function actualDistribution(root: string): EngineDistribution {
    const packages = resolve("../"),
        built = join(root, "built");
    const sources = (path: string): string[] =>
        readdirSync(path, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory()
                ? sources(join(path, e.name))
                : e.name.endsWith(".ts")
                    ? [join(path, e.name)]
                    : [],
        );
    const program = ts.createProgram(
        [
            ...sources(join(packages, "runner-sdk/src")),
            ...sources(join(packages, "contracts/src")),
        ],
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
                getCanonicalFileName: (x) => x,
                getCurrentDirectory: () => process.cwd(),
                getNewLine: () => "\n",
            }),
        );
    program.emit();
    const collected = new Map<
        string,
        { dir: string; pkg: Record<string, unknown> }
    >();
    function collect(name: string, from: string) {
        if (collected.has(name)) return;
        const local =
            name === "@veriq/runner-sdk"
                ? "runner-sdk"
                : name === "@veriq/contracts"
                    ? "contracts"
                    : undefined;
        let dir: string;
        if (local) {
            dir = join(built, local);
            const pkg = JSON.parse(
                readFileSync(join(packages, local, "package.json"), "utf8"),
            );
            const dependencies = Object.fromEntries(
                Object.entries(pkg.dependencies as Record<string, string>).map(
                    ([k, v]) => [k, v.startsWith("workspace:") ? "0.1.0" : v],
                ),
            );
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name,
                    version: pkg.version,
                    type: "module",
                    exports: {
                        ".": { types: "./src/index.d.ts", default: "./src/index.js" },
                    },
                    dependencies,
                }),
            );
            if (local === "contracts")
                cpSync(join(packages, local, "schemas"), join(dir, "schemas"), {
                    recursive: true,
                });
        } else {
            const lookup = createRequire(join(from, "package.json"));
            dir = dirname(lookup.resolve(name + "/package.json"));
        }
        dir = realpathSync(dir);
        const pkg = JSON.parse(
            readFileSync(join(dir, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        collected.set(name, { dir, pkg });
        for (const dep of Object.keys(pkg.dependencies ?? {}))
            collect(dep, local ? join(packages, local) : dir);
    }
    collect("@veriq/runner-sdk", process.cwd());
    // T10 executes the archived compiler in the same approved offline closure.
    collect("typescript", join(packages, "compiler"));
    const files: Record<string, Uint8Array> = {},
        inventory: EngineDistribution["dependencies"] = [],
        nodes: Record<string, unknown> = {},
        dependencies: Record<string, string> = {};
    let index = 0;
    for (const [name, { dir, pkg }] of collected) {
        const work = join(root, "pack-" + index),
            filename = `vendor/${index++}.tgz`;
        mkdirSync(join(work, "package"), { recursive: true });
        cpSync(dir, join(work, "package"), {
            recursive: true,
            filter: (p) => !relative(dir, p).split("/").includes("node_modules"),
        });
        const archive = join(root, filename);
        mkdirSync(dirname(archive), { recursive: true });
        execFileSync("tar", ["-czf", archive, "-C", work, "package"]);
        const bytes = readFileSync(archive),
            integrity =
                "sha512-" + createHash("sha512").update(bytes).digest("base64");
        files[filename] = bytes;
        inventory.push({ name, version: pkg.version as string, integrity });
        dependencies[name] = "file:" + filename;
        nodes["node_modules/" + name] = {
            version: pkg.version,
            resolved: "file:" + filename,
            integrity,
            ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
        };
    }
    const pkg = {
        name: "veriq-generated",
        version: "0.1.0",
        type: "module",
        dependencies,
    };
    return {
        engineVersion: "0.1.0",
        runnerSdkVersion: "0.1.0",
        packageJson: Buffer.from(JSON.stringify(pkg)),
        packageLock: Buffer.from(
            JSON.stringify({
                name: pkg.name,
                version: pkg.version,
                lockfileVersion: 3,
                packages: { "": pkg, ...nodes },
            }),
        ),
        dependencies: inventory,
        files,
    };
}
