/** 保险库测试使用自有临时发行目录并真实计算每个成员摘要，只有被测辅助程序会执行，其余小文件仅满足既有库存解析契约；这些夹具不冒充完整 Node、浏览器或安装发行验收。 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRuntimeDistribution } from "../../src/distribution.ts";

/** 构造夹具时先创建全部固定成员再计算真实库存并调用正式解析器，辅助程序能力不会由测试对象手工伪造；无辅助成员的旧库存仍可被解析，只有请求执行能力时才明确拒绝且不搜索全局路径。 */
export async function vaultDistribution(helper?: Uint8Array) {
    const root = await mkdtemp(join(tmpdir(), "veriq vault 中文 "));
    const names = [
        "roles/agent/veriq_agent",
        "roles/runner/veriq_runner",
        "roles/cli/veriq_cli",
        "native/veriq_runner",
        "entry/agent.js",
        "entry/cli.js",
        "execution/worker.mjs",
        "execution/provider.mjs",
        "execution/compile-entry.mjs",
        "execution/archive.mjs",
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        "browser/chrome-linux64/chrome",
        "engines/1.0.3-t20/inventory.json",
    ];
    if (helper) names.push("native/vault/veriq_agent");
    try {
        const files = [];
        for (const path of names) {
            const bytes = path === "native/vault/veriq_agent" ? helper! : Buffer.from(path);
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), bytes, { mode: 0o600 });
            files.push({
                path,
                sizeBytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
            });
        }
        if (helper) await chmod(join(root, "native/vault/veriq_agent"), 0o700);
        await writeFile(
            join(root, "runtime-manifest.json"),
            JSON.stringify({
                schemaVersion: 1,
                productVersion: "1.0.0-dev.t20",
                nodeVersion: "24.22.1",
                platform: "linux",
                arch: process.arch,
                engineVersion: "1.0.3-t20",
                files,
            }),
        );
        return {
            root,
            distribution: await loadRuntimeDistribution(root),
            cleanup: () => rm(root, { recursive: true, force: true }),
            manifest: async () =>
                JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8")),
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
