/**
 * 本文件 apps/web/src/features/environments/EnvironmentPage.tsx 实现 VeriQ Web/共享 UI 界面能力并导出公开组件与辅助函数
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 */

import { useMemo } from "react";
import type { Workspace } from "../../api";
import { ResourcePage } from "../resources/ResourcePage";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudIdentityAdapter } from "./identity-adapter";
import { IdentityManager } from "./IdentityManager";
/**
 * 公开符号 EnvironmentPage（function）定义 apps/web/src/features/environments/EnvironmentPage.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 */
export function EnvironmentPage() {
    return (
        <ResourcePage
            initialKind="ENVIRONMENT"
            extra={(workspace) => <CloudIdentities key={workspace.id} workspace={workspace} />}
        />
    );
}
function CloudIdentities({ workspace }: { workspace: Workspace }) {
    const adapter = useMemo(() => new CloudIdentityAdapter(workspace.id), [workspace.id]),
        { signal } = useWorkspace();
    if (workspace.archived || !["OWNER", "ADMIN"].includes(workspace.role)) return null;
    return <IdentityManager adapter={adapter} workspaceId={workspace.id} signal={signal} />;
}
