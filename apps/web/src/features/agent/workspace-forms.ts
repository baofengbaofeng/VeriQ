/**
 * 会话卡片只携带枚举；宿主使用这里的产品路由或桌面标签，供应商不能设置地址、请求方法、本机路径或表单值。
 */
import type { PlatformComponents } from "@veriq/contracts";

export type WorkspaceFormCard = PlatformComponents["schemas"]["AgentWorkspaceForm"];
export type WorkspaceCapability = WorkspaceFormCard["capability"];

const forms = {
    ENVIRONMENT: ["配置执行环境", "Configure execution environments", "/resources/environments"],
    FIXTURE: ["编辑测试夹具", "Edit test fixtures", "/resources/fixtures"],
    HTTP_DATASET: ["配置 HTTP 数据集", "Configure HTTP datasets", "/resources/datasets"],
    AUTH_CREDENTIALS: [
        "管理身份与固定凭证版本",
        "Manage identities and credential versions",
        "/workspaces?tab=auth-credentials",
    ],
    DEVICE_ACCESS: ["管理设备批准和共享", "Manage device approval and sharing", "/runtimes"],
    DEVICE_CREDENTIAL_DELIVERY: ["查看设备凭证投递设置", "Review device credential delivery", "/runtimes"],
    CI_PLAN_TOKENS: ["管理 CI 服务账号和计划令牌", "Manage CI service accounts and plan tokens", "/execution-plans"],
    WORKSPACE_MEMBERS: ["管理工作区成员和角色", "Manage workspace members and roles", "/workspaces?tab=members"],
    AI_PROVIDERS: ["管理模型供应商和预算", "Manage model providers and budgets", "/workspaces?tab=ai-providers"],
    NOTIFICATION_INBOX: ["查看我的通知", "View my notifications", "/notifications"],
    WORKSPACE_ARCHIVE: ["查看工作区归档设置", "Review workspace archive settings", "/workspaces"],
    REPORT_EVIDENCE: ["查看报告证据下载", "Review report evidence downloads", "/reports"],
    WORKSPACE_AUDIT: ["查看工作区审计记录", "View workspace audit records", "/reports"],
    LOCAL_RETENTION: ["查看本机保留期清理设置", "Review this device’s retention settings", null],
} as const satisfies Record<WorkspaceCapability, readonly [string, string, string | null]>;
export type WorkspaceFormDestination =
    | { platform: "web"; workspaceId: string; href: string }
    | {
          platform: "desktop";
          workspaceId: string;
          tab: "resources";
          resourceKind: "ENVIRONMENT" | "FIXTURE" | "DATASET";
      }
    | { platform: "desktop"; workspaceId: string; tab: "management"; href: string }
    | { platform: "desktop"; workspaceId: string; tab: "reports" | "settings" };

export type WorkspaceFormPlatform = WorkspaceFormDestination["platform"];
export type WorkspaceFormReference = {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    capability: WorkspaceCapability;
};
export type FormLauncher = {
    platform: WorkspaceFormPlatform;
    open: (
        destination: WorkspaceFormDestination,
        ref: WorkspaceFormReference,
        signal: AbortSignal,
        onClose: () => void,
    ) => void;
};

const scopedPaths = new Set(
    Object.values(forms)
        .map(([, , path]) => path?.split("?")[0])
        .filter((path) => !!path && path !== "/notifications"),
);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/**
 * 仅对域内已实现的工作区表单承认来源标记；个人收件箱遵循员工身份，本机缓存使用桌面资料而非工作区地址。
 */
export function isScopedFormPath(path: string) {
    return scopedPaths.has(path);
}

/**
 * 读取历史轮次时也核对形状，旧数据或未经认可的枚举不能生成按钮；忽略原型链避免把对象方法误当产品能力。
 */
export function isWorkspaceFormCard(value: unknown): value is WorkspaceFormCard {
    if (!value || typeof value !== "object") return false;
    return (
        "type" in value &&
        value.type === "OPEN_WORKSPACE_FORM" &&
        "workspaceId" in value &&
        typeof value.workspaceId === "string" &&
        uuid.test(value.workspaceId) &&
        "capability" in value &&
        typeof value.capability === "string" &&
        Object.hasOwn(forms, value.capability)
    );
}

/**
 * 标签对应推荐的具体动作，只标识业务入口，最终选项、可用资源及确认状态均由已登录的领域表单显示。
 */
export function formLabel(capability: WorkspaceCapability, language: "zh" | "en") {
    return forms[capability][language === "zh" ? 0 : 1];
}

/**
 * 两个宿主共用固定页面映射；桌面资源、证据及保留设置另用原生视图。
 */
export function formDestination(
    card: WorkspaceFormCard,
    platform: WorkspaceFormPlatform,
): WorkspaceFormDestination | undefined {
    if (!isWorkspaceFormCard(card)) return;
    const { workspaceId, capability } = card;
    if (platform === "desktop") {
        switch (capability) {
            case "ENVIRONMENT":
            case "FIXTURE":
                return { platform, workspaceId, tab: "resources", resourceKind: capability };
            case "HTTP_DATASET":
                return { platform, workspaceId, tab: "resources", resourceKind: "DATASET" };
            case "REPORT_EVIDENCE":
            case "WORKSPACE_AUDIT":
                return { platform, workspaceId, tab: "reports" };
            case "LOCAL_RETENTION":
                return { platform, workspaceId, tab: "settings" };
        }
    }
    const path = forms[capability][2];
    if (!path) return;
    const query = new URLSearchParams({ workspaceId, fromAgentForm: "1" });
    const href = capability === "NOTIFICATION_INBOX" ? path : `${path}${path.includes("?") ? "&" : "?"}${query}`;
    return platform === "web" ? { platform, workspaceId, href } : { platform, workspaceId, tab: "management", href };
}

/**
 * 打开前回读当前私有轮次；响应归属、卡片枚举或界面生命期变化时丢弃本次导航，新的工作区不继承旧意图。
 */
export async function authorizedFormDestination(
    card: WorkspaceFormCard,
    workspaceId: string,
    platform: WorkspaceFormPlatform,
    signal: AbortSignal,
    authorize: () => Promise<WorkspaceFormCard>,
) {
    if (
        signal.aborted ||
        !isWorkspaceFormCard(card) ||
        card.workspaceId !== workspaceId ||
        !formDestination(card, platform)
    )
        return;
    const current = await authorize();
    if (signal.aborted) return;
    if (
        !isWorkspaceFormCard(current) ||
        current.workspaceId !== workspaceId ||
        current.capability !== card.capability
    ) {
        throw new Error("AGENT_FORM_CHANGED");
    }
    return formDestination(current, platform);
}
