/** 夹具搬运测试使用小型真实 ESM 包树验证可搬迁性、复制后的权限隔离与链接边界，不创建账户或挂载；源目录删除后仍须从自有副本解析依赖，因此通过只说明装载闭包成立，不能代替目标专用 UID 的凭据与卷验收。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// @ts-expect-error 夹具脚本只由 Node 执行，测试直接观察复制、权限与可搬迁装载的实际文件行为；该脚本不作为应用 API 导出，因此不为测试另造一套与实际脚本分离的生产类型接口。
import { stageOwnedFixture } from "../scripts/restricted-fixture-stage.mjs";

test("owned fixture copy resolves relocated package links without source or writable code", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-fixture-stage-"));
    const source = join(root, "source"),
        target = join(root, "target");
    try {
        await mkdir(join(source, "node_modules/.pnpm/owned/node_modules/owned"), {
            recursive: true,
        });
        await writeFile(join(source, "package.json"), '{"type":"module"}', { mode: 0o600 });
        await writeFile(
            join(source, "entry.mjs"),
            'import value from "owned"; console.log(value);',
            { mode: 0o600 },
        );
        await writeFile(
            join(source, "node_modules/.pnpm/owned/node_modules/owned/package.json"),
            '{"type":"module","exports":"./index.js"}',
        );
        await writeFile(
            join(source, "node_modules/.pnpm/owned/node_modules/owned/index.js"),
            'export default "owned-relocated";',
        );
        await symlink(".pnpm/owned/node_modules/owned", join(source, "node_modules/owned"));
        const before = await lstat(join(source, "entry.mjs"));
        const result = await stageOwnedFixture(source, target);
        assert.equal(result.files, 4);
        assert.equal(result.links, 1);
        assert(result.bytes > 0);
        assert.match(result.inventorySha256, /^[a-f0-9]{64}$/);
        const after = await lstat(join(source, "entry.mjs"));
        assert.equal(after.mode, before.mode);
        assert.equal(after.ino, before.ino);
        assert.notEqual((await lstat(join(target, "entry.mjs"))).ino, before.ino);
        assert.equal((await lstat(join(target, "entry.mjs"))).mode & 0o777, 0o644);
        assert.equal((await lstat(target)).mode & 0o777, 0o755);
        assert.equal(
            await readFile(join(source, "entry.mjs"), "utf8"),
            await readFile(join(target, "entry.mjs"), "utf8"),
        );
        await assert.rejects(stageOwnedFixture(source, target));
        await rm(source, { recursive: true });
        const child = await promisify(execFile)(process.execPath, [join(target, "entry.mjs")], {
            cwd: target,
            timeout: 5000,
        });
        assert.equal(child.stdout, "owned-relocated\n");
        assert.equal(child.stderr, "");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("owned fixture copy rejects external package links before creating destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-fixture-stage-denied-"));
    const source = join(root, "source"),
        target = join(root, "target");
    try {
        await mkdir(source);
        await writeFile(join(root, "outside"), "not owned by closure");
        await symlink("../outside", join(source, "external"));
        await assert.rejects(stageOwnedFixture(source, target), /FIXTURE_LINK_OUTSIDE/);
        await assert.rejects(lstat(target), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
