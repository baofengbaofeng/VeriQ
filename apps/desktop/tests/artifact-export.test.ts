import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withArtifactExport } from "../src/main/artifact-export.ts";

/** 使用真实临时文件覆盖原生查看与保存的副本寿命，失败回调模拟已经到达主机的查看器启动错误而非业务执行结果；成功和取消都必须回收本次导出，同时保持原始证据字节不变。 */
test("native export is reclaimed after success, user cancellation and viewer failure", async () => {
    const root = await mkdtemp("/tmp/veriq-export-");
    const original = join(root, "original.png");
    const exported = join(root, "export.png");
    const viewerCopy = join(root, "viewer-private-copy.png");
    const content = Buffer.from("private evidence");
    await writeFile(original, content);
    try {
        for (const mode of ["failed", "wrong-kind", "cancelled", "saved"]) {
            await writeFile(exported, content);
            const action = withArtifactExport(exported, async () => {
                assert.deepEqual(await readFile(exported), content);
                if (mode === "failed") throw new Error("TRACE_START_FAILED");
                if (mode === "wrong-kind") throw new Error("TRACE_REQUIRED");
                if (mode === "saved") await copyFile(exported, viewerCopy);
                return mode;
            });
            if (mode === "failed") await assert.rejects(action, /TRACE_START_FAILED/);
            else if (mode === "wrong-kind") await assert.rejects(action, /TRACE_REQUIRED/);
            else assert.equal(await action, mode);
            await assert.rejects(readFile(exported), { code: "ENOENT" });
            assert.deepEqual(await readFile(original), content);
            if (mode === "saved") assert.deepEqual(await readFile(viewerCopy), content);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
