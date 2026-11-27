import type { PlatformComponents } from "@veriq/contracts";
import { useAppLocale } from "../../locale";
import { formLabel } from "./workspace-forms";

type Receipt = PlatformComponents["schemas"]["AgentWorkspaceFormReceipt"];

const labels: Record<string, [string, string]> = {
    "resource.created": ["已创建资源", "Resource created"],
    "resource.draft_updated": ["已保存草稿", "Draft saved"],
    "resource.updated": ["已更新资源", "Resource updated"],
    "resource.validation_queued": ["已提交资源校验", "Resource validation queued"],
    "resource.published": ["已发布资源版本", "Resource version published"],
    "dataset.copied": ["已复制数据集", "Dataset copied"],
    "credential.version.created": ["已创建凭证版本", "Credential version created"],
    "credential.version.revoked": ["已撤销凭证版本", "Credential version revoked"],
    "auth_adapter.created": ["已创建认证适配器版本", "Authentication adapter version created"],
    "auth_adapter.revoked": ["已撤销认证适配器版本", "Authentication adapter version revoked"],
    "runtime.enrolled": ["已批准设备", "Device approved"],
    "runtime.grants_changed": ["已更新设备共享", "Device sharing updated"],
    "runtime.trust_changed": ["已更新设备信任设置", "Device trust settings updated"],
    "runtime.revoked": ["已撤销设备", "Device revoked"],
    "runtime.credential_delivery_changed": ["已更新设备凭证投递", "Device credential delivery updated"],
    "service_account.created": ["已创建服务账号", "Service account created"],
    "service_account.disabled": ["已停用服务账号", "Service account disabled"],
    "service_token.issued": ["已签发令牌", "Token issued"],
    "service_token.revoked": ["已撤销令牌", "Token revoked"],
    "workspace.invited": ["已创建邀请", "Invitation created"],
    "workspace.invitation_revoked": ["已撤销邀请", "Invitation revoked"],
    "workspace.member_updated": ["已更新成员角色或状态", "Member role or status updated"],
    "workspace.member_removed": ["已移除成员", "Member removed"],
    "ai.provider_configured": ["已保存模型供应商设置", "Model provider settings saved"],
    "ai.provider_deleted": ["已删除模型供应商", "Model provider deleted"],
    "notification.read": ["已标记通知为已读", "Notification marked as read"],
    "notification.invitation_accepted": ["已接受工作区邀请", "Workspace invitation accepted"],
    "workspace.archived": ["已归档工作区", "Workspace archived"],
};

export function FormReceipts({ items }: { items: Receipt[] }) {
    const { language } = useAppLocale();
    const zh = language === "zh";
    return (
        <section aria-label={zh ? "已确认的表单操作" : "Confirmed form operations"}>
            <ul>
                {items.map((item) => (
                    <li key={item.id}>
                        {labels[item.action]?.[zh ? 0 : 1] ?? formLabel(item.capability, language)}
                        {item.revision != null && (zh ? ` · 修订 ${item.revision}` : ` · revision ${item.revision}`)}
                        <details>
                            <summary>{zh ? "操作详情" : "Operation details"}</summary>
                            <code>{item.targetId}</code>
                            {" · "}
                            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(language)}</time>
                        </details>
                    </li>
                ))}
            </ul>
        </section>
    );
}
