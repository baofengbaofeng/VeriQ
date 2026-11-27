"""让员工一次审阅同一空间内相互独立的资源草稿，依赖仍引用已发布版本，各项写入和确认回执共用原有事务。"""

from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import _schema, canonical_bytes, validate_schema
from ..db import User
from ..service import Problem
from .agent_resource_drafts import (
    MAX_RESOURCE_PROPOSAL_BYTES,
    prepare_resource_draft,
    save_resource_draft,
)
from .ai import sanitize

if TYPE_CHECKING:
    from .agent_tools import AgentTool, ToolExecution

RESOURCE_BATCH_ACTION = "SAVE_RESOURCE_DRAFTS"


def _items(value: object) -> list[dict[str, Any]]:
    """按整组序列化字节、数量和公开契约限制全文；同一资源标识或同一类型的键只能出现一次，消除执行顺序歧义。"""
    try:
        if not isinstance(value, dict) or len(canonical_bytes(value)) > MAX_RESOURCE_PROPOSAL_BYTES:
            raise ValueError
        if validate_schema("AgentResourceBatchProposal", value):
            raise ValueError
    except (ValueError, TypeError, RecursionError):
        raise Problem(
            422, "AGENT_RESOURCE_BATCH_INVALID", "Review two to five complete draft changes"
        ) from None
    items: list[dict[str, Any]] = value["items"]
    resources = [item["resourceId"].lower() for item in items if "resourceId" in item]
    keys = [(item["resource"]["kind"], item["resource"]["key"]) for item in items]
    if len(set(resources)) != len(resources) or len(set(keys)) != len(keys):
        raise Problem(
            422, "AGENT_RESOURCE_BATCH_DUPLICATE", "Choose distinct resources and draft keys"
        )
    return items


async def prepare_resource_batch(
    session: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    value: object,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """逐项调用原有准备流程复核文档、依赖与当前成员权限，员工审阅的顺序同时决定成功回执中的资源顺序。"""
    items = [
        await prepare_resource_draft(session, scope, user, item, context) for item in _items(value)
    ]
    return {"type": RESOURCE_BATCH_ACTION, "items": items}


async def save_resource_batch(
    session: AsyncSession, scope: WorkspaceScope, user: User, action: dict[str, Any]
) -> dict[str, Any]:
    """组内任何一次领域写入失败即回滚全部草稿和审计，即使调用方保留外层事务记录拒绝结果也不会留下部分更改。"""
    items = _items(action)
    async with session.begin_nested():
        receipts = [await save_resource_draft(session, scope, user, item) for item in items]
    return {"type": RESOURCE_BATCH_ACTION, "items": receipts}


async def _prepare_tool(call: "ToolExecution", args: dict[str, Any]) -> dict[str, Any]:
    """整组包含供应商密钥或需要遮蔽的内容时直接拒绝，避免把已经替换值的草稿作为员工最初审阅的配置。"""
    proposal = args["proposal"]
    if sanitize(proposal, call.protected) != proposal:
        raise Problem(
            422, "AGENT_RESOURCE_INVALID", "Remove secrets from the proposed configuration"
        )
    return await prepare_resource_batch(call.session, call.scope, call.user, proposal, call.context)


def resource_batch_tool() -> "AgentTool":
    """沿用单项模型草稿的有界文档描述和公用标识约束，工具只能产生审阅卡，模型调用本身不修改任何草稿。"""
    from .agent_tools import AgentTool, resource_model_schema

    defs = _schema()["$defs"]
    definitions = {
        key: defs[key]
        for key in ("Id", "Key", "AgentConfigurableResourceKind", "AgentResourceBatchProposal")
    }
    definitions["AgentResourceDraftProposal"] = resource_model_schema()
    return AgentTool(
        "prepare_resource_batch_v1",
        "Prepare two to five complete related resource drafts for one atomic employee confirmation.",
        {
            "type": "object",
            "properties": {"proposal": {"$ref": "#/$defs/AgentResourceBatchProposal"}},
            "required": ["proposal"],
            "additionalProperties": False,
            "$defs": definitions,
        },
        Permission.EDIT,
        _prepare_tool,
        "resource_batch_proposal",
    )
