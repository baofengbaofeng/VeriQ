import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { doctor } from "../src/doctor.ts";
import { diagnoseRelease } from "../src/distribution.ts";

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

/** CLI 与桌面共用发行适配后必须申报真实库存版本而非零点一组件包号，缺少所选库存时即使给出有效浏览器也不得形成能力；此例仅复用受保护只读候选和既有浏览器，不生成新引擎或运行 GUI。 */
test("shared release doctor advertises the verified engine identity", async () => {
    const options = {
        engineDirectory: resolve("../../work/t19-engine-current"),
        engineVersion: "1.0.1-t19",
        browserExecutable: resolve(
            "../../.superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
        ),
    };
    const result = await diagnoseRelease(options);
    assert.equal(result.ok, true);
    assert.equal(result.capabilities?.engineVersion, "1.0.1-t19");
    const wrongBrowser = await doctor({
        executablePath: options.browserExecutable,
        expectedBrowserVersion: "1.2.3.4",
    });
    assert.equal(wrongBrowser.ok, false);
    assert.equal(wrongBrowser.capabilities, undefined);
    assert.equal(wrongBrowser.checks.find((item) => item.name === "browser version")?.ok, false);
    await assert.rejects(
        diagnoseRelease({ ...options, engineVersion: "9.9.9-absent" }),
        /ENGINE_NOT_APPROVED/,
    );
});
