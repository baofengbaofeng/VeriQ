import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/bridge";

/** preload 仅把逐项列举的业务方法放入隔离世界，Electron 原始 IPC 与 Node 模块不暴露给页面；宿主仍会对每个请求重新验证来源和正文，不能把类型声明当成授权证明。 */
const bridge: DesktopBridge = {
    state: () => ipcRenderer.invoke("veriq:desktop", "state"),
    configure: (origin, proxy) =>
        ipcRenderer.invoke("veriq:desktop", "configure", { origin, proxy }),
    login: (data) => ipcRenderer.invoke("veriq:desktop", "login", data),
    logout: () => ipcRenderer.invoke("veriq:desktop", "logout"),
    workspaces: () => ipcRenderer.invoke("veriq:desktop", "workspaces"),
    select: (workspaceId) => ipcRenderer.invoke("veriq:desktop", "select", { workspaceId }),
    cloud: (operation) => ipcRenderer.invoke("veriq:desktop", "cloud", operation),
    local: (operation) => ipcRenderer.invoke("veriq:desktop", "local", operation),
    streamOpen: (operation) => ipcRenderer.invoke("veriq:desktop", "streamOpen", operation),
    streamPull: (id) => ipcRenderer.invoke("veriq:desktop", "streamPull", { id }),
    streamClose: (id) => ipcRenderer.invoke("veriq:desktop", "streamClose", { id }),
    artifact: (input) => ipcRenderer.invoke("veriq:desktop", "artifact", input),
    lifecycle: (action) => ipcRenderer.invoke("veriq:desktop", "lifecycle", { action }),
    directory: () => ipcRenderer.invoke("veriq:desktop", "directory"),
};
contextBridge.exposeInMainWorld("veriq", Object.freeze(bridge));
