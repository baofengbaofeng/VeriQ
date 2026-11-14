/** 桌面来源检查只接受当前窗口拥有的顶层框架和随包固定文档，窗口编号、框架身份与 URL 必须同时匹配；协议名称本身不能证明调用者具有本机控制权限。 */
/** 授权依赖当前 BrowserWindow 的实际 webContents 与主 frame 对象身份，而不是 renderer 提供的布尔值或可复制字符串；同 URL 的其它窗口和页面中的子框架均不得继承桌面桥接能力。
 * webContents id 排除另一个窗口及已经替换的窗口实例。
 * frame 比较使用 Electron 传入的真实对象，排除同来源子框架。
 * 入口 URL 必须精确等于随包 index.html，不接受路径前缀匹配。
 * 同一窗口导航到其它页面后，即使仍有旧 preload 引用也会被拒绝。
 * 该函数不依赖用户角色，因为窗口身份检查先于后续业务权限检查。
 * 预加载脚本只负责缩小可见能力，不能替代主进程再次验证 sender。
 * 调用者不得把 renderer 传入的 id、frame 或 URL 填入当前窗口上下文。
 */
export function authorizeSender(
    actual: { id: number; frame: unknown; url: string },
    expected: { id: number; frame: unknown },
): void {
    if (
        actual.id !== expected.id ||
        actual.frame !== expected.frame ||
        actual.url !== "veriq://app/index.html"
    )
        throw new Error("IPC_SENDER_DENIED");
}
