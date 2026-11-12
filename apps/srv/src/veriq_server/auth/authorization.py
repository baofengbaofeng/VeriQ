from dataclasses import dataclass
from enum import StrEnum

from ..service import Problem


@dataclass(frozen=True)
class WorkspaceScope:
    """工作区授权边界值对象：所有嵌套引用与下载都必须绑定到同一 workspace_id；不可变 dataclass，用作后续 authorize 调用的作用域参数。
    WorkspaceScope 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    workspace_id: str


@dataclass(frozen=True)
class Actor:
    """已解析的工作区成员身份快照，携带角色与 active 状态供后续 Permission 判定使用；active=False 时任何 Permission.require 都会失败。
    Actor 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    user_id: str
    workspace_id: str
    role: str
    active: bool = True


class Permission(StrEnum):
    """工作区能力枚举：VIEW 到 OWNERSHIP 映射不同角色集合，PRIVATE_DISPATCH 由设备服务单独核验；PRIVATE_DISPATCH 角色表为空，强制走设备服务显式检查。
    Permission 实现于 apps/srv/src/veriq_server/auth/authorization.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

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
    # 设备所有权与显式授权必须由 Runtime/设备服务另行校验，角色表故意留空。
    Permission.PRIVATE_DISPATCH: set(),
}


class Authorization:
    """工作区权限门面：对照角色表拒绝越权，并拦截跨 Workspace 的嵌套引用；静态方法门面，不持有会话状态，便于在服务层复用。
    Authorization 实现于 apps/srv/src/veriq_server/auth/authorization.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    @staticmethod
    def require(actor: Actor, scope: WorkspaceScope, permission: Permission) -> None:
        """校验 Actor 仍属当前 Workspace 且角色落入目标 Permission 允许集合，否则抛出 403；同时核对 active、workspace_id 对齐与角色集合。
        require 实现于 apps/srv/src/veriq_server/auth/authorization.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if (
            not actor.active
            or actor.workspace_id != scope.workspace_id
            or actor.role not in _ROLES.get(permission, set())
        ):
            raise Problem(403, "WORKSPACE_FORBIDDEN", "Workspace permission required")

    @staticmethod
    def require_reference(scope: WorkspaceScope, referenced_workspace_id: str) -> None:
        """强制嵌套资源引用不得逃逸当前 Workspace，跨边界引用映射为 422 INVALID_REFERENCE；用于嵌套资源引用，错误码区别于权限 403。
        require_reference 实现于 apps/srv/src/veriq_server/auth/authorization.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if scope.workspace_id != referenced_workspace_id:
            raise Problem(422, "INVALID_REFERENCE", "Reference belongs to another Workspace")
