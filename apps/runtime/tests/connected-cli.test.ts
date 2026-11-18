/**
 * 真实 CLI 帮助必须公开联网领取与历史报告读取，退役的离线启动、签名包下载和结果导入不应进入命令解析器。
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

test("MVP CLI exposes connected runtime and historical reports", () => {
    const help = (...args: string[]) =>
        execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--help"], { encoding: "utf8" });
    assert.match(help(), /runtime/);
    assert.doesNotMatch(help(), /^  (run|bundle)\b/m);
    assert.match(help("results"), /history/);
    assert.doesNotMatch(help("results"), /upload </);
});
