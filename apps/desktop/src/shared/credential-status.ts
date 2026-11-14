/** 凭据故障只向桌面暴露有限状态与可执行的人工指引，绝不把系统错误原文、磁盘路径或秘密拼进提示；IPC 就绪与凭据可用是不同事实，读取状态成功不能授权迁移、重建密钥或消费失败的档案。 */
export const credentialGuidance = {
    VAULT_MIGRATION_REQUIRED:
        "发现旧版凭据，请停止执行后在设置中显式迁移。 / Legacy credentials require explicit migration in Settings after stopping execution.",
    VAULT_LOCKED:
        "系统保险库已锁定，请先在操作系统中解锁，再刷新状态。 / Unlock the operating system vault, then refresh status.",
    VAULT_UNAVAILABLE:
        "系统凭据服务不可用，请恢复服务后刷新状态。 / Restore the operating system credential service, then refresh status.",
    VAULT_FAILED:
        "系统凭据访问失败，请检查系统服务和账户权限。 / Check the credential service and account permissions.",
    VAULT_KEY_MISSING:
        "档案密钥缺失。仅空初始化可以显式恢复；已激活档案不会重建密钥。 / The profile key is missing. Only empty initialization may be recovered; active profile keys are never recreated.",
    VAULT_INITIALIZATION_RECOVERY_REQUIRED:
        "空保险库初始化尚未完成，请停止执行后使用设置中的显式恢复入口。 / Stop execution and explicitly recover pending empty initialization in Settings.",
    VAULT_MUTATION_UNCONFIRMED:
        "凭据修改结果未确认，请保留档案并检查诊断，勿重复提交业务修改。 / A credential mutation is unconfirmed. Preserve the profile and inspect diagnostics before retrying.",
    VAULT_PROFILE_DELETED:
        "本机凭据档案已退役，当前档案不能重新绑定或自动初始化。 / This credential profile is retired and cannot be enrolled or initialized again.",
    VAULT_PROFILE_DELETION_REQUIRED:
        "本机凭据退役尚未完成，请继续同一档案的显式退役流程。 / Complete the pending credential retirement for this profile.",
    VAULT_DELETION_RECOVERY_REQUIRED:
        "档案保留了未完成的退役记录，请先核验并完成原操作。 / Verify and complete the existing credential retirement before using this profile.",
    CREDENTIAL_ACCESS_FAILED:
        "无法读取本机凭据，请检查系统服务、档案权限与恢复记录；当前状态不代表尚未绑定。 / Credentials could not be read. Check the service, profile permissions and recovery records; this does not mean the device is unenrolled.",
} as const;

/** 公开错误码直接取自受审提示表，新增诊断必须同时提供用户能理解的处理指引；类型不允许任意后端消息进入 renderer，从而防止错误路径意外披露凭据或宿主目录。 */
export type CredentialIssue = keyof typeof credentialGuidance;

/** 只接受提示表中的完整消息作为稳定凭据状态，未知异常统一投影为明确失败；调用方仍须保留原业务操作的拒绝行为，不能利用状态投影吞掉其它存储或执行错误。 */
export function credentialIssue(error: unknown): CredentialIssue {
    return error instanceof Error && Object.hasOwn(credentialGuidance, error.message)
        ? (error.message as CredentialIssue)
        : "CREDENTIAL_ACCESS_FAILED";
}

/** 主进程切换控制源前必须确认独立后台既无执行占用也无已登记设备，凭据不可读时同样无法确认可安全切换；拒绝沿用原有稳定错误码，确保失败发生在普通会话失效、设置写盘和停止后台之前。 */
export function assertAgentReconfigurationAllowed(state: Record<string, unknown>): void {
    if (state.active || state.online || state.device || state.credentialError)
        throw new Error("UNBIND_DEVICE_BEFORE_ORIGIN_CHANGE");
}
