import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/** 后台入口在任何私有档案访问前执行独立 Node 检查，使用真实子进程注入版本事实可区分兼容门槛与随后缺档案参数的失败；这些合成版本不代表安装另一份 Node 或完成该版本端到端验收，Electron 同版本也必须停在兼容检查。 */
test("agent entry accepts stable Node24 and rejects Electron before profile access", () => {
    for (const [node, electron, expected] of [
        ["24.20.0", undefined, "AGENT_PROFILE_REQUIRED"],
        ["23.99.0", undefined, "INDEPENDENT_NODE24_REQUIRED"],
        ["25.0.0", undefined, "INDEPENDENT_NODE24_REQUIRED"],
        ["24.20.0-rc.1", undefined, "INDEPENDENT_NODE24_REQUIRED"],
        ["24.22.1", "45.3.1", "INDEPENDENT_NODE24_REQUIRED"],
    ] as const) {
        const script = `
Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(node)} });
${electron ? `Object.defineProperty(process.versions, "electron", { value: ${JSON.stringify(electron)} });` : ""}
await import(${JSON.stringify(new URL("../src/agent/index.ts", import.meta.url).href)});
`;
        const result = spawnSync(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script],
            { encoding: "utf8", timeout: 10000 },
        );
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, new RegExp(expected));
    }
});
