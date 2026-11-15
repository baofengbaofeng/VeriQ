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
import { EvidenceBudget, InputReader, limits } from "../scripts/runtime-payload-tree.ts";
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

/** 类别限额必须在所有树第一次读取正文之前准入，而非等待包或引擎收尾重新读取；这里只放大声明且保留真实小文件，PAYLOAD_LIMIT 与物理长度不符的区分能够直接观察拒绝顺序。 */
for (const [kind, path, limit] of [
    ["dependencies", "node_modules/tsx/package.json", 1024 ** 2],
    ["engine", "package.json", 1024 ** 2],
    ["engine", "package-lock.json", 4 * 1024 ** 2],
    ["engine", "inventory.json", 4 * 1024 ** 2],
    ["engine", "dependencies.json", 4 * 1024 ** 2],
] as const)
    test(`fix1 first tree read enforces ${kind}/${path} category`, async () =>
        fixture(async (f) => {
            f.inventories[kind].files.find((file) => file.path === path)!.sizeBytes = limit + 1;
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
            );
        }));

/** 大长度只作为内部生产准入组件的声明，不创建两个四十 MiB 文件；来源角色先出现再作为 evidence 消费也必须各自计入固定六十四 MiB，不能因为路径已读或已见而跳过收费。 */
test("fix1 source-first evidence admissions consume the cumulative budget", () => {
    const budget = new EvidenceBudget(),
        first = { path: "sources/first.bin", sizeBytes: 40 * 1024 ** 2, sha256: "a".repeat(64) },
        second = { path: "sources/second.bin", sizeBytes: 40 * 1024 ** 2, sha256: "b".repeat(64) };
    budget.admit(first, false);
    budget.admit(first, true);
    budget.admit(second, false);
    assert.throws(
        () => budget.admit(second, true),
        (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
    );
});

/** 单个 Ref 多次进入证据角色只收费一次，来源角色本身不占证据额度，边界恰好六十四 MiB 可准入；再加入一个字节必须拒绝，避免以修改上限或双重收费来掩盖跨角色绕过。 */
test("fix1 evidence repeat admissions do not double-charge", () => {
    const budget = new EvidenceBudget(),
        first = { path: "sources/first.bin", sizeBytes: 40 * 1024 ** 2, sha256: "a".repeat(64) },
        rest = { path: "sources/rest.bin", sizeBytes: 24 * 1024 ** 2, sha256: "b".repeat(64) };
    budget.admit(
        { path: "archives/large.tar.gz", sizeBytes: 2 * 1024 ** 3, sha256: "c".repeat(64) },
        false,
    );
    for (let i = 0; i < 4; i++) budget.admit(first, true);
    budget.admit(rest, true);
    assert.throws(
        () =>
            budget.admit({ path: "evidence/last.bin", sizeBytes: 1, sha256: "d".repeat(64) }, true),
        (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
    );
});

/** 真实小文件先按来源角色核字节，再多次以 evidence 角色重读，仍只产生一条成功读取记录；独立声明的计费不应伪造 checkedEvidence，也不能关闭原有同路径摘要冲突拒绝。 */
test("fix1 real source evidence reuse preserves exact checked records", async () =>
    fixture(async (f) => {
        const ref = f.recipe.tools[0]!.evidence,
            reader = new InputReader(f.root, undefined, []);
        await reader.initialize();
        await reader.ref(ref, false, limits.file);
        await reader.ref(ref);
        await reader.ref(ref);
        assert.equal(reader.checked.size, 1);
        assert.deepEqual(reader.checked.get(ref.path), ref);
        await assert.rejects(
            reader.ref({ ...ref, sha256: "f".repeat(64) }),
            (e: unknown) =>
                e instanceof RuntimePayloadError && e.code === "PAYLOAD_RECEIPT_MISMATCH",
        );
        await reader.finish();
    }));
