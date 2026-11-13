import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { doctor } from "../src/doctor.ts";

/** 已经核验的发行上下文用于独立打包后台的版本定位，不能绕过版本兼容条件或把控制平台离线说成可达；本例仍启动真实匹配浏览器，三种调用方式分别检查原包探测、有效发行及不支持发行。 */
test("doctor keeps package probing and validates explicit distribution versions", async () => {
    const executablePath = resolve(
        "../../.superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
    );
    const baseline = await doctor({ executablePath });
    assert.equal(baseline.ok, true);
    const incompatible = await doctor({
        executablePath,
        distribution: { compilerVersion: "9.0.0", runnerSdkVersion: "0.1.0" },
    });
    assert.equal(incompatible.ok, false);
    assert.equal(incompatible.capabilities, undefined);
    assert.equal(incompatible.checks.find((item) => item.name === "@veriq/compiler")?.ok, false);
    const selected = await doctor({
        executablePath,
        server: "http://127.0.0.1:1",
        distribution: { compilerVersion: "0.1.0", runnerSdkVersion: "0.1.0" },
    });
    assert.equal(selected.ok, false);
    assert.equal(selected.checks.find((item) => item.name === "control network")?.ok, false);
    for (const name of ["@veriq/compiler", "@veriq/runner-sdk"]) {
        assert.equal(selected.checks.find((item) => item.name === name)?.ok, true);
        assert.match(
            selected.checks.find((item) => item.name === name)!.detail,
            /verified distribution/,
        );
    }
});
