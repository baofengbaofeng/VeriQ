import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { doctor } from "../src/doctor.ts";
import { diagnoseRelease } from "../src/distribution.ts";

const executablePath = chromium.executablePath();

/**
 * 已经核验的发行上下文用于独立打包后台的版本定位，不能绕过版本兼容条件或把控制平台离线说成可达；本例仍启动真实匹配浏览
 * 器，三种调用方式分别检查原包探测、有效发行及不支持发行。
 */
test("doctor keeps package probing and validates explicit distribution versions", async () => {
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
        assert.match(selected.checks.find((item) => item.name === name)!.detail, /verified distribution/);
    }
});

/**
 * 用正式构建器从工作区已安装的依赖生成临时引擎。发行版本与组件包号不同，只有核验库存与匹配浏览器后才能申报该版本。
 */
test("shared release doctor advertises the verified engine identity", async (t) => {
    const work = fileURLToPath(new URL("../../../work/", import.meta.url));
    await mkdir(work, { recursive: true });
    const directory = await mkdtemp(join(work, "doctor-engine-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const options = {
        engineDirectory: join(directory, "release"),
        engineVersion: "1.0.1-doctor-test",
        browserExecutable: executablePath,
    };
    const builder = fileURLToPath(new URL("../../../scripts/build_engine.mts", import.meta.url));
    await promisify(execFile)(process.execPath, [
        "--import",
        import.meta.resolve("tsx"),
        builder,
        options.engineVersion,
        options.engineDirectory,
    ]);
    const result = await diagnoseRelease(options);
    assert.equal(result.ok, true);
    assert.equal(result.capabilities?.engineVersion, options.engineVersion);
    const wrongBrowser = await doctor({
        executablePath: options.browserExecutable,
        expectedBrowserVersion: "1.2.3.4",
    });
    assert.equal(wrongBrowser.ok, false);
    assert.equal(wrongBrowser.capabilities, undefined);
    assert.equal(wrongBrowser.checks.find((item) => item.name === "browser version")?.ok, false);
    await assert.rejects(diagnoseRelease({ ...options, engineVersion: "9.9.9-absent" }), /ENGINE_NOT_APPROVED/);
    await appendFile(join(options.engineDirectory, "dependencies.json"), "\n");
    await assert.rejects(diagnoseRelease(options), /RELEASE_HASH_MISMATCH/);
});

test("connected capability requires both component declarations from the selected release", async () => {
    const versions = { compilerVersion: "0.1.0", runnerSdkVersion: "0.1.0" };
    for (const features of [
        {},
        { compilerConnectedDatasets: "2.0" },
        { runnerSdkConnectedDatasets: "2.0" },
        { compilerConnectedDatasets: "2.0", runnerSdkConnectedDatasets: "2.0" },
    ] as const) {
        const result = await doctor({ executablePath, distribution: { ...versions, ...features } });
        assert.equal(result.ok, true);
        assert.equal(
            result.capabilities?.connectedDatasets,
            "compilerConnectedDatasets" in features && "runnerSdkConnectedDatasets" in features ? "2.0" : undefined,
        );
    }
});

test("live dataset capability requires both verified HTTP components", async () => {
    const distribution = {
        compilerVersion: "0.1.0",
        runnerSdkVersion: "0.1.0",
        compilerConnectedDatasets: "2.0",
        runnerSdkConnectedDatasets: "2.0",
        compilerHttpDatasets: "1.0",
    } as const;
    for (const http of [false, true]) {
        const r = await doctor({
            executablePath,
            distribution: {
                ...distribution,
                ...(http ? { runnerSdkHttpDatasets: "1.0" as const } : {}),
            },
        });
        assert.equal(r.capabilities?.httpDatasets, http ? "1.0" : undefined);
    }
});
