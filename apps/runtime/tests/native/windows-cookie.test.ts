/** Windows Cookie 退役测试只访问本次临时根下合成的固定分区文件，并通过正式原生同句柄操作验证超一兆元数据删除和路径拒绝；它不读取用户浏览器数据、不放宽当前 SID 拥有者规则，也不代表 Electron 的 DPAPI 或安装验收。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsNative } from "../../src/native/windows.ts";
import { prepareCookieStorage } from "../../../desktop/src/main/cookie-migration.ts";

assert.equal(process.platform, "win32");

test("Windows Cookie retirement checks fixed metadata without expanding private reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq cookie 中文 "));
    const native = windowsNative();
    try {
        const directory = join(root, "Partitions/veriq-host/Network");
        native.privatePath(directory, true);
        const path = join(directory, "Cookies");
        const file = await open(path, "wx");
        try {
            await file.truncate(2 * 1024 * 1024 + 1);
        } finally {
            await file.close();
        }
        assert.equal(native.privateCookieFile(path, false), true);
        assert.throws(() => native.readPrivateFile(path, 1024 * 1024), /LIMIT/);
        assert.throws(
            () => native.privateCookieFile(join(directory, "unrelated"), true),
            /COOKIE_MEMBER_INVALID/,
        );
        assert.throws(
            () => native.privateCookieFile(join(root, "Cookies"), true),
            /COOKIE_MEMBER_INVALID/,
        );
        assert.equal(native.privateCookieFile(path, true), true);
        assert.equal(native.privateCookieFile(path, false), false);
        assert.equal(native.privateCookieFile(path, true), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Windows Cookie migration preserves declined state and retires only approved members", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq cookie migrate 中文 "));
    const native = windowsNative();
    try {
        native.privatePath(root, true);
        const partition = join(root, "electron/Partitions/veriq-host");
        native.privatePath(join(partition, "Network"), true);
        for (const directory of [partition, join(partition, "Network")]) {
            for (const member of [
                "Cookies",
                "Cookies-wal",
                "Cookies-shm",
                "Cookies-journal",
                "unrelated",
            ])
                await writeFile(join(directory, member), "synthetic cookie fixture");
        }
        await assert.rejects(
            prepareCookieStorage(root, join(root, "electron"), async () => false),
            /COOKIE_MIGRATION_REQUIRED/,
        );
        assert.equal(
            await readFile(join(partition, "Cookies"), "utf8"),
            "synthetic cookie fixture",
        );
        await prepareCookieStorage(root, join(root, "electron"), async () => true);
        for (const directory of [partition, join(partition, "Network")]) {
            for (const member of ["Cookies", "Cookies-wal", "Cookies-shm", "Cookies-journal"])
                assert.equal(native.privateCookieFile(join(directory, member), false), false);
            assert.equal(
                await readFile(join(directory, "unrelated"), "utf8"),
                "synthetic cookie fixture",
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
