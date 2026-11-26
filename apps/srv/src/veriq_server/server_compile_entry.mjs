/**
 * 服务端编译入口只读取独立工作目录中的冻结快照与已核准发行，沿用同一编译器生成校验产物及用例入口。
 * 本进程不读取控制服务配置，不提供外部连接或运行用例的入口，错误仅写入结构化静态分析诊断。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalBytes } from "@veriq/contracts";
import * as compiler from "./engine/compiler/src/index.ts";

const release = JSON.parse(await readFile("release.json", "utf8"));
const snapshot = JSON.parse(await readFile("snapshot.json", "utf8"));
const files = Object.fromEntries(
    await Promise.all(
        release.files
            .filter(({ path }) => path.startsWith("vendor/"))
            .map(async ({ path }) => [path, await readFile(path)]),
    ),
);
const distribution = {
    engineVersion: release.engineVersion,
    runnerSdkVersion: release.runnerSdkVersion,
    dependencies: release.dependencies,
    packageJson: await readFile("package.json"),
    packageLock: await readFile("package-lock.json"),
    files,
};

const diagnostics =
    typeof compiler.safeDiagnostics === "function" ? compiler.safeDiagnostics(compiler.analyze(snapshot).issues) : [];
if (diagnostics.length) {
    await writeFile("diagnostics.json", canonicalBytes(diagnostics), { mode: 0o600 });
} else {
    const compiled = compiler.compileFiles(snapshot, distribution, { connected: process.argv[2] === "--connected" });
    for (const [path, bytes] of Object.entries(compiled.files)) {
        // 编译器所列路径进入文件系统之前仍须检查相对成员格式，避免坏描述符突破本任务的私有输出目录。
        if (path.split("/").some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part) || part === "." || part === "..")) {
            throw new Error("UNSAFE_COMPILER_PATH");
        }
        const target = join("compiled", path);
        await mkdir(dirname(target), { mode: 0o700, recursive: true });
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    }
    await writeFile("compiled/bundle.json", canonicalBytes(compiled.bundle), { mode: 0o600, flag: "wx" });
}
