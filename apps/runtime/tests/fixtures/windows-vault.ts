/** Windows 保险库夹具只执行本次正式或隔离测试 helper，其余小成员用于取得完整库存能力而不冒充可运行发行；目录采用实际规范路径以避开临时目录短名别名，所有合成凭据与文件均由当前测试拥有并单独清理。 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadRuntimeDistribution } from "../../src/distribution.ts";

/** 夹具逐成员计算真实字节摘要后调用正式发行解析器，不能靠手工对象或从配置读取的程序路径绕过能力绑定；helper 可省略以检验旧库存的明确拒绝，原生 addon 使用真实构建产物但不会由普通 Node 解析过程自动加载。 */
export async function windowsVaultDistribution(helper?: Uint8Array) {
    const container = await realpath(await mkdtemp(join(tmpdir(), "veriq vault 中文 ")));
    const root = join(container, "distribution");
    const names = [
        "roles/agent/veriq_agent.exe",
        "roles/runner/veriq_runner.exe",
        "roles/cli/veriq_cli.exe",
        "native/veriq_runner.exe",
        "native/veriq_native.node",
        "entry/agent.js",
        "entry/cli.js",
        "execution/worker.mjs",
        "execution/provider.mjs",
        "execution/compile-entry.mjs",
        "execution/archive.mjs",
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        "browser/chrome-win64/chrome.exe",
        "engines/1.0.3-t20/inventory.json",
    ];
    if (helper) names.push("native/vault/veriq_agent.exe");
    try {
        await mkdir(root);
        const addon = await readFile(
            new URL("../../build/Release/veriq_native.node", import.meta.url),
        );
        const files = [];
        for (const path of names) {
            const bytes =
                path === "native/vault/veriq_agent.exe"
                    ? helper!
                    : path === "native/veriq_native.node"
                      ? addon
                      : Buffer.from(path);
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), bytes);
            files.push({
                path,
                sizeBytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
            });
        }
        await writeFile(
            join(root, "runtime-manifest.json"),
            JSON.stringify({
                schemaVersion: 1,
                productVersion: "1.0.0-dev.t20",
                nodeVersion: "24.22.1",
                platform: "win32",
                arch: process.arch,
                engineVersion: "1.0.3-t20",
                files,
            }),
        );
        return {
            root: container,
            distribution: await loadRuntimeDistribution(root),
            cleanup: () =>
                rm(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
        };
    } catch (error) {
        await rm(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        throw error;
    }
}
