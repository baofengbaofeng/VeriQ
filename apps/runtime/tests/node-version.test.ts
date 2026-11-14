import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { doctor } from "../src/doctor.ts";

/** 版本矩阵同时供发行构建与真实自检使用，测试仅替换只读的进程版本事实以覆盖当前宿主无法安装的边界；浏览器路径始终不存在且请求已取消，因此 Node 通过也不能错误申报整体可执行能力或浏览器就绪。 */
test("doctor accepts stable Node24 and keeps browser readiness independent", async () => {
    const cases = JSON.parse(
        await readFile(new URL("./fixtures/node24-versions.json", import.meta.url), "utf8"),
    ) as { version: string; supported: boolean }[];
    const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    try {
        for (const { version, supported } of [
            ...cases,
            { version: "24.20.0\n", supported: false },
        ]) {
            Object.defineProperty(process.versions, "node", { ...original, value: version });
            const result = await doctor({
                executablePath: "/absent/veriq-browser",
                signal: AbortSignal.abort(),
            });
            const node = result.checks.find((item) => item.name === "Node")!;
            assert.equal(node.ok, supported, JSON.stringify(version));
            assert.equal(node.detail, version);
            assert.equal(result.ok, false);
            assert.equal(result.capabilities, undefined);
            assert.equal(result.checks.find((item) => item.name === "browser launch")?.ok, false);
        }
    } finally {
        Object.defineProperty(process.versions, "node", original);
    }
});

/** Electron 的内嵌 Node 即使落在同一稳定大版本也不能被当作执行器，测试通过真实自检入口核对这条进程事实边界；恢复所有描述符避免影响同文件后续检查，诊断仍保留实际 Node 版本供排障。 */
test("doctor refuses the Electron UI runtime as an independent executor", async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
    try {
        Object.defineProperty(process.versions, "electron", {
            configurable: true,
            value: "45.3.1",
        });
        const result = await doctor({
            executablePath: "/absent/veriq-browser",
            signal: AbortSignal.abort(),
        });
        assert.equal(result.checks.find((item) => item.name === "Node")?.ok, false);
        assert.equal(
            result.checks.find((item) => item.name === "Node")?.detail,
            process.versions.node,
        );
    } finally {
        if (original) Object.defineProperty(process.versions, "electron", original);
        else Reflect.deleteProperty(process.versions, "electron");
    }
});
