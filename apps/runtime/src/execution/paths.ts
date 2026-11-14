import { dirname, join, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 执行路径来自可信宿主或完整核验后的安装清单，签名业务包与 renderer 均不能选择这些入口；Agent 和 Runner 使用独立角色文件，npm 与编译加载器只接收实际 JavaScript 路径。 */
export interface ExecutionPaths {
    runnerExecutable: string;
    guardianExecutable: string;
    npmCli: string;
    tsx: string;
    workerEntry: string;
    providerEntry: string;
    compileEntry: string;
}

/** 开发入口保持当前 Node 与原生监管器的既有关系，但把 npm 符号链接解析到实际 CLI JavaScript；安装模式必须显式传入已验证路径，不应调用此开发回退函数来寻找全局工具。 */
export function developmentExecutionPaths(): ExecutionPaths {
    return {
        runnerExecutable: process.execPath,
        guardianExecutable: fileURLToPath(new URL("../../build/veriq_runner", import.meta.url)),
        npmCli: realpathSync(
            join(
                dirname(process.execPath),
                process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm",
            ),
        ),
        tsx: fileURLToPath(import.meta.resolve("tsx")),
        workerEntry: fileURLToPath(new URL("worker.mjs", import.meta.url)),
        providerEntry: fileURLToPath(new URL("provider.mjs", import.meta.url)),
        compileEntry: fileURLToPath(new URL("compile-entry.mjs", import.meta.url)),
    };
}

/** 本机路径归属使用当前平台的 relative 与绝对路径判定，禁止用固定斜线前缀误判 Windows 盘符或相邻同名前缀目录；该词法检查不替代文件打开前的符号链接与实际句柄校验。 */
export function containedPath(root: string, path: string): boolean {
    const child = relative(root, path);
    return (
        !!child &&
        child !== ".." &&
        !child.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
        !isAbsolute(child)
    );
}
