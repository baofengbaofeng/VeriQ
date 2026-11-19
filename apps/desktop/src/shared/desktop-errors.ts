import { credentialGuidance } from "./credential-status";

const guidance: Record<string, readonly [string, string]> = {
    USER_CANCELLED: ["已取消，尚未发送需要确认的操作。", "Cancelled before the protected request was sent."],
    AGENT_BUSY: [
        "后台正在准备、执行或处理其它变更，请等待完成后重试。",
        "Agent is preparing, running or changing state. Wait for completion before retrying.",
    ],
    AGENT_STOPPED: [
        "后台已停止。重新打开工作台或明确发起需要后台的操作。",
        "Agent is stopped. Reopen the workspace or explicitly request an Agent operation.",
    ],
    AGENT_UNAVAILABLE: [
        "无法连接本机后台，请检查诊断或重新打开工作台。",
        "Local Agent is unavailable. Inspect diagnostics or reopen the workspace.",
    ],
    AGENT_REQUEST_TIMEOUT: [
        "后台请求超时，结果未确认；请刷新状态，不要假定操作已回滚。",
        "Agent request timed out and its result is unconfirmed. Refresh status; rollback is not guaranteed.",
    ],
    LOCAL_RETENTION_INPUT_INVALID: [
        "请填写有效保留天数和批量上限。天数为1至3650，批量为1至100。",
        "Enter retention days from 1 to 3650 and a batch limit from 1 to 100.",
    ],
    LOCAL_RETENTION_POLICY_INVALID: [
        "保留期策略不在支持范围，请核对天数和批量。",
        "The retention policy is outside the supported range. Check days and batch size.",
    ],
    LOCAL_RETENTION_ACTIVE: [
        "仍有本机执行占用，清理被拒绝；请先停止或恢复该执行。",
        "Local execution ownership remains. Cleanup was refused; stop or recover the run first.",
    ],
    LOCAL_RETENTION_UNKNOWN_PROCESS: [
        "存在无法证明已停止的本机进程，请先完成恢复。",
        "A local process has no confirmed stop proof. Recover it before cleanup.",
    ],
    LOCAL_RETENTION_CLOCK_ROLLBACK: [
        "系统时间早于已保存的维护时间，请核对系统时钟后重试。",
        "System time is earlier than the saved maintenance clock. Correct the clock before retrying.",
    ],
    LOCAL_RETENTION_CATALOG_INVALID: [
        "本机缓存索引不完整或损坏，请保留档案并检查诊断。",
        "The local cache catalog is incomplete or damaged. Preserve the profile and inspect diagnostics.",
    ],
    LOCAL_RUN_RETIRED: [
        "这条本机历史已按保留策略退休，不能继续读取其报告正文。",
        "This local run was retired by retention policy; its report body is unavailable.",
    ],
    LOCAL_WORKSPACE_UNAVAILABLE: ["请先选择一个可访问的本机工作区。", "Choose an accessible local workspace first."],
    BUNDLE_WORKSPACE_MISMATCH: [
        "资源包不属于当前本机工作区，请重新选择。",
        "This package is not in the current local workspace. Select it again.",
    ],
    LOCAL_CACHE_MAINTENANCE_BUSY: [
        "本机资源正在读取或清理，请等待完成再试。",
        "Local resources are being read or cleaned. Wait for completion before retrying.",
    ],
    LOCAL_RETENTION_WORKSPACE_MISMATCH: [
        "本机工作区已变化，请核对当前选择后重新发起清理。",
        "The local workspace changed. Check the current selection before starting cleanup again.",
    ],
    DESKTOP_UPDATE_BUSY: [
        "仍有活动执行、准备、在线领取或另一个更新，请先结束这些操作。",
        "Execution, preparation, online polling or another update is active. Finish it first.",
    ],
    VAULT_RUNTIME_RECOVERY_REQUIRED: [
        "存在未知或未确认停止的执行，请先完成恢复；本次维护未获空闲授权。",
        "Execution stop is unknown or unconfirmed. Recover it first; idle maintenance was not authorized.",
    ],
    DESKTOP_UPDATE_KEY_UNCONFIGURED: [
        "此安装未配置发布者更新公钥，请由管理员提供可信安装材料。",
        "No publisher update key is configured. Ask the administrator for trusted installation materials.",
    ],
    DESKTOP_UPDATE_SIGNATURE_INVALID: [
        "更新清单签名不可信，不能继续安装。",
        "The update manifest signature is untrusted. Installation cannot continue.",
    ],
    DESKTOP_UPDATE_NATIVE_SIGNATURE_INVALID: [
        "安装器的系统签名或发布者身份不匹配。",
        "The installer system signature or publisher identity does not match.",
    ],
    DESKTOP_LOGIN_ITEM_UNCONFIRMED: [
        "系统未确认登录启动设置，请在操作系统设置中检查。",
        "The operating system did not confirm the login item change. Check system settings.",
    ],
    DESKTOP_PACKAGED_UPDATE_REQUIRED: [
        "请使用已安装的 VeriQ 发起更新。",
        "Start updates from an installed VeriQ application.",
    ],
};

/**
 * 桌面错误提示只从有限错误码选择可执行的中英文指引，保留机器代码供诊断但不回显异常中的路径、堆栈或系统原文；此模块没有
 * React、Electron 或 DOM 依赖，因此 main 与 renderer 可共享而不混淆宿主边界
 * 。
 */
export function desktopErrorMessage(failure: unknown, language: "zh" | "en"): string {
    const message = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
    const direct = /^[A-Z][A-Z0-9_]{2,100}(?![\s\S])/.test(message) ? message : undefined;
    const wrapped = /(?:^|: )Error: ([A-Z][A-Z0-9_]{2,100})(?![\s\S])/.exec(message)?.[1];
    const code = direct ?? wrapped ?? "DESKTOP_OPERATION_FAILED";
    if (Object.hasOwn(credentialGuidance, code))
        return `${credentialGuidance[code as keyof typeof credentialGuidance]} (${code})`;
    const known = guidance[code];
    const fallback =
        language === "zh"
            ? "操作未确认完成。请刷新状态或查看诊断；关闭界面不代表已经撤销或回滚。"
            : "Completion is unconfirmed. Refresh status or inspect diagnostics; closing the UI does not prove cance" +
              "llation or rollback.";
    return `${known?.[language === "zh" ? 0 : 1] ?? fallback} (${code})`;
}

/**
 * 本机运行与上传状态保留机器代码供诊断，同时补充固定中英文含义，未知业务状态只显示原有有限值而不猜测已经成功；该映射只
 * 用于状态投影，用户资源名、日志正文和凭据值不会进入翻译路径。
 */
export function desktopStateLabel(state: string): string {
    const names: Record<string, string> = {
        RUNNING: "执行中 / Running",
        PREPARING: "准备中 / Preparing",
        QUARANTINED: "隔离，需恢复 / Quarantined; recovery required",
        FINISHED: "执行结束 / Finished",
        CANCELLED: "已取消 / Cancelled",
        RETIRED: "已退休 / Retired",
        PENDING: "等待处理 / Pending",
        COMPLETE: "已完成 / Complete",
        FAILED: "失败 / Failed",
        PASSED: "通过 / Passed",
        UNSTABLE: "重试后通过 / Unstable",
    };
    return names[state] ? `${names[state]} (${state})` : state;
}
