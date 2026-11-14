/** Windows Cookie 退役测试只访问本次临时根下合成的固定分区文件，并通过正式原生同句柄操作验证超一兆元数据删除和路径拒绝；它不读取用户浏览器数据、不放宽当前 SID 拥有者规则，也不代表 Electron 的 DPAPI 或安装验收。 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsNative } from "../../src/native/windows.ts";
import { prepareCookieStorage } from "../../../desktop/src/main/cookie-migration.ts";

assert.equal(process.platform, "win32");

/** 失败诊断仅查询本次合成根及固定 Cookie 成员的实际 owner 和 ACE，不改变账户、令牌、DACL 或夹具创建方式；输出使用有限 UTF8 只读命令，观察本身失败也不能覆盖原断言错误，更不能把未取得的 ACL 推测成管理员政策结论。 */
async function observeAcl(context: TestContext, paths: string[]) {
    try {
        const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ownedPaths = ConvertFrom-Json -InputObject $env:VERIQ_COOKIE_OWNED_PATHS
if ($ownedPaths -isnot [System.Array] -or $ownedPaths.Count -ne 3) { throw 'OWNED_ACL_PATH_ARRAY_INVALID' }
$records = @(for ($index = 0; $index -lt $ownedPaths.Count; $index++) {
    $path = $ownedPaths[$index]
    if ($path -isnot [string] -or [string]::IsNullOrWhiteSpace($path)) { throw 'OWNED_ACL_PATH_TYPE_INVALID' }
    if (![System.IO.File]::Exists($path) -and ![System.IO.Directory]::Exists($path)) {
        @{ path=$path; missing=$true }
        continue
    }
    $acl = if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
    $rules = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString() }
    })
    @{ path=$path; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; rules=$rules }
})
if ($records.Count -ne 3) { throw 'OWNED_ACL_RECORD_COUNT_INVALID' }
ConvertTo-Json -InputObject $records -Depth 5 -Compress
`;
        const executable = join(
            process.env.SystemRoot!,
            "System32/WindowsPowerShell/v1.0/powershell.exe",
        );
        const result = await promisify(execFile)(
            executable,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(script, "utf16le").toString("base64"),
            ],
            {
                timeout: 10000,
                maxBuffer: 16384,
                windowsHide: true,
                env: { ...process.env, VERIQ_COOKIE_OWNED_PATHS: JSON.stringify(paths) },
            },
        );
        context.diagnostic(
            "Owned Cookie ACL command result: " +
                JSON.stringify({
                    executable,
                    sid: windowsNative().sid,
                    exitCode: 0,
                    stdout: result.stdout,
                    stderr: result.stderr,
                }),
        );
        context.diagnostic(
            "Owned Cookie ACL observation: " +
                JSON.stringify({
                    sid: windowsNative().sid,
                    records: JSON.parse(result.stdout),
                    stderrEmpty: result.stderr.length === 0,
                }),
        );
        assert.equal(result.stderr, "");
    } catch (error) {
        const observed = error as {
            name?: string;
            code?: string | number;
            signal?: string;
            killed?: boolean;
            stdout?: string;
            stderr?: string;
        };
        context.diagnostic(
            "Owned Cookie ACL observation failed: " +
                JSON.stringify({
                    name: observed?.name ?? "UNKNOWN_ERROR",
                    code: observed?.code,
                    signal: observed?.signal,
                    killed: observed?.killed,
                    stdout:
                        typeof observed?.stdout === "string"
                            ? observed.stdout.slice(0, 16384)
                            : undefined,
                    stderr:
                        typeof observed?.stderr === "string"
                            ? observed.stderr.slice(0, 16384)
                            : undefined,
                }),
        );
    }
}

test("Windows Cookie retirement checks fixed metadata without expanding private reads", async (context) => {
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
    } catch (error) {
        await observeAcl(context, [
            root,
            join(root, "Partitions/veriq-host/Network"),
            join(root, "Partitions/veriq-host/Network/Cookies"),
        ]);
        throw error;
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Windows Cookie migration preserves declined state and retires only approved members", async (context) => {
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
    } catch (error) {
        await observeAcl(context, [
            root,
            join(root, "electron/Partitions/veriq-host"),
            join(root, "electron/Partitions/veriq-host/Cookies"),
        ]);
        throw error;
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
