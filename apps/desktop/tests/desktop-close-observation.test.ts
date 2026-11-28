import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCloseObservation } from "../../../tests/e2e/desktop-close-observation";
const message = "退出界面后后台继续。 / Quit UI while Agent continues?";
const options = { type: "warning", message, buttons: ["取消 / Cancel", "确认 / Confirm"], defaultId: 0, cancelId: 0 };
const rows = (path: string) =>
    existsSync(path)
        ? readFileSync(path, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];
/**
 * 夹具仅替身原生对话框的 Promise 与事件源，用于核验旁路观察不修改调用契约，不触发宿主窗口或自动选择确认结果。
 */
function setup() {
    const dir = mkdtempSync(join(tmpdir(), "veriq-close-observation-"));
    const path = join(dir, `desktop-close-main-${process.pid}.log`);
    const app = new EventEmitter();
    let fulfill!: (value: unknown) => void, reject!: (value: unknown) => void;
    const promise = new Promise((yes, no) => {
        fulfill = yes;
        reject = no;
    });
    const calls: unknown[][] = [];
    const dialog = {
        showMessageBox: function (this: unknown, ...args: unknown[]) {
            calls.push([this, ...args]);
            return promise;
        },
    };
    const source = { app, dialog } as unknown as Parameters<typeof desktopCloseObservation>[0];
    const request = { directory: dir, owner: 123, windowId: 1 };
    return { dir, path, app, dialog, promise, fulfill, reject, calls, source, request };
}
/**
 * 同一 owner 只能安装一层观察，原方法接收完全相同的 receiver 与参数，完成值和 Promise 身份均须保持一致。
 */
test("observer preserves original receiver args promise result and installs only once", async () => {
    const f = setup();
    try {
        const original = f.dialog.showMessageBox;
        desktopCloseObservation(f.source, { ...f.request, action: "install" });
        const wrapped = f.dialog.showMessageBox;
        desktopCloseObservation(f.source, { ...f.request, action: "install" });
        assert.equal(f.dialog.showMessageBox, wrapped);
        const window = { id: 1 };
        const returned = f.dialog.showMessageBox(window, options);
        assert.equal(returned, f.promise);
        assert.deepEqual(f.calls, [[f.dialog, window, options]]);
        const value = { response: 1, checkboxChecked: false, secret: "MUST_NOT_LOG" };
        f.fulfill(value);
        assert.equal(await returned, value);
        await Promise.resolve();
        f.app.emit("before-quit", { defaultPrevented: true });
        f.app.emit("will-quit", { defaultPrevented: false });
        const output = rows(f.path);
        assert.ok(
            output.some((row) => row.phase === "dialog-result" && row.response === 1 && row.checkboxChecked === false),
        );
        assert.ok(output.some((row) => row.phase === "before-quit" && row.defaultPrevented === true));
        assert.ok(!readFileSync(f.path, "utf8").includes("MUST_NOT_LOG"));
        assert.ok(!readFileSync(f.path, "utf8").includes(message));
        desktopCloseObservation(f.source, { ...f.request, owner: 124, action: "remove" });
        assert.equal(f.dialog.showMessageBox, wrapped);
        desktopCloseObservation(f.source, { ...f.request, action: "remove" });
        assert.equal(f.dialog.showMessageBox, original);
        assert.equal(f.app.listenerCount("before-quit"), 0);
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});
/**
 * 原生拒绝仍以原对象传给调用方，非退出消息不进入记录，诊断文件不可用时也不能改变真实调用成功或失败。
 */
test("rejection and non-QUIT calls remain unchanged and diagnostic failure cannot change results", async () => {
    for (const failure of [false, true]) {
        const f = setup();
        try {
            if (failure) symlinkSync(join(f.dir, "nonexistent"), f.path);
            desktopCloseObservation(f.source, { ...f.request, action: "install" });
            const error = new Error("PRIVATE_REJECTION");
            const result = f.dialog.showMessageBox({ id: 1 }, options);
            f.reject(error);
            await assert.rejects(result, (cause) => cause === error);
            await Promise.resolve();
            if (!failure) {
                assert.ok(rows(f.path).some((row) => row.phase === "dialog-rejected"));
                assert.ok(!readFileSync(f.path, "utf8").includes(error.message));
            }
            desktopCloseObservation(f.source, { ...f.request, action: "remove" });
        } finally {
            rmSync(f.dir, { recursive: true, force: true });
        }
    }
    const f = setup();
    try {
        desktopCloseObservation(f.source, { ...f.request, action: "install" });
        const result = f.dialog.showMessageBox({ id: 1 }, { ...options, message: "OTHER_PRIVATE_MESSAGE" });
        f.fulfill({ response: 0, checkboxChecked: false });
        await result;
        await Promise.resolve();
        assert.ok(!rows(f.path).some((row) => row.phase === "dialog-result"));
        f.app.emit("quit", {}, 0);
        assert.equal(f.app.listenerCount("before-quit"), 0);
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});
/**
 * 诊断输出不得跟随链接，也不能超过单文件大小及固定事件数边界；丢弃记录不会写入其他自有文件或传播系统异常。
 */
test("bounded observation rejects symlink sink and cannot write beyond 8 KiB", () => {
    const f = setup();
    f.path = join(f.dir, `desktop-close-worker-${process.pid}.log`);
    try {
        const write = () =>
            desktopCloseObservation(undefined, {
                ...f.request,
                action: "write",
                phase: "entry",
                intent: "quit",
                pid: 123,
            });
        const target = join(f.dir, "target");
        writeFileSync(target, "OWNED_SENTINEL");
        symlinkSync(target, f.path);
        write();
        assert.equal(readFileSync(target, "utf8"), "OWNED_SENTINEL");
        rmSync(f.path);
        writeFileSync(f.path, "x".repeat(8190));
        write();
        assert.equal(readFileSync(f.path).length, 8190);
        rmSync(f.path);
        write();
        assert.equal(rows(f.path)[0].phase, "entry");
        for (let index = 0; index < 100; index++) write();
        const output = rows(f.path);
        assert.ok(output.length <= 64);
        assert.ok(readFileSync(f.path).length <= 8192);
        assert.ok(output.every((row) => Buffer.byteLength(JSON.stringify(row) + "\n") <= 512));
    } finally {
        rmSync(f.dir, { recursive: true, force: true });
    }
});
