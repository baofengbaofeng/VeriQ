import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { x11WindowIds } from "../../../tests/e2e/headed.ts";

/** 夹具来自私有 Xvfb 中实际创建、映射并关闭的小型 X11 窗口，根元数据中的零 XID 不是可查询窗口；回归必须剔除这个哨兵且原样保留所有非零候选和重复根标识，后续权限、可见性及 PID 检查不在本例伪造。 */
test("actual xwininfo tree excludes only the no-window sentinel", async () => {
    const tree = await readFile(
        new URL("../../../tests/e2e/fixtures/xwininfo-tree.txt", import.meta.url),
        "utf8",
    );
    // 既有正则也会从几何尺寸80x60得到非零0x60，本轮明确保留这个候选以限定只修零哨兵；它仍须经过原 xprop 和 BadWindow 边界判断，不能把正则候选误当作已证实的真实窗口。
    assert.deepEqual(x11WindowIds(tree), ["0x21f", "0x21f", "0x200001", "0x60"]);
    assert.deepEqual(x11WindowIds("0x0000 0x000000f 0X0 0XAb"), ["0x000000f", "0XAb"]);
});
