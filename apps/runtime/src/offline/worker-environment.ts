import { dirname, join, isAbsolute } from "node:path";

/** 离线 worker 环境由可信 Node 宿主构造，只携带固定执行目录、provider 模块和明确选择的显示连接；页面不能传入环境变量集合，设备 token 与业务凭证不会因为可见模式而继承到子进程环境。 */
export function offlineWorkerEnvironment(
    tmp: string,
    providerModule: string,
    headless: boolean,
    trustedHost: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const display: Record<string, string> = {};
    if (!headless && process.platform === "linux") {
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
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: tmp,
        XDG_CACHE_HOME: join(tmp, "cache"),
        XDG_CONFIG_HOME: join(tmp, "config"),
        VERIQ_EXECUTION_CONTEXT_MODULE: providerModule,
    };
}
