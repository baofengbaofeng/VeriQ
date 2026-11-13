import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { bundledAssetPath } from "../src/main/asset-path.ts";

/** 用两套真实标准库路径规则验证同一个静态协议入口，Windows 反斜杠与 POSIX 斜杠都应接受根内普通页面；父级跳转、根本身及相似前缀目录必须拒绝，不能靠换分隔符修好首页却放开越界读取。 */
test("bundled assets use Windows and POSIX containment semantics", () => {
    for (const [paths, root] of [
        [path.posix, "/opt/VeriQ/out/renderer"],
        [path.win32, "C:\\VeriQ\\out\\renderer"],
    ] as const) {
        assert.equal(bundledAssetPath(root, "/index.html", paths), paths.join(root, "index.html"));
        assert.equal(
            bundledAssetPath(root, "/assets/editor.worker.js", paths),
            paths.join(root, "assets/editor.worker.js"),
        );
        for (const name of [
            "/",
            "/../private.json",
            "/../renderer-private/key",
            "/assets/../../private.json",
        ])
            assert.equal(bundledAssetPath(root, name, paths), undefined, name);
    }
    assert.equal(
        bundledAssetPath("C:\\VeriQ\\out\\renderer", "/..\\private.json", path.win32),
        undefined,
    );
});
