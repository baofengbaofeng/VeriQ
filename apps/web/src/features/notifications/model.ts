/**
 * 通知界面引用生成契约，因此后端新增或删除业务字段会在编译阶段暴露，浏览器不会推断授权状态或深链接地址。
 */
import type { PlatformComponents } from "@veriq/contracts";

type Schemas = PlatformComponents["schemas"];

/**
 * 列表和详情都使用服务端授权后的联合通知类型，点击动作按事件类型读取对应标识，而非页面内容中的任意文本。
 */
export type InboxNotification = Schemas["NotificationDTO"];

/**
 * 邀请状态限定快捷操作，通知 ID 绑定所属账户，前端无需读取或传输签发时创建的邀请凭证。
 */
export type InvitationNotification = Schemas["NotificationWorkspaceInviteDTO"];

/**
 * 回复定位和展示确认共用工作区、会话和轮次标识，实际回复仍通过既有 Agent 历史接口读取。
 */
export type AgentNotificationTarget = Schemas["NotificationAgentSeenRequest"];

/**
 * 所有分页共享授权收件箱的未读计数和投递水位，全部已读以最近一次成功读取的水位限定批量写入范围。
 */
export type InboxPage = Schemas["NotificationInboxDTO"];

/**
 * 等待中的邀请会随时间到期而没有新事件，只在展示该视图时以慢速间隔复核状态，有事件的变更继续走订阅。
 */
export function invitationRefreshInterval(rows: readonly InboxNotification[] = []): number | false {
    return rows.some((row) => row.kind === "WORKSPACE_INVITED" && row.invitationStatus === "PENDING") ? 30_000 : false;
}
