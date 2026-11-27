"""把模型可推荐的表单限制在已实现的产品界面；当前空间授权只决定是否交付入口，真正写入仍由领域表单确认。"""

from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..db import User
from ..service import Problem
from .workspace import WorkspaceRepository

if TYPE_CHECKING:
    from .agent_tools import AgentTool, ToolExecution


# 写入类表单必须在可写空间内打开；只读报告、个人收件箱及本机保留期另有各自的数据范围和最终检查。
_FORMS = {
    "ENVIRONMENT": (Permission.MANAGE_ENVIRONMENT, True),
    "FIXTURE": (Permission.EDIT, True),
    "HTTP_DATASET": (Permission.EDIT, True),
    "AUTH_CREDENTIALS": (Permission.MANAGE_ENVIRONMENT, True),
    "DEVICE_ACCESS": (Permission.EXECUTE, True),
    "DEVICE_CREDENTIAL_DELIVERY": (Permission.MANAGE_ENVIRONMENT, True),
    "CI_PLAN_TOKENS": (Permission.MANAGE_WORKSPACE, True),
    "WORKSPACE_MEMBERS": (Permission.MANAGE_MEMBERS, True),
    "AI_PROVIDERS": (Permission.MANAGE_WORKSPACE, True),
    "NOTIFICATION_INBOX": (Permission.VIEW, False),
    "WORKSPACE_ARCHIVE": (Permission.OWNERSHIP, True),
    "REPORT_EVIDENCE": (Permission.MANAGE_ENVIRONMENT, False),
    "WORKSPACE_AUDIT": (Permission.VIEW, False),
    "LOCAL_RETENTION": (Permission.VIEW, False),
}
CAPABILITY_IDS = tuple(_FORMS)


async def workspace_form_card(
    session: AsyncSession, scope: WorkspaceScope, user: User, capability: str
) -> dict[str, str]:
    """根据当前成员、归档状态和表单类型重新建立卡片；员工归属的会话及轮次由调用方从可信存储取出。"""
    if not isinstance(capability, str) or capability not in _FORMS:
        raise Problem(422, "AGENT_CAPABILITY_INVALID", "Select a supported workspace form")
    permission, writable = _FORMS[capability]
    await WorkspaceRepository(session, scope).authorize(user, permission, write=writable)
    return {
        "type": "OPEN_WORKSPACE_FORM",
        "workspaceId": scope.workspace_id,
        "capability": capability,
    }


async def _open_form(call: "ToolExecution", arguments: dict[str, Any]) -> dict[str, Any]:
    """沿用真实短事务中的员工身份及工作区，模型不能指定接收人、目标空间、请求地址或操作参数。"""
    return await workspace_form_card(call.session, call.scope, call.user, arguments["capability"])


def workspace_form_tool() -> "AgentTool":
    """向两个模型协议注册同一只读操作，敏感输入只在原生领域表单中填写，签发令牌和下载均须另外授权。"""
    from .agent_tools import AgentTool

    return AgentTool(
        name="open_workspace_form_v1",
        description=(
            "Offer one existing employee form; this does not perform an action. Use for environment "
            "versions, fixture definitions, connected HTTP datasets, credential versions/bindings, "
            "device approval/sharing or credential delivery, CI plan tokens, members, provider budgets, "
            "personal notifications, workspace archive, restricted report evidence, workspace audit, "
            "or this device's local retention settings. Never request credentials or a URL."
        ),
        parameters={
            "type": "object",
            "properties": {"capability": {"type": "string", "enum": list(CAPABILITY_IDS)}},
            "required": ["capability"],
            "additionalProperties": False,
        },
        permission=Permission.VIEW,
        handler=_open_form,
        result_kind="workspace_form",
    )
