import { desktopErrorMessage } from "../shared/desktop-errors";
import { app, dialog, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

/** 生命周期菜单使用 Electron 系统 API 为 Dock、菜单栏与支持的托盘提供同一组明确动作，退出 UI 和停止后台分别调用宿主已有
 * 确认流程；不把窗口关闭或开机启动设置暗中转成取消测试、执行命令或注册系统服务。Mac 保持
 * Dock 激活恢复窗口，同时提供可见菜单栏图标，Windows 与 KDE 使用系统托盘。不支持托盘的 Linux 环境继续最小化窗口，避免
 * 隐藏后失去可恢复入口。登录项只在真实安装的 Mac/Windows 提供，开启的是本地
 * GUI，Agent 沿既有独立生命周期启动。系统菜单中的 Quit、Cmd+Q 与 renderer 按钮必须共享同一确认边界。图标是随源码保存的
 * 本地 PNG，不依赖网络、系统主题路径或单像素占位图片。
 */
export function installLifecycleMenu(actions: {
    show: () => void;
    quit: () => Promise<void>;
    stop: () => Promise<void>;
    update: () => Promise<void>;
    diagnostics: () => Promise<void>;
    report: (error: unknown) => void;
}): Tray | undefined {
    const run = (action: () => Promise<void>) => () => {
        void action().catch(actions.report);
    };
    const canLogin = app.isPackaged && ["darwin", "win32"].includes(process.platform);
    const login = (): MenuItemConstructorOptions => ({
        label: "登录时打开 VeriQ / Open at login",
        type: "checkbox",
        enabled: canLogin,
        checked: canLogin && app.getLoginItemSettings().openAtLogin,
        click: (item) => {
            try {
                app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
                if (app.getLoginItemSettings().openAtLogin !== item.checked)
                    throw new Error("DESKTOP_LOGIN_ITEM_UNCONFIRMED");
            } catch (error) {
                actions.report(error);
            }
        },
    });
    const application: MenuItemConstructorOptions[] = [
        { label: "打开 VeriQ / Open", click: actions.show },
        { label: "版本与诊断 / Versions and diagnostics", click: run(actions.diagnostics) },
        {
            label: "准备已验证升级或回滚 / Prepare verified update",
            click: run(actions.update),
            enabled: app.isPackaged,
        },
        { type: "separator" },
        login(),
        { label: "停止后台 / Stop Agent", click: run(actions.stop) },
        {
            label: "退出界面，保留后台 / Quit UI",
            accelerator: "CmdOrCtrl+Q",
            click: run(actions.quit),
        },
    ];
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { label: "VeriQ", submenu: application },
            {
                label: "编辑 / Edit",
                submenu: [
                    { role: "undo" },
                    { role: "redo" },
                    { type: "separator" },
                    { role: "cut" },
                    { role: "copy" },
                    { role: "paste" },
                    { role: "selectAll" },
                ],
            },
            {
                label: "窗口 / Window",
                submenu: [
                    { label: "显示工作台 / Show workspace", click: actions.show },
                    { role: "minimize" },
                    { role: "zoom" },
                ],
            },
        ]),
    );
    const supportsTray =
        ["darwin", "win32"].includes(process.platform) ||
        process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes("kde");
    if (!supportsTray) return undefined;
    const icon = nativeImage.createFromBuffer(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAUUlEQVR4nGNgGJZALfbYfximqmG4ME0MJdlwUgwl2nBiNJJlOCmKB95" +
                "gciKFKD1Dz2BiFdIsVVDFYKqlY3waB2+2JsVwZHVEG4zLErIMGNkAAL0fbRD05215AAAAAElFTkSuQmCC",
            "base64",
        ),
    );
    if (process.platform === "darwin") icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.setToolTip("VeriQ — UI and Agent have separate lifecycles");
    tray.on("click", actions.show);
    tray.setContextMenu(Menu.buildFromTemplate(application));
    return tray;
}

/** 原生菜单失败通过有限错误码提示用户，日志只保留英文分类而不回显私有目录、证书正文或系统异常堆栈；异步菜单 Promise 总
 * 有明确拒绝处理，不能因一次签名或停止失败造成静默无响应。UI 错误提示不声称未知操作已经回滚，
 * 用户可继续打开诊断和执行恢复。对话框使用系统窗口，因此 renderer 不参与构造确认结果或读取宿主错误对象。
 */
export function reportLifecycleError(error: unknown): void {
    const code =
        error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
            ? error.message
            : "DESKTOP_LIFECYCLE_FAILED";
    console.error("VeriQ desktop lifecycle failed:", code);
    dialog.showErrorBox(
        "VeriQ",
        desktopErrorMessage(code, app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en"),
    );
}
