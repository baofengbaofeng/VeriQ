"""Reusable deny-by-default policy for Workspace-scoped services and repositories."""

from dataclasses import dataclass
from enum import StrEnum

from ..service import Problem


@dataclass(frozen=True)
class WorkspaceScope:
    workspace_id: str


@dataclass(frozen=True)
class Actor:
    user_id: str
    workspace_id: str
    role: str
    active: bool = True


class Permission(StrEnum):
    VIEW = "view"
    EDIT = "edit"
    EXECUTE = "execute"
    DOWNLOAD = "download"
    PUBLISH = "publish"
    MANAGE_ENVIRONMENT = "manage_environment"
    MANAGE_MEMBERS = "manage_members"
    MANAGE_WORKSPACE = "manage_workspace"
    OWNERSHIP = "ownership"
    PRIVATE_DISPATCH = "private_dispatch"


_ROLES = {
    Permission.VIEW: {"OWNER", "ADMIN", "EDITOR", "EXECUTOR", "VIEWER"},
    Permission.EDIT: {"OWNER", "ADMIN", "EDITOR"},
    Permission.EXECUTE: {"OWNER", "ADMIN", "EDITOR", "EXECUTOR"},
    Permission.DOWNLOAD: {"OWNER", "ADMIN", "EDITOR", "EXECUTOR"},
    Permission.PUBLISH: {"OWNER", "ADMIN"},
    Permission.MANAGE_ENVIRONMENT: {"OWNER", "ADMIN"},
    Permission.MANAGE_MEMBERS: {"OWNER", "ADMIN"},
    Permission.MANAGE_WORKSPACE: {"OWNER", "ADMIN"},
    Permission.OWNERSHIP: {"OWNER"},
    # Device ownership/explicit grants must be checked by the device service.
    Permission.PRIVATE_DISPATCH: set(),
}


class Authorization:
    @staticmethod
    def require(actor: Actor, scope: WorkspaceScope, permission: Permission) -> None:
        if (
            not actor.active
            or actor.workspace_id != scope.workspace_id
            or actor.role not in _ROLES.get(permission, set())
        ):
            raise Problem(403, "WORKSPACE_FORBIDDEN", "Workspace permission required")

    @staticmethod
    def require_reference(scope: WorkspaceScope, referenced_workspace_id: str) -> None:
        if scope.workspace_id != referenced_workspace_id:
            raise Problem(422, "INVALID_REFERENCE", "Reference belongs to another Workspace")
