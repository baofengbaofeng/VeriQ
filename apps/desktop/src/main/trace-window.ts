import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import type { DesktopAgentClient } from "../agent/client";
import { object } from "./policy";
import { ownedTraceOrigin, allowedTraceRequest } from "./viewer-policy";

/** 原生 Trace 使用与主 UI 和普通登录均隔离的临时 Session，窗口没有 preload 或 VeriQ bridge；固定后台监听来源之外的导航、弹窗、网络和权限请求全部拒绝，避免证据页面取得平台凭证。 */
export async function openNativeTrace(client: DesktopAgentClient, input: unknown): Promise<void> {
    const value = object(input, ["viewerId", "url", "pid"]);
    if (
        typeof value.url !== "string" ||
        typeof value.viewerId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(value.viewerId)
    )
        throw new Error("TRACE_VIEWER_INVALID");
    const origin = ownedTraceOrigin(value.url),
        viewerId = value.viewerId;
    const isolated = session.fromPartition(`veriq-trace-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_content, _permission, answer) => answer(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((request, answer) => {
        answer({ cancel: !allowedTraceRequest(request.url, request.resourceType, origin) });
    });
    await client.call({ operation: "viewerKeepAlive", viewerId });
    const viewer = new BrowserWindow({
        title: "VeriQ · Trace",
        width: 1280,
        height: 800,
        webPreferences: {
            session: isolated,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
        },
    });
    viewer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    viewer.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault();
    });
    const pulse = setInterval(() => {
        void client.call({ operation: "viewerKeepAlive", viewerId }).catch(() => viewer.destroy());
    }, 5000);
    viewer.once("closed", () => {
        clearInterval(pulse);
        void client
            .call({ operation: "viewerClose", viewerId })
            .finally(() => isolated.clearStorageData())
            .catch((error) => console.error("Trace viewer cleanup failed:", error.message));
    });
    try {
        await viewer.loadURL(value.url);
    } catch (error) {
        viewer.destroy();
        throw error;
    }
}
