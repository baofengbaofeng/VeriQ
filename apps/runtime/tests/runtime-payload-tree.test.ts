import { createServer } from "node:net";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    verifyRuntimePayloadInputs as verify,
    RuntimePayloadError,
} from "../scripts/runtime-payload-inputs.ts";
import { fixture } from "./fixtures/runtime-payload.ts";
/** 树拒绝测试核对稳定产品异常而非字符串错误，所有变更发生于已封存声明之后的真实目录；因此遗漏完整枚举、权限核验或链接身份检查都会让对应反例被错误接受。 */
const failure = (e: unknown) => e instanceof RuntimePayloadError;
for (const [name, mutate] of Object.entries({
    missing: async (root: string) => rm(join(root, "trees/entries/agent.js")),
    extra: async (root: string) => writeFile(join(root, "trees/entries/extra.js"), "extra"),
    emptyDirectory: async (root: string) => mkdir(join(root, "trees/entries/empty")),
    mode: async (root: string) => chmod(join(root, "trees/entries/agent.js"), 0o666),
    hash: async (root: string) => writeFile(join(root, "trees/entries/agent.js"), "mutated"),
    symlink: async (root: string) => {
        await rm(join(root, "trees/entries/agent.js"));
        await symlink("cli.js", join(root, "trees/entries/agent.js"));
    },
    hardlink: async (root: string) => {
        await rm(join(root, "trees/entries/agent.js"));
        await link(join(root, "trees/entries/cli.js"), join(root, "trees/entries/agent.js"));
    },
}))
    test(`real tree rejects ${name}`, async () =>
        fixture(async (f) => {
            const b = await f.save();
            await mutate(f.root);
            await assert.rejects(verify(b, f.expected, { inputRoot: f.root }), failure);
        }));
test("abort before admission stops read-only verification", async () =>
    fixture(async (f) => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root, signal: controller.signal }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_CANCELLED",
        );
    }));
test("recipe rejects overlapping trees and evidence inside a tree", async () =>
    fixture(async (f) => {
        f.recipe.execution.root = f.recipe.entries.root;
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: f.root }), failure);
    }));
test("inventory rejects case collisions missing parents and unsafe member paths", async () => {
    for (const path of ["Agent.js", "missing/child.js", "../escape.js", "bad.asar/file"]) {
        await fixture(async (f) => {
            f.inventories.entries.files.push({ ...f.inventories.entries.files[0]!, path });
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                failure,
            );
        });
    }
});

/** 根目录的每级祖先必须真实可见，不能靠 resolve 把 symlink 或 ASAR 组件隐藏；临时根中文空格已由成功样本覆盖，这里只加入由测试拥有的别名并保证最终删除自身链接。 */
test("symlink ancestor and ASAR root are rejected", async () =>
    fixture(async (f) => {
        const alias = join(f.root, "alias");
        await symlink("trees", alias);
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: join(alias, "entries") }),
            failure,
        );
        const asar = join(f.root, "payload.asar");
        await mkdir(asar);
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: asar }), failure);
    }));

/** 本地 Unix-domain socket 仅用于生成一个不属于普通文件或目录的 inode，没有 TCP、远程地址或任何连接流量；产品核验必须在打开前拒绝该 special，finally 只关闭测试自己的监听器。 */
test("special Unix socket inode is rejected without opening it", async () =>
    fixture(async (f) => {
        const server = createServer(),
            path = join(f.root, "trees/entries/special.sock");
        await new Promise<void>((done, reject) => {
            server.once("error", reject);
            server.listen(path, done);
        });
        try {
            const template = f.inventories.entries.files[0]!;
            f.inventories.entries.files.push({ ...template, path: "special.sock" });
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                failure,
            );
        } finally {
            await new Promise<void>((done, reject) =>
                server.close((error) => (error ? reject(error) : done())),
            );
        }
    }));

/** 来源在 held FD 读取完成后被真实改写，即使某次 lstat 返回旧快照，收尾观察也必须发现变化；测试只拦截本机 fs 边界来安排确定性竞争，绝不在产品加入重试或测试专用注入钩子。 */
test("source mutation after held read rejects instead of retrying", async () =>
    fixture(async (f) => {
        const input = await f.save(),
            path = join(f.root, "evidence/source-binding.json"),
            original = fs.lstat;
        let calls = 0;
        fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
            const result = await original(...args);
            if (String(args[0]) === path && ++calls === 2)
                await writeFile(path, "changed after read\n");
            return result;
        }) as typeof fs.lstat;
        syncBuiltinESMExports();
        try {
            await assert.rejects(
                verify(input, f.expected, { inputRoot: f.root }),
                (e: unknown) =>
                    e instanceof RuntimePayloadError && e.code === "PAYLOAD_SOURCE_CHANGED",
            );
        } finally {
            fs.lstat = original;
            syncBuiltinESMExports();
        }
    }));

test("reference declarations exceed budget before allocating content", async () =>
    fixture(async (f) => {
        f.recipe.node.file.sizeBytes = 2 ** 31 + 1;
        const b = f.seal();
        await assert.rejects(
            verify(b, f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
        );
    }));

/** 五棵树共用四万成员上限，不能等扫描第二棵树时才发现总声明超额；测试只写两个几百 KiB 的库存文档，不创建声明的四万个目录，要求先按完整声明拒绝而不是误报物理遗漏。 */
test("combined five-tree entry declarations reject before body traversal", async () =>
    fixture(async (f) => {
        f.inventories.entries.directories = Array.from({ length: 20001 }, (_, i) => `a${i}`);
        f.inventories.execution.directories = Array.from({ length: 20001 }, (_, i) => `b${i}`);
        const input = f.seal();
        for (const kind of ["entries", "execution"] as const)
            for (const ref of [f.recipe[kind].inventory, f.recipe[kind].buildReceipt])
                await writeFile(join(f.root, ref.path), f.data.get(ref.path)!);
        await assert.rejects(
            verify(input, f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
        );
    }));
