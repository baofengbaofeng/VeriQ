/**
 * 独立 Agent 只继承当前桌面会话所需的有限系统环境，Node 加载注入、动态库覆盖与其它 VERIQ 开发路径均不透传；固定 Node
 * 版本探针和正式拉起使用同一份环境，避免探针可信而实际后台执行了不同预加载代码。
 * 显示、会话总线与用户目录是宿主 GUI/系统凭据服务所需事实，不来自 renderer 业务参数。
 * PATH 固定为系统目录，独立引擎和浏览器始终使用已经核验的绝对物理路径。
 * 代理仅来自既有宿主配置校验结果，URL 不包含凭据，未配置则不偷偷继承另一个代理源。
 * 返回新对象而不改写主进程环境，退出窗口不会影响其它应用或系统登录设置。
 */
export function agentEnvironment(proxy: string): NodeJS.ProcessEnv {
    const allowed = [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "XDG_CURRENT_DESKTOP",
        "DBUS_SESSION_BUS_ADDRESS",
        "SystemRoot",
        "WINDIR",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "ProgramData",
    ];
    const environment: NodeJS.ProcessEnv = {};
    for (const name of allowed) if (process.env[name] !== undefined) environment[name] = process.env[name];
    environment.PATH =
        process.platform === "win32"
            ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
            : "/usr/bin:/bin:/usr/sbin:/sbin";
    if (proxy)
        Object.assign(environment, {
            HTTPS_PROXY: proxy,
            HTTP_PROXY: proxy,
            NODE_USE_ENV_PROXY: "1",
        });
    return environment;
}
