/**
 * 环境资源页：复用 ResourcePage 并固定 kind 为 ENVIRONMENT，同时挂载身份/凭证管理。与资源页共享 editorI18n。
 * Workspace 作用域与资源页相同；密钥明文不进 Query 缓存。
 */

import { useMemo } from "react";
import type { Workspace } from "../../api";
import { ResourcePage } from "../resources/ResourcePage";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudIdentityAdapter } from "./identity-adapter";
import { IdentityManager } from "./IdentityManager";
/**
 * 渲染 ResourcePage(kind=ENVIRONMENT) 并在侧栏或下方接入 IdentityManager。
 * 选中空间后 CloudIdentityAdapter 与资源适配器共用 selected。
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
