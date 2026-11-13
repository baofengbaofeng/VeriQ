/** 私有配置测试只操作本次创建的临时目录与合成描述文件，通过真实 Windows ACL 和目录联接建立风险前提；公开配置 API 必须拒绝非私有文件及祖先重解析路径，失败不能覆盖原字节，也不能以 chmod 成功冒充隔离。 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsNative } from "../../src/native/windows.ts";
import { privateDirectory, readPrivate, updatePrivate } from "../../src/offline/config.ts";

assert.equal(process.platform, "win32", "Private configuration acceptance requires Windows");
const native = windowsNative();
const name = "desktop-agent.json";
const original = '{"generation":1,"label":"original 中文😀"}';

/** 每个用例独占一个临时根，任何行为断言失败都保留合成文件以供目标任务诊断；只有全部断言通过才递归删除该自有根，不接触用户配置、真实凭证或本次目录之外的联接目标。 */
async function withFixture(context: TestContext, run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq private 中文 "));
    try {
        await run(root);
        await rm(root, { recursive: true, force: true });
    } catch (error) {
        context.diagnostic(`Private configuration evidence retained: ${root}`);
        throw error;
    }
}

/** 拒绝操作与原始字节保留是两个独立义务，前者失败后仍读取自有合成目标核对后者；聚合全部实际错误而不让一次缺失拒绝掩盖随后发生的覆盖，也不把测试清理当成恢复产品数据。 */
async function rejectedWithoutChange(path: string, operation: () => Promise<unknown>) {
    const before = await readFile(path);
    const failures: unknown[] = [];
    try {
        await assert.rejects(
            operation,
            /UNSAFE_CONFIGURATION|NATIVE_ACL_NOT_PRIVATE|NATIVE_REPARSE_REJECTED/,
        );
    } catch (error) {
        failures.push(error);
    }
    try {
        assert.deepEqual(
            await readFile(path),
            before,
            "Rejected access must retain original bytes",
        );
    } catch (error) {
        failures.push(error);
    }
    if (failures.length)
        throw new AggregateError(failures, "Private configuration rejection failed");
}

/** 缺失的嵌套配置目录必须在创建时就具有当前账户保护 DACL，不能先建公共目录再把 Windows 忽略的 POSIX 模式视为私有；父级临时目录属于测试场地，不要求或改写它的系统继承权限。 */
test("Windows privateDirectory creates protected nested configuration directories", async (context) => {
    await withFixture(context, async (root) => {
        const parent = join(root, "nested 中文");
        const profile = join(parent, "profile with spaces");
        await privateDirectory(profile);
        native.privatePath(parent, false);
        native.privatePath(profile, false);
        assert((await lstat(profile)).isDirectory());
    });
});

/** 新描述文件和后续替换都必须保留真实私有 ACL，并向更新函数交付上一代完整数据；回调失败与超限内容不得改变已提交文件，最终目录只含正式配置，正常返回不等同于已完成断电恢复证明。 */
test("Windows updatePrivate publishes private descriptors and preserves committed generations", async (context) => {
    await withFixture(context, async (root) => {
        const profile = join(root, "profile");
        native.privatePath(profile, true);
        const first = { generation: 1, socket: "synthetic endpoint", nonce: "a".repeat(64) };
        await updatePrivate<typeof first>(profile, name, (old) => {
            assert.equal(old, undefined);
            return first;
        });
        native.privatePath(join(profile, name), false);
        assert.deepEqual(await readPrivate(profile, name), first);
        const second = { ...first, generation: 2, socket: "updated 中文😀" };
        await updatePrivate<typeof first>(profile, name, (old) => {
            assert.deepEqual(old, first);
            return second;
        });
        native.privatePath(join(profile, name), false);
        assert.deepEqual(await readPrivate(profile, name), second);
        const committed = await readFile(join(profile, name));
        await assert.rejects(
            updatePrivate(profile, name, () => {
                throw new Error("SYNTHETIC_UPDATE_REJECTED");
            }),
            /SYNTHETIC_UPDATE_REJECTED/,
        );
        await assert.rejects(
            updatePrivate(profile, name, () => ({ oversized: "x".repeat(1024 * 1024) })),
            /CONFIGURATION_LIMIT/,
        );
        assert.deepEqual(await readFile(join(profile, name)), committed);
        assert.deepEqual(await readdir(profile), [name]);
    });
});

/** 公共文件前提由 Windows 自带 icacls 给自有合成文件显式增加 Everyone 读取权限建立，随后真实原生 ACL 检查必须确认它不再私有；读取和更新分别执行，不能让单个拒绝掩盖另一路泄露或覆盖。 */
for (const operation of ["read", "update"] as const) {
    test(`Windows private configuration rejects ${operation} of a public existing file`, async (context) => {
        await withFixture(context, async (root) => {
            const profile = join(root, "profile");
            native.privatePath(profile, true);
            const path = join(profile, name);
            native.writePrivate(path, original);
            await promisify(execFile)(
                join(process.env.SystemRoot!, "System32", "icacls.exe"),
                [path, "/grant", "*S-1-1-0:(R)"],
                { windowsHide: true, timeout: 5000, maxBuffer: 65536 },
            );
            assert.throws(() => native.privatePath(path, false), /NATIVE_ACL_NOT_PRIVATE/);
            context.diagnostic("Owned synthetic file has an actual nonprivate World-read ACL");
            await rejectedWithoutChange(path, () =>
                operation === "read"
                    ? readPrivate(profile, name)
                    : updatePrivate(profile, name, () => ({ generation: 2 })),
            );
        });
    });
}

/** 联接位于配置目录的祖先而不是最终文件，最终目录与文件本身均为真实私有对象；公开 API 必须拒绝这条路径且保留真实目标字节，不能只检查末级符号链接或把解析后的别名当成原始授权路径。 */
for (const operation of ["directory", "read", "update"] as const) {
    test(`Windows private configuration rejects ${operation} through a parent junction`, async (context) => {
        await withFixture(context, async (root) => {
            const actual = join(root, "actual");
            native.privatePath(actual, true);
            const profile = join(actual, "profile");
            native.privatePath(profile, true);
            const path = join(profile, name);
            native.writePrivate(path, original);
            const alias = join(root, "parent junction");
            await symlink(actual, alias, "junction");
            const redirected = join(alias, "profile");
            assert((await lstat(alias)).isSymbolicLink());
            assert.equal((await lstat(redirected)).isSymbolicLink(), false);
            assert.equal(await realpath(redirected), await realpath(profile));
            native.privatePath(path, false);
            context.diagnostic("Actual parent junction resolves to the owned private fixture");
            await rejectedWithoutChange(path, () => {
                if (operation === "directory") return privateDirectory(redirected);
                if (operation === "read") return readPrivate(redirected, name);
                return updatePrivate(redirected, name, () => ({ generation: 2 }));
            });
        });
    });
}
