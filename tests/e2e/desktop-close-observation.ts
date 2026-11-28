import type * as Electron from "electron";

type Phase =
    | "entry"
    | "already-exited"
    | "observer-installed"
    | "observer-removed"
    | "before-quit"
    | "will-quit"
    | "quit"
    | "dialog-result"
    | "dialog-rejected"
    | "close-called"
    | "native-confirm-sent"
    | "native-confirm-failed"
    | "await-framework-close"
    | "framework-closed"
    | "await-child-close"
    | "child-exit"
    | "child-close"
    | "close-proven";

type Observation = {
    directory: string;
    owner: number;
    windowId?: number;
    action: "install" | "remove" | "write";
    phase?: Phase;
    intent?: "quit" | "cleanup";
    pid?: number | undefined;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    stdoutDestroyed?: boolean | undefined;
    stderrDestroyed?: boolean | undefined;
    stdoutReadable?: boolean | undefined;
    stderrReadable?: boolean | undefined;
};

type Native = Pick<typeof Electron, "app" | "dialog">;

/**
 * 退出诊断只保留固定阶段和整数身份，每个独占主进程或测试 worker 分别写入有限文件，写入失败绝不改变真实退出行为。
 * 此函数独立序列化到 Electron 主进程，不能捕获测试闭包；原生确认仅旁观原 Promise，既不处理按键也不替换响应。
 */
export function desktopCloseObservation(source: Native | undefined, request: Observation): void {
    const write = (phase: Phase, detail: Record<string, number | boolean | string | null> = {}) => {
        let fd: number | undefined;
        try {
            const fs = process.getBuiltinModule("fs");
            const path = process.getBuiltinModule("path");
            const output = path.join(
                request.directory,
                `desktop-close-${source ? "main" : "worker"}-${process.pid}.log`,
            );
            const line =
                JSON.stringify({ at: Date.now(), owner: request.owner, writerPid: process.pid, phase, ...detail }) +
                "\n";
            if (Buffer.byteLength(line) > 512) return;
            fd = fs.openSync(
                output,
                fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
                0o600,
            );
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size > 8192) return;
            const existing = Buffer.alloc(8193);
            const length = fs.readSync(fd, existing, 0, existing.length, 0);
            if (
                length + Buffer.byteLength(line) > 8192 ||
                existing.subarray(0, length).filter((byte) => byte === 10).length >= 64
            )
                return;
            fs.writeSync(fd, line);
        } catch {
            // 诊断文件不可写、身份不符或观测额度耗尽时只丢弃本条记录，原生对话框和进程退出仍按原有控制流执行。
        } finally {
            if (fd !== undefined) {
                try {
                    process.getBuiltinModule("fs").closeSync(fd);
                } catch {
                    // 文件描述符清理异常同样不得成为业务异常，也不将宿主路径或系统错误正文加入有限的退出诊断产物。
                }
            }
        }
    };
    if (request.action === "write") {
        if (!request.phase) return;
        const detail: Record<string, number | boolean | string | null> = {};
        for (const name of ["pid", "code"] as const) {
            const value = request[name];
            if (value === null || (typeof value === "number" && Number.isSafeInteger(value))) detail[name] = value;
        }
        for (const name of ["stdoutDestroyed", "stderrDestroyed", "stdoutReadable", "stderrReadable"] as const) {
            if (typeof request[name] === "boolean") detail[name] = request[name];
        }
        if (request.intent === "quit" || request.intent === "cleanup") detail.intent = request.intent;
        if (
            request.signal === null ||
            (typeof request.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(request.signal))
        )
            detail.signal = request.signal;
        write(request.phase, detail);
        return;
    }
    if (!source) return;
    const { app, dialog } = source;
    const key = Symbol.for("veriq.test.desktop.close.observer");
    const owned = app as typeof app & { [key]?: { owner: number; remove: () => void } };
    if (request.action === "remove") {
        const installed = owned[key];
        if (installed?.owner === request.owner) installed.remove();
        return;
    }
    if (owned[key]) return;
    const original = dialog.showMessageBox;
    const beforeQuit = (event: Electron.Event) => write("before-quit", { defaultPrevented: event.defaultPrevented });
    const willQuit = (event: Electron.Event) => write("will-quit", { defaultPrevented: event.defaultPrevented });
    const quit = (_event: Electron.Event, code: number) => {
        write("quit", Number.isSafeInteger(code) ? { code } : {});
        remove();
    };
    const wrapped: typeof original = function (
        this: Electron.Dialog,
        ...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow, Electron.MessageBoxOptions]
    ) {
        const pending = Reflect.apply(original, this, args) as Promise<Electron.MessageBoxReturnValue>;
        try {
            const options = args[args.length - 1] as Electron.MessageBoxOptions;
            const suffix = "退出界面后后台继续。 / Quit UI while Agent continues?";
            const isQuit =
                args.length === 2 &&
                args[0].id === request.windowId &&
                options.type === "warning" &&
                (options.message === suffix ||
                    options.message === "当前有执行或在线领取。 / Active work or polling exists. " + suffix) &&
                options.buttons?.length === 2 &&
                options.buttons[0] === "取消 / Cancel" &&
                options.buttons[1] === "确认 / Confirm" &&
                options.defaultId === 0 &&
                options.cancelId === 0;
            if (isQuit) {
                void pending.then(
                    (answer) => {
                        try {
                            if (Number.isSafeInteger(answer.response) && typeof answer.checkboxChecked === "boolean")
                                write("dialog-result", {
                                    kind: "QUIT",
                                    response: answer.response,
                                    checkboxChecked: answer.checkboxChecked,
                                });
                        } catch {
                            // 原生响应只记固定标量，旁路异常不改变原 Promise 状态或调用方收到的结果。
                        }
                    },
                    () => write("dialog-rejected", { kind: "QUIT" }),
                );
            }
        } catch {
            // 仅识别当前产品既有 QUIT 对话框，其他调用和不支持的形状原样返回，不保存选项或输出错误正文及界面消息。
        }
        return pending;
    };
    const remove = () => {
        if (owned[key]?.owner !== request.owner) return;
        if (dialog.showMessageBox === wrapped) dialog.showMessageBox = original;
        app.removeListener("before-quit", beforeQuit);
        app.removeListener("will-quit", willQuit);
        app.removeListener("quit", quit);
        delete owned[key];
        write("observer-removed");
    };
    owned[key] = { owner: request.owner, remove };
    dialog.showMessageBox = wrapped;
    app.on("before-quit", beforeQuit);
    app.on("will-quit", willQuit);
    app.on("quit", quit);
    write("observer-installed");
}
