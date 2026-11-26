import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBytes } from "@veriq/contracts";
import {
    DependencyFiles,
    writeDependencyJson,
    writeDependencySource,
    writeDependencyView,
} from "../scripts/runtime-dependency-files.ts";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { fixture, hash } from "./fixtures/runtime-payload.ts";

/**
 * 三种真实字节输入分别约束规范编码、非零偏移视图和原有缓冲区兼容性，期望正文独立列出以发现重新编码或越界写入。
 */
const canonicalValue = { z: "中文 café 🧪", a: [1, true] };
const canonicalExpected = Buffer.from('{"a":[1,true],"z":"中文 café 🧪"}');
const surrounded = new TextEncoder().encode("outside-before|正文 café 🧪|outside-after");
const cases = [
    { name: "canonical non-ASCII JSON", bytes: canonicalBytes(canonicalValue), expected: canonicalExpected },
    {
        name: "Uint8Array subarray",
        bytes: surrounded.subarray("outside-before|".length, surrounded.length - "|outside-after".length),
        expected: Buffer.from("正文 café 🧪"),
    },
    { name: "existing Buffer", bytes: Buffer.from("Buffer 正文\n"), expected: Buffer.from("Buffer 正文\n") },
];

for (const { name, bytes, expected } of cases) {
    test(`dependency source preserves exact ${name} bytes`, async () => {
        const root = await mkdtemp(join(tmpdir(), "veriq-dependency-source-"));
        try {
            await writeDependencySource(root, "nested/package.json", bytes);
            const path = join(root, "nested/package.json");
            assert.deepEqual(await readFile(path), expected);
            const files = new DependencyFiles();
            assert.deepEqual(await files.fact(path), {
                path,
                sizeBytes: expected.length,
                sha256: hash(expected),
            });
            await files.finish();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test(`dependency view records exact ${name} bytes and reference`, async () => {
        await dependencyWork(async (tx) => {
            const path = "dependencies/pkg/package.json";
            const ref = await writeDependencyView(tx, path, bytes);
            assert.deepEqual(ref, { path, sizeBytes: expected.length, sha256: hash(expected) });
            assert.deepEqual(await readFile(join(tx.scratch, "views", path)), expected);
            await tx.audit();
        });
    });
}

/**
 * 源目录排他写入在目标已存在时必须保留首次正文，失败后的独立读取可发现错误覆盖且临时目录由测试自身完整回收。
 */
test("dependency source rejects an existing destination without changing its bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-dependency-exclusive-"));
    try {
        await writeDependencySource(root, "package.json", canonicalBytes(canonicalValue));
        await assert.rejects(writeDependencySource(root, "package.json", Buffer.from("replacement")), {
            code: "EEXIST",
        });
        assert.deepEqual(await readFile(join(root, "package.json")), canonicalExpected);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 事务排他失败后继续核对原文件和登记摘要，随后真实清理锁与暂存目录，避免把关闭结果或错误分类替换成预制回执。
 */
test("dependency view rejects an existing destination and remains cleanable", async () => {
    await dependencyWork(async (tx) => {
        const path = "dependencies/pkg/package.json";
        await writeDependencyView(tx, path, canonicalBytes(canonicalValue));
        await assert.rejects(writeDependencyView(tx, path, Buffer.from("replacement")), {
            code: "EEXIST",
        });
        assert.deepEqual(await readFile(join(tx.scratch, "views", path)), canonicalExpected);
        await tx.audit();
    });
});

test("dependency JSON view binds the canonical non-ASCII bytes without re-encoding", async () => {
    await dependencyWork(async (tx) => {
        const path = "input-evidence/dependencies.json";
        const ref = await writeDependencyJson(tx, path, canonicalValue);
        assert.deepEqual(ref, { path, sizeBytes: canonicalExpected.length, sha256: hash(canonicalExpected) });
        assert.deepEqual(await readFile(join(tx.scratch, "views", path)), canonicalExpected);
        await tx.audit();
    });
});

/**
 * 复用既有来源夹具并创建真实工作事务，每次运行都断言清理确认与输出父目录为空，成功和排他拒绝共同使用相同收尾。
 */
async function dependencyWork(run: (tx: ArchiveTransaction) => Promise<void>) {
    await fixture(async (f) => {
        const output = await mkdtemp(join(tmpdir(), "veriq-dependency-view-"));
        const tx = new ArchiveTransaction(f.root, output, "dependency-bytes", undefined, "work");
        try {
            await tx.initialize();
            await run(tx);
        } finally {
            try {
                assert.equal(await tx.cleanup(), "CONFIRMED");
                assert.deepEqual(await readdir(output), []);
            } finally {
                await rm(output, { recursive: true, force: true });
            }
        }
    });
}
