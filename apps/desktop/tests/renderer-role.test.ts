import assert from "node:assert/strict";
import test from "node:test";
import {
    rendererTarget,
    parseRendererEndpoint,
    verifyRendererBinding,
    type RendererRoleSource,
} from "../../../tests/e2e/renderer-fault";

type Metric = { pid: number; type: string; creationTime: number };
const rendererPid = process.pid + 100000;
const validMetrics = (): Metric[] => [
    { pid: process.pid, type: "Browser", creationTime: 1000 },
    { pid: rendererPid, type: "Tab", creationTime: 2000 },
];

/**
 * 这里只提供官方接口的最小受控指标以验证角色拒绝契约，不读取或终止这些数字对应的宿主进程；实际驱动必须先通过同一函数的
 * 两次验证，之后才可启动固定 pidfd 辅助器。
 */
function source(metrics: Metric[] = validMetrics(), windowId = 1, contentsId = 1): RendererRoleSource {
    return {
        BrowserWindow: {
            getAllWindows: () => [
                {
                    id: windowId,
                    webContents: {
                        id: contentsId,
                        getURL: () => "veriq://app/index.html",
                        getOSProcessId: () => rendererPid,
                    },
                },
            ],
        },
        app: { getAppMetrics: () => metrics },
    };
}

/**
 * 官方 Browser/Tab 对应同一主窗 PID 且创建时间稳定时才返回完整目标，第二次验证必须接受完全相同的快照；这个纯角色检查没
 * 有信号能力，不能用通过结果代替实际 Electron 故障恢复。
 */
test("official Browser and Tab metrics bind a stable app renderer", () => {
    const initial = rendererTarget(source());
    assert.equal(initial.mainPid, process.pid);
    assert.equal(initial.rendererPid, rendererPid);
    assert.equal(initial.mainCreationTime, 1000);
    assert.equal(initial.rendererCreationTime, 2000);
    assert.deepEqual(rendererTarget(source(), initial), initial);
});

/**
 * 缺少任一官方进程指标、同 PID 重复指标或 Browser/Tab 角色错误都必须拒绝，不能根据进程标题包含某个单词补全身份；拒绝发
 * 生在产生可供信号辅助器使用的目标快照之前。
 */
test("missing duplicate and wrong official roles are rejected", () => {
    const [main, renderer] = validMetrics();
    for (const metrics of [
        [],
        [main!],
        [renderer!],
        [main!, main!, renderer!],
        [main!, renderer!, renderer!],
        [{ ...main!, type: "Tab" }, renderer!],
        [main!, { ...renderer!, type: "GPU" }],
    ]) {
        assert.throws(() => rendererTarget(source(metrics)), /METRIC_ROLE_MISMATCH/);
    }
});

/**
 * 创建时间必须为正且有限，零、负数与非数值不能被当作缺省身份；主进程和 renderer 分别验证，避免某一端时间无效时仍把另一
 * 端的正确 PID 当作足够的故障授权。
 */
test("both official creation times must be positive and finite", () => {
    for (const index of [0, 1]) {
        for (const creationTime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const metrics = validMetrics();
            metrics[index] = { ...metrics[index]!, creationTime };
            assert.throws(() => rendererTarget(source(metrics)), /METRIC_TIME_INVALID/);
        }
    }
});

/**
 * 监听安装后的第二次采样必须继续指向原窗口、内容和两个创建时间，任一漂移都不能继续发送故障信号；多个窗口或非应用 URL
 * 也拒绝，避免把 Trace 或其它页面误当目标。
 */
test("changed official identity or app window is rejected on revalidation", () => {
    const initial = rendererTarget(source());
    for (const index of [0, 1]) {
        const metrics = validMetrics();
        metrics[index] = { ...metrics[index]!, creationTime: metrics[index]!.creationTime + 1 };
        assert.throws(() => rendererTarget(source(metrics), initial), /METRIC_IDENTITY_CHANGED/);
    }
    assert.throws(() => rendererTarget(source(validMetrics(), 2), initial), /METRIC_IDENTITY_CHANGED/);
    assert.throws(() => rendererTarget(source(validMetrics(), 1, 2), initial), /METRIC_IDENTITY_CHANGED/);
    const moved = source([
        { pid: process.pid, type: "Browser", creationTime: 1000 },
        { pid: rendererPid + 1, type: "Tab", creationTime: 2000 },
    ]);
    const movedWindow = moved.BrowserWindow.getAllWindows()[0]!;
    movedWindow.webContents.getOSProcessId = () => rendererPid + 1;
    moved.BrowserWindow.getAllWindows = () => [movedWindow];
    assert.throws(() => rendererTarget(moved, initial), /METRIC_IDENTITY_CHANGED/);
    assert.throws(() => rendererTarget(source(), { ...initial, mainPid: process.pid + 1 }), /METRIC_IDENTITY_CHANGED/);
    const multiple = source();
    const window = multiple.BrowserWindow.getAllWindows()[0]!;
    multiple.BrowserWindow.getAllWindows = () => [window, window];
    assert.throws(() => rendererTarget(multiple), /APP_WINDOW_REQUIRED/);
    const other = source();
    const otherWindow = other.BrowserWindow.getAllWindows()[0]!;
    otherWindow.webContents.getURL = () => "http://127.0.0.1/";
    other.BrowserWindow.getAllWindows = () => [otherWindow];
    assert.throws(() => rendererTarget(other), /APP_WINDOW_REQUIRED/);
});

/**
 * 重附着端点只能来自有限的 Chromium 私有端口文件，固定回环主机与严格浏览器路径；拒绝超界或混入 URL 的内容而不回显能力。
 */
test("recovered driver accepts only bounded loopback Chromium port records", () => {
    const path = "/devtools/browser/12345678-1234-4234-8234-123456789abc";
    assert.equal(parseRendererEndpoint(Buffer.from(`12345\n${path}\n`)), `ws://127.0.0.1:12345${path}`);
    for (const raw of [
        "",
        `0\n${path}`,
        `65536\n${path}`,
        `0123\n${path}`,
        `-1\n${path}`,
        `1234\nws://evil.invalid${path}`,
        `1234\n${path}\nextra`,
        `1234\n${path}?token=secret`,
        `1234\n/devtools/page/12345678-1234-4234-8234-123456789abc`,
        `1234\n${path}\0`,
        `1234\n${path}\n\n`,
        `1234\n${path}\r`,
        "x".repeat(513),
    ])
        assert.throws(() => parseRendererEndpoint(Buffer.from(raw)), /^Error: RENDERER_DEVTOOLS_ENDPOINT_INVALID$/);
});

/**
 * 重附着页面由官方 target 反查原窗口和新 renderer，并核对 webContents 与主进程，任一身份漂移都拒绝。
 */
test("recovered driver rejects cross-target or replaced native identities", () => {
    const proof = {
        mainPid: process.pid,
        windowId: 1,
        contentsId: 2,
        oldRendererPid: 10,
        rendererPid: 11,
        targetId: "A".repeat(32),
        url: "veriq://app/index.html",
    };
    let targetId = proof.targetId,
        contentsId = 2,
        windowId = 1,
        pid = 11,
        url = proof.url;
    let missing = false;
    const contents = {
        get id() {
            return contentsId;
        },
        getURL: () => url,
        getOSProcessId: () => pid,
        getOrCreateDevToolsTargetId: () => targetId,
    };
    const native = {
        BrowserWindow: {
            getAllWindows: () => [{ id: windowId, webContents: { id: 2 } }],
        },
        webContents: { fromDevToolsTargetId: () => (missing ? undefined : contents) },
    };
    assert.deepEqual(verifyRendererBinding(native, proof), proof);
    for (const change of [
        () => {
            targetId = "B".repeat(32);
        },
        () => {
            contentsId = 3;
        },
        () => {
            windowId = 3;
        },
        () => {
            pid = 12;
        },
        () => {
            url = "https://foreign.invalid";
        },
        () => {
            missing = true;
        },
    ]) {
        change();
        assert.equal(verifyRendererBinding(native, proof), null);
        targetId = proof.targetId;
        contentsId = 2;
        windowId = 1;
        pid = 11;
        url = proof.url;
        missing = false;
    }
    assert.equal(verifyRendererBinding(native, { ...proof, mainPid: process.pid + 1 }), null);
});

/**
 * 新驱动身份验证不接受仍然指向旧 renderer 的伪恢复记录，非法 target 格式和非应用 URL 也不能经反查结果自证有效。
 */
test("driver recovery proof cannot retain the crashed renderer or change the app origin", () => {
    const proof = {
        mainPid: process.pid,
        windowId: 1,
        contentsId: 2,
        oldRendererPid: 10,
        rendererPid: 10,
        targetId: "A".repeat(32),
        url: "veriq://app/index.html",
    };
    const contents = {
        id: 2,
        getURL: () => proof.url,
        getOSProcessId: () => proof.rendererPid,
        getOrCreateDevToolsTargetId: () => proof.targetId,
    };
    const native = {
        BrowserWindow: { getAllWindows: () => [{ id: 1, webContents: { id: 2 } }] },
        webContents: { fromDevToolsTargetId: () => contents },
    };
    assert.equal(verifyRendererBinding(native, proof), null);
    proof.rendererPid = 11;
    proof.targetId = "invalid";
    assert.equal(verifyRendererBinding(native, proof), null);
    proof.targetId = "A".repeat(32);
    proof.url = "https://foreign.invalid";
    assert.equal(verifyRendererBinding(native, proof), null);
});
