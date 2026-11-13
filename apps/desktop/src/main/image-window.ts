import { BrowserWindow, nativeImage, session } from "electron";
import { randomUUID } from "node:crypto";

/** 截图预览只接收宿主已经核验过的有界图像字节，原生解码成功后转成固定 PNG 数据地址；独立窗口没有脚本、preload、平台 Cookie 或文件 URL，因此关闭后也不需要保留明文导出副本。 */
export async function openNativeImage(bytes: Uint8Array): Promise<void> {
    if (bytes.length > 32 * 1024 * 1024) throw new Error("IMAGE_SIZE_LIMIT");
    const decoded = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (decoded.isEmpty()) throw new Error("IMAGE_INVALID");
    const isolated = session.fromPartition(`veriq-image-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_content, _permission, answer) => answer(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((request, answer) =>
        answer({ cancel: !request.url.startsWith("data:") }),
    );
    const viewer = new BrowserWindow({
        title: "VeriQ · Screenshot",
        width: 1000,
        height: 750,
        webPreferences: {
            session: isolated,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
        },
    });
    viewer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    viewer.webContents.on("will-navigate", (event) => event.preventDefault());
    const document = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>VeriQ Screenshot</title></head><body style="margin:0;background:#19212d;display:flex;justify-content:center"><img alt="VeriQ evidence screenshot" style="max-width:100%;object-fit:contain" src="${decoded.toDataURL()}"></body></html>`;
    try {
        await viewer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(document));
    } catch (error) {
        viewer.destroy();
        throw error;
    }
}
