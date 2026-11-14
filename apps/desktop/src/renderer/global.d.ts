import type { DesktopBridge } from "../shared/bridge";
/** 桌面页面只认识 preload 中声明的有限能力，类型不提供 Node、IPC 原对象或任意网络代理；宿主验证是实际权限边界，这个声明只帮助业务组件正确使用同一份契约。 */
declare global {
    interface Window {
        veriq: DesktopBridge;
    }
}
