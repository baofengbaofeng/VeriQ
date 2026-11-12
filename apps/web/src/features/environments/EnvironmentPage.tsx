import { useMemo } from "react";
import type { Workspace } from "../../api";
import { ResourcePage } from "../resources/ResourcePage";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudIdentityAdapter } from "./identity-adapter";
import { IdentityManager } from "./IdentityManager";
export function EnvironmentPage() {
  return (
    <ResourcePage
      initialKind="ENVIRONMENT"
      extra={(workspace) => (
        <CloudIdentities key={workspace.id} workspace={workspace} />
      )}
    />
  );
}
function CloudIdentities({ workspace }: { workspace: Workspace }) {
  const adapter = useMemo(
      () => new CloudIdentityAdapter(workspace.id),
      [workspace.id],
    ),
    { signal } = useWorkspace();
  if (workspace.archived || !["OWNER", "ADMIN"].includes(workspace.role))
    return null;
  return (
    <IdentityManager
      adapter={adapter}
      workspaceId={workspace.id}
      signal={signal}
    />
  );
}
