import assert from "node:assert/strict";
import test from "node:test";
import { rendererTarget, type RendererRoleSource } from "../../../tests/e2e/renderer-fault";

type Metric = { pid: number; type: string; creationTime: number };
const rendererPid = process.pid + 100000;
const validMetrics = (): Metric[] => [
    { pid: process.pid, type: "Browser", creationTime: 1000 },
    { pid: rendererPid, type: "Tab", creationTime: 2000 },
];

/** 这里只提供官方接口的最小受控指标以验证角色拒绝契约，不读取或终止这些数字对应的宿主进程；实际驱动必须先通过同一函数的两次验证，之后才可启动固定 pidfd 辅助器。 */
function source(
    metrics: Metric[] = validMetrics(),
    windowId = 1,
    contentsId = 1,
): RendererRoleSource {
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

/** 官方 Browser/Tab 对应同一主窗 PID 且创建时间稳定时才返回完整目标，第二次验证必须接受完全相同的快照；这个纯角色检查没有信号能力，不能用通过结果代替实际 Electron 故障恢复。 */
test("official Browser and Tab metrics bind a stable app renderer", () => {
    const initial = rendererTarget(source());
    assert.equal(initial.mainPid, process.pid);
    assert.equal(initial.rendererPid, rendererPid);
    assert.equal(initial.mainCreationTime, 1000);
    assert.equal(initial.rendererCreationTime, 2000);
    assert.deepEqual(rendererTarget(source(), initial), initial);
});

/** 缺少任一官方进程指标、同 PID 重复指标或 Browser/Tab 角色错误都必须拒绝，不能根据进程标题包含某个单词补全身份；拒绝发生在产生可供信号辅助器使用的目标快照之前。 */
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

/** 创建时间必须为正且有限，零、负数与非数值不能被当作缺省身份；主进程和 renderer 分别验证，避免某一端时间无效时仍把另一端的正确 PID 当作足够的故障授权。 */
test("both official creation times must be positive and finite", () => {
    for (const index of [0, 1]) {
        for (const creationTime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const metrics = validMetrics();
            metrics[index] = { ...metrics[index]!, creationTime };
            assert.throws(() => rendererTarget(source(metrics)), /METRIC_TIME_INVALID/);
        }
    }
});

/** 监听安装后的第二次采样必须继续指向原窗口、内容和两个创建时间，任一漂移都不能继续发送故障信号；多个窗口或非应用 URL 也拒绝，避免把 Trace 或其它页面误当目标。 */
test("changed official identity or app window is rejected on revalidation", () => {
    const initial = rendererTarget(source());
    for (const index of [0, 1]) {
        const metrics = validMetrics();
        metrics[index] = { ...metrics[index]!, creationTime: metrics[index]!.creationTime + 1 };
        assert.throws(() => rendererTarget(source(metrics), initial), /METRIC_IDENTITY_CHANGED/);
    }
    assert.throws(
        () => rendererTarget(source(validMetrics(), 2), initial),
        /METRIC_IDENTITY_CHANGED/,
    );
    assert.throws(
        () => rendererTarget(source(validMetrics(), 1, 2), initial),
        /METRIC_IDENTITY_CHANGED/,
    );
    const moved = source([
        { pid: process.pid, type: "Browser", creationTime: 1000 },
        { pid: rendererPid + 1, type: "Tab", creationTime: 2000 },
    ]);
    const movedWindow = moved.BrowserWindow.getAllWindows()[0]!;
    movedWindow.webContents.getOSProcessId = () => rendererPid + 1;
    moved.BrowserWindow.getAllWindows = () => [movedWindow];
    assert.throws(() => rendererTarget(moved, initial), /METRIC_IDENTITY_CHANGED/);
    assert.throws(
        () => rendererTarget(source(), { ...initial, mainPid: process.pid + 1 }),
        /METRIC_IDENTITY_CHANGED/,
    );
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
