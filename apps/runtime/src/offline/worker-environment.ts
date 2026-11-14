import { dirname, join, isAbsolute, win32, delimiter } from "node:path";

/** 离线 worker 环境由可信 Node 宿主构造，只携带固定执行目录、provider 模块和明确选择的显示连接；页面不能传入环境变量集合，设备 token 与业务凭证不会因为可见模式而继承到子进程环境。 */
export function offlineWorkerEnvironment(
    tmp: string,
    providerModule: string,
    headless: boolean,
    trustedHost: NodeJS.ProcessEnv = process.env,
    execution: { platform?: NodeJS.Platform; runnerExecutable?: string } = {},
): Record<string, string> {
    const platform = execution.platform ?? process.platform;
    const executable = execution.runnerExecutable ?? process.execPath;
    /** Windows 的系统目录只从可信宿主读取并校验为本地盘符绝对路径，浏览器启动所需的系统变量显式列举；禁止沿用整个宿主 PATH 或把设备凭证、加载器选项带入业务 worker。 */
    if (platform === "win32") {
        const system = trustedHost.SystemRoot ?? trustedHost.SYSTEMROOT;
        if (
            !system ||
            !/^[A-Za-z]:\\/.test(system) ||
            system.length > 260 ||
            /[\x00-\x1f\x7f;]/.test(system)
        )
            throw new Error("WINDOWS_SYSTEM_ROOT_INVALID");
        return {
            SystemRoot: system,
            WINDIR: system,
            PATH: [win32.dirname(executable), win32.join(system, "System32")].join(";"),
            TEMP: tmp,
            TMP: tmp,
            VERIQ_EXECUTION_CONTEXT_MODULE: providerModule,
        };
    }
    const display: Record<string, string> = {};
    if (!headless && platform === "linux") {
        const value = trustedHost.DISPLAY;
        if (
            !value ||
            !/^:[0-9]{1,5}(?:\.[0-9]{1,2})?$/.test(value) ||
            Array.from(value).some(
                (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
            )
        )
            throw new Error("VISIBLE_DISPLAY_UNAVAILABLE");
        display.DISPLAY = value;
        const authority = trustedHost.XAUTHORITY;
        if (authority !== undefined) {
            if (
                !isAbsolute(authority) ||
                authority.length > 4096 ||
                Array.from(authority).some(
                    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                )
            )
                throw new Error("VISIBLE_AUTHORITY_INVALID");
            display.XAUTHORITY = authority;
        }
    }
    return {
        ...display,
        PATH: [dirname(executable), "/usr/bin", "/bin"].join(delimiter),
        TMPDIR: tmp,
        XDG_CACHE_HOME: join(tmp, "cache"),
        XDG_CONFIG_HOME: join(tmp, "config"),
        VERIQ_EXECUTION_CONTEXT_MODULE: providerModule,
    };
}
