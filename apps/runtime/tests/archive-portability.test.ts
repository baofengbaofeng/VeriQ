import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "tar";

/** 归档检查直接调用运行时实际使用的成熟 tar 适配，不执行完整引擎构建；相同内容在源时间变化后必须得到相同字节，解压后的中文与空格路径则必须保留原始内容而不依赖宿主 tar 程序。 */
test("portable engine archive is deterministic and extracts actual files", async () => {
    const { archive, extractCompiler } = await import(
        new URL("../src/execution/archive.mjs", import.meta.url).href
    );
    const root = await mkdtemp(join(tmpdir(), "veriq-archive-"));
    try {
        const source = join(root, "input"),
            output = join(root, "output");
        await mkdir(join(source, "src"), { recursive: true });
        await mkdir(output);
        await writeFile(join(source, "src/测试 file.ts"), "export const value = 7;\n");
        await archive(source, ["src"], join(root, "nested/first.tgz"));
        await utimes(join(source, "src/测试 file.ts"), new Date(), new Date());
        await archive(source, ["src"], join(root, "second.tgz"));
        assert.deepEqual(
            await readFile(join(root, "nested/first.tgz")),
            await readFile(join(root, "second.tgz")),
        );
        await extractCompiler(join(root, "nested/first.tgz"), output);
        assert.equal(
            await readFile(join(output, "src/测试 file.ts"), "utf8"),
            "export const value = 7;\n",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 已核验归档仍不能带入可逃逸编译目录的链接，先扫描后写入的边界必须在任何实际成员落盘之前拒绝；测试以成熟 tar 生成真实链接归档，避免用模拟对象绕过解析器行为。 */
test("compiler extraction rejects links before writing any member", async () => {
    const { extractCompiler } = await import(
        new URL("../src/execution/archive.mjs", import.meta.url).href
    );
    const root = await mkdtemp(join(tmpdir(), "veriq-archive-link-"));
    try {
        await mkdir(join(root, "output"));
        await writeFile(join(root, "ordinary"), "must not extract");
        await symlink("ordinary", join(root, "linked"));
        await create({ cwd: root, file: join(root, "bad.tgz"), gzip: true }, [
            "ordinary",
            "linked",
        ]);
        await assert.rejects(
            extractCompiler(join(root, "bad.tgz"), join(root, "output")),
            /UNSAFE_ENGINE_ARCHIVE/,
        );
        await assert.rejects(readFile(join(root, "output/ordinary")), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
