import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { loadRuntimeDistribution } from "../src/distribution.ts";

/** 安装路径测试只创建几字节的合成发行文件来检查宿主解析边界，既不伪造 Node 或浏览器验收，也不下载实际载荷；真实发动执行前仍须独立校验角色版本与完整引擎库存。 */
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "veriq distribution 中文 "));
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
        "npm/bin/npm-cli.js",
        "node_modules/tsx/dist/loader.mjs",
        "browser/chrome-linux64/chrome",
        "engines/1.0.3-t20/inventory.json",
    ];
    names.push("execution/archive.mjs");
    const files = [];
    for (const path of names) {
        const value = Buffer.from(path);
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), value);
        files.push({
            path,
            sizeBytes: value.length,
            sha256: createHash("sha256").update(value).digest("hex"),
        });
    }
    const manifest = {
        schemaVersion: 1,
        productVersion: "1.0.0-dev.t20",
        nodeVersion: "24.22.1",
        platform: "linux",
        arch: "x64",
        engineVersion: "1.0.3-t20",
        files,
    };
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
    return { root, manifest };
}

/** 真实文件库存必须先验证再派生执行路径，组件版本不能偷换成产品版本；缺失或被修改的角色文件应立即拒绝，不能等到设备已注册后才发现实际执行程序不可用。 */
test("distribution resolves physical role paths and refuses changed members", async () => {
    const { root } = await fixture();
    try {
        const value = await loadRuntimeDistribution(root);
        assert.equal(value.productVersion, "1.0.0-dev.t20");
        assert.equal(value.engineVersion, "1.0.3-t20");
        assert.equal(value.execution.runnerExecutable, join(root, "roles/runner/veriq_runner"));
        assert.equal(value.execution.npmCli, join(root, "npm/bin/npm-cli.js"));
        await writeFile(value.execution.runnerExecutable, "changed");
        await assert.rejects(loadRuntimeDistribution(root), /RUNTIME_FILE_MISMATCH/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 文件哈希列表必须构成完整物理闭包，额外 JavaScript 即使没有被清单引用也可能改变 Node 的模块解析结果；该检查禁止攻击者在已核验目录内插入未登记的依赖入口后继续使用原发行身份。 */
test("distribution refuses an unlisted executable dependency", async () => {
    const { root } = await fixture();
    try {
        await writeFile(join(root, "entry/unlisted.js"), "throw new Error('unexpected');");
        await assert.rejects(loadRuntimeDistribution(root), /RUNTIME_UNLISTED_MEMBER/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 清单相对路径和中间目录都属于安装信任边界，外部文件即使内容哈希正确也不可通过符号链接进入发行；该断言专门覆盖只校验字节却没有验证物理依赖闭包的错误实现。 */
test("distribution rejects linked members and unsafe manifest paths", async () => {
    const { root, manifest } = await fixture();
    try {
        const path = join(root, "roles/runner/veriq_runner");
        const bytes = await readFile(path);
        await writeFile(join(root, "outside"), bytes);
        await rm(path);
        await symlink(join(root, "outside"), path);
        await assert.rejects(loadRuntimeDistribution(root), /RUNTIME_LINK_FORBIDDEN/);
        manifest.files[0]!.path = "../escape";
        await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
        await assert.rejects(loadRuntimeDistribution(root), /RUNTIME_MANIFEST_INVALID/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
