/** Cookie 迁移测试仅在自有临时档案中创建合成数据库与日志文件，检查确认、恢复和固定成员退役行为；既不读取用户登录 Cookie，也不把文件消失当作物理擦除或 Chromium 实际加密证明。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCookieStorage } from "../src/main/cookie-migration.ts";

async function fixture(run: (profile: string, partition: string) => Promise<void>) {
    const profile = await mkdtemp(join(tmpdir(), "veriq-cookie-test-"));
    const partition = join(profile, "electron/Partitions/veriq-host");
    await mkdir(partition, { recursive: true, mode: 0o700 });
    await mkdir(join(partition, "Network"), { mode: 0o700 });
    try {
        await run(profile, partition);
    } finally {
        await chmod(join(partition, "Network"), 0o700);
        await rm(profile, { recursive: true, force: true });
    }
}
const cookieNames = ["Cookies", "Cookies-wal", "Cookies-shm", "Cookies-journal"];

test("new Cookie profile activates without asking to delete nonexistent state", async () =>
    fixture(async (profile) => {
        await prepareCookieStorage(profile, join(profile, "electron"), async () => {
            throw new Error("UNEXPECTED_CONFIRMATION");
        });
        assert.equal(
            JSON.parse(await readFile(join(profile, "cookie-protection.json"), "utf8")).state,
            "active",
        );
    }));

test("declining legacy Cookie migration preserves original database and journal bytes", async () =>
    fixture(async (profile, partition) => {
        await writeFile(join(partition, "Cookies"), "synthetic legacy", { mode: 0o600 });
        await assert.rejects(
            prepareCookieStorage(profile, join(profile, "electron"), async () => false),
            /COOKIE_MIGRATION_REQUIRED/,
        );
        assert.equal(await readFile(join(partition, "Cookies"), "utf8"), "synthetic legacy");
        await assert.rejects(readFile(join(profile, "cookie-protection.json")), { code: "ENOENT" });
    }));

test("explicit Cookie reset retires only fixed database members in both known layouts", async () =>
    fixture(async (profile, partition) => {
        for (const directory of [partition, join(partition, "Network")]) {
            for (const name of cookieNames)
                await writeFile(join(directory, name), "synthetic legacy", { mode: 0o600 });
            await writeFile(join(directory, "unrelated"), "preserved", { mode: 0o600 });
        }
        let confirmations = 0;
        await prepareCookieStorage(profile, join(profile, "electron"), async () => {
            confirmations++;
            return true;
        });
        assert.equal(confirmations, 1);
        for (const directory of [partition, join(partition, "Network")]) {
            for (const name of cookieNames)
                await assert.rejects(readFile(join(directory, name)), { code: "ENOENT" });
            assert.equal(await readFile(join(directory, "unrelated"), "utf8"), "preserved");
        }
        await prepareCookieStorage(profile, join(profile, "electron"), async () => {
            throw new Error("UNEXPECTED_REPEAT");
        });
    }));

test("interrupted approved retirement keeps pending state and resumes before any Cookie Session", async () =>
    fixture(async (profile, partition) => {
        await writeFile(join(partition, "Cookies"), "first", { mode: 0o600 });
        await writeFile(join(partition, "Network/Cookies"), "second", { mode: 0o600 });
        await chmod(join(partition, "Network"), 0o500);
        await assert.rejects(
            prepareCookieStorage(profile, join(profile, "electron"), async () => true),
        );
        assert.equal(
            JSON.parse(await readFile(join(profile, "cookie-protection.json"), "utf8")).state,
            "resetting",
        );
        assert.equal(await readFile(join(partition, "Network/Cookies"), "utf8"), "second");
        await chmod(join(partition, "Network"), 0o700);
        await prepareCookieStorage(profile, join(profile, "electron"), async () => {
            throw new Error("APPROVED_RESET_REPROMPTED");
        });
        await assert.rejects(readFile(join(partition, "Network/Cookies")), { code: "ENOENT" });
    }));

/** 数据库尺寸与文件类型检查均通过真实临时成员完成，稀疏文件只占少量测试磁盘；超过通用配置额度的 Cookie 可退役，但链接、公开文件和超出固定 Cookie 元数据上限都必须保留原状且不得请求用户确认删除。 */
test("Cookie retirement is metadata-only for large files and refuses unsafe members", async () =>
    fixture(async (profile, partition) => {
        const { open, symlink, lstat } = await import("node:fs/promises");
        const path = join(partition, "Cookies");
        const file = await open(path, "wx", 0o600);
        try {
            await file.truncate(2 * 1024 * 1024 + 1);
        } finally {
            await file.close();
        }
        await prepareCookieStorage(profile, join(profile, "electron"), async () => true);
        await assert.rejects(lstat(path), { code: "ENOENT" });
        await rm(join(profile, "cookie-protection.json"));
        const other = join(profile, "unrelated");
        await writeFile(other, "preserved", { mode: 0o600 });
        await symlink(other, path);
        let asked = false;
        const confirm = async () => {
            asked = true;
            return true;
        };
        await assert.rejects(prepareCookieStorage(profile, join(profile, "electron"), confirm));
        assert.equal(asked, false);
        assert.equal(await readFile(other, "utf8"), "preserved");
        await rm(path);
        await writeFile(path, "public", { mode: 0o644 });
        await chmod(path, 0o644);
        await assert.rejects(
            prepareCookieStorage(profile, join(profile, "electron"), confirm),
            /COOKIE_STORAGE_NOT_PRIVATE/,
        );
        assert.equal(asked, false);
        await chmod(path, 0o600);
        const oversized = await open(path, "r+");
        try {
            await oversized.truncate(64 * 1024 * 1024 + 1);
        } finally {
            await oversized.close();
        }
        await assert.rejects(
            prepareCookieStorage(profile, join(profile, "electron"), confirm),
            /COOKIE_STORAGE_NOT_PRIVATE/,
        );
        assert.equal(asked, false);
        assert.equal((await lstat(path)).size, 64 * 1024 * 1024 + 1);
    }));
