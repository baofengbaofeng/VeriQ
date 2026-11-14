/** 专用账户夹具必须从自有目录装载独立依赖闭包，不能依赖 CI 原账户主目录可遍历；此模块只复制 pnpm 已解析的包树并核验相对链接与实际字节，权限调整仅作用于新副本，不解析版本、不安装依赖，也不修改共享缓存。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    cp,
    lstat,
    readdir,
    readlink,
    realpath,
    statfs,
    mkdtemp,
    readFile,
    writeFile,
    rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname, basename } from "node:path";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contained = (root, path) => {
    const part = relative(root, path);
    return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
};
async function inspect(root, normalize = false) {
    const entries = [];
    let bytes = 0;
    async function visit(directory) {
        const current = await lstat(directory);
        assert(current.isDirectory() && !current.isSymbolicLink(), "FIXTURE_DIRECTORY_INVALID");
        if (normalize) await chmod(directory, 0o755);
        for (const name of (await readdir(directory)).sort()) {
            const path = join(directory, name),
                entry = await lstat(path),
                member = relative(root, path);
            assert(entries.length < 50000, "FIXTURE_ENTRY_LIMIT");
            if (entry.isSymbolicLink()) {
                const link = await readlink(path);
                assert(
                    !isAbsolute(link) && contained(root, await realpath(path)),
                    "FIXTURE_LINK_OUTSIDE",
                );
                entries.push({ path: member, link });
            } else if (entry.isDirectory()) {
                entries.push({ path: member, directory: true });
                await visit(path);
            } else {
                assert(entry.isFile(), "FIXTURE_FILE_TYPE_INVALID");
                bytes += entry.size;
                assert(bytes <= 1024 * 1024 * 1024, "FIXTURE_SIZE_LIMIT");
                const hash = createHash("sha256");
                for await (const chunk of createReadStream(path)) hash.update(chunk);
                const executable = !!(entry.mode & 0o111);
                entries.push({
                    path: member,
                    sizeBytes: entry.size,
                    sha256: hash.digest("hex"),
                    executable,
                });
                if (normalize) await chmod(path, executable ? 0o755 : 0o644);
            }
        }
    }
    await visit(root);
    return { entries, bytes };
}

/** 输入必须是 pnpm 离线导出的完整目录，所有包链接均在该目录内；复制前后逐文件哈希相等才返回可启动副本，并记录实际容量及库存摘要，原目录的权限、硬链接与内容都不能被副本的权限规范化影响。 */
export async function stageOwnedFixture(source, target) {
    assert(isAbsolute(source) && isAbsolute(target), "FIXTURE_ABSOLUTE_PATH_REQUIRED");
    assert.equal(await realpath(source), resolve(source), "FIXTURE_SOURCE_LINKED");
    assert(!contained(source, target) && !contained(target, source), "FIXTURE_COPY_OVERLAP");
    await assert.rejects(lstat(target), { code: "ENOENT" });
    const before = await inspect(source);
    const space = await statfs(dirname(target), { bigint: true });
    assert(
        space.bavail * space.bsize >= BigInt(before.bytes) + 8n * 1024n * 1024n,
        "FIXTURE_COPY_BUDGET",
    );
    await cp(source, target, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
    });
    const after = await inspect(target, true);
    assert.deepEqual(after, before, "FIXTURE_COPY_CHANGED");
    assert.deepEqual(await inspect(source), before, "FIXTURE_SOURCE_CHANGED");
    return {
        files: before.entries.filter((entry) => entry.sha256).length,
        links: before.entries.filter((entry) => entry.link).length,
        bytes: before.bytes,
        availableBytes: String(space.bavail * space.bsize),
        inventorySha256: digest(JSON.stringify(before.entries)),
        inventory: before.entries,
    };
}

/** pnpm 的部署命令负责从冻结安装树形成完整依赖闭包，本脚本只提供独占临时目录与可核验的清理意图；部署始终在原 CI 账户下离线禁脚本执行，之后 root 夹具复制到自有目录，避免 root 安装依赖或改变原账户可遍历范围。 */
async function prepare(mode, evidence, pnpm) {
    assert.equal(process.platform, "linux");
    assert(process.getuid() > 0 && isAbsolute(evidence));
    const temporary = await realpath(process.env.RUNNER_TEMP);
    const descriptor = join(evidence, "restricted-file-deployment.json");
    const save = (name, data) =>
        writeFile(join(evidence, name), JSON.stringify(data, null, 2) + "\n");
    if (mode === "prepare") {
        assert(isAbsolute(pnpm));
        await assert.rejects(lstat(descriptor), { code: "ENOENT" });
        const root = await mkdtemp(join(temporary, "veriq-restricted-deploy-"));
        const state = {
            root,
            nonce: randomUUID(),
            uid: process.getuid(),
            source: join(root, "runtime"),
        };
        await writeFile(join(root, ".owned"), state.nonce, { mode: 0o600, flag: "wx" });
        await save("restricted-file-deployment.json", state);
        const available = await statfs(root, { bigint: true });
        const availableBytes = available.bavail * available.bsize;
        assert(availableBytes >= 2n * 1024n * 1024n * 1024n, "FIXTURE_DEPLOY_BUDGET");
        const repository = resolve(import.meta.dirname, "../../..");
        const lock = join(repository, "pnpm-lock.yaml");
        const before = digest(await readFile(lock));
        const version = await promisify(execFile)(process.execPath, [pnpm, "--version"], {
            cwd: repository,
            timeout: 10000,
        });
        assert.equal(version.stdout.trim(), "11.25.0");
        const args = [
            pnpm,
            "--filter",
            "@veriq/runtime",
            "deploy",
            "--legacy",
            "--prod",
            "--offline",
            "--ignore-scripts",
            "--package-import-method=copy",
            "--hoist=false",
            state.source,
        ];
        let result;
        try {
            result = await promisify(execFile)(process.execPath, args, {
                cwd: repository,
                timeout: 120000,
                maxBuffer: 1024 * 1024,
            });
        } catch (error) {
            await save("restricted-file-deployment-failure.json", {
                code: error.code,
                stdout: error.stdout,
                stderr: error.stderr,
            });
            throw error;
        }
        assert.equal(digest(await readFile(lock)), before, "FIXTURE_LOCK_CHANGED");
        await save("restricted-file-deployment-result.json", {
            availableBytes: String(availableBytes),
            requiredAvailableBytes: String(2n * 1024n * 1024n * 1024n),
            pnpmVersion: version.stdout.trim(),
            lockSha256: before,
            stdout: result.stdout,
            stderr: result.stderr,
            source: state.source,
        });
    } else {
        assert.equal(mode, "cleanup");
        const errors = [];
        let removed = false;
        let state;
        try {
            state = JSON.parse(await readFile(descriptor, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await save("restricted-file-deployment-cleanup.json", {
                started: false,
                removed: false,
                errors: [],
            });
            return;
        }
        try {
            assert.equal(dirname(state.root), temporary);
            assert(/^veriq-restricted-deploy-[A-Za-z0-9]+$/.test(basename(state.root)));
            assert.equal(state.uid, process.getuid());
            const root = await lstat(state.root);
            assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === state.uid);
            assert.equal(await readFile(join(state.root, ".owned"), "utf8"), state.nonce);
            await rm(state.root, { recursive: true });
            await assert.rejects(lstat(state.root), { code: "ENOENT" });
            removed = true;
        } catch (error) {
            errors.push(error.message);
        }
        await save("restricted-file-deployment-cleanup.json", { started: true, removed, errors });
        assert.deepEqual(errors, []);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await prepare(...process.argv.slice(2));
}
