/**
 * 真实 CLI 帮助必须公开联网领取与历史报告读取，退役的离线启动、签名包下载和结果导入不应进入命令解析器。
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("MVP CLI exposes connected runtime and historical reports", () => {
    const help = (...args: string[]) =>
        execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--help"], { encoding: "utf8" });
    const root = help();
    assert.match(root, /^  runtime +Run and control the online Agent$/m);
    assert.match(root, /^  results +Historical local reports/m);
    assert.doesNotMatch(root, /^  (run|bundle|upload)\b/m);
    const results = help("results");
    assert.match(results, /^  history \[options\]$/m);
    assert.match(results, /^  report \[options\] <runId>$/m);
    assert.match(results, /^  cancel \[options\] <runId>$/m);
    assert.match(results, /^  recover +Reconcile an interrupted local host/m);
    assert.doesNotMatch(results, /^  (run|upload)\b/m);
});
