"""将工作区资源的校验、进度与发布接入对话审阅，模型只收到业务标识与冻结摘要，真实编译继续由受管工作进程负责。"""

import json
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import _schema, validate_schema
from ..credentials.registry import IdentityRegistry
from ..db import Artifact, Job, User, ValidationReceipt
from ..repositories.resource import ResourceRepository
from ..service import Problem
from ..settings import Settings
from .agent_context import UUID_IN_TEXT
from .compilation_provenance import validation_origin_matches
from .publish import PublishService
from .resource import ResourceService, document_hash
from .workspace import WorkspaceRepository

if TYPE_CHECKING:
    from .agent_tools import AgentTool, ToolExecution

RESOURCE_LIFECYCLE_ACTIONS = frozenset({"VALIDATE_RESOURCE", "PUBLISH_RESOURCE"})


def _invalid() -> Problem:
    return Problem(
        422, "AGENT_RESOURCE_INVALID", "Choose an exact resource draft and validation job"
    )


def _unavailable() -> Problem:
    return Problem(
        409, "VALIDATION_RECEIPT_UNAVAILABLE", "No matching managed validation receipt is available"
    )


def _permission(kind: str) -> Permission:
    if kind not in RESOURCE_LIFECYCLE_ACTIONS:
        raise _invalid()
    return Permission.PUBLISH if kind == "PUBLISH_RESOURCE" else Permission.EDIT


def _service(session: AsyncSession, user: User, settings: Settings) -> PublishService:
    """复用编辑器使用的身份冻结、部署数据集绑定与引擎选择，只在本次授权事务内构建快照及校验业务回执。"""
    return PublishService(
        session,
        user,
        IdentityRegistry(),
        engine_version=settings.validation_engine_version,
        settings=settings,
    )


async def authorize_resource_lifecycle(
    session: AsyncSession, scope: WorkspaceScope, user: User, action: dict[str, Any]
) -> None:
    """首次确认及回执重放均需当前资源类型的权限，尤其在环境管理员被撤权后不得凭旧轮次获得发布结果。"""
    permission = _permission(action["type"])
    await WorkspaceRepository(session, scope).authorize(user, permission, write=True)
    resource = await ResourceRepository(session, scope).resource(action["resourceId"])
    await ResourceService(session, user).authorize(scope, resource.kind, permission)


def _check_choice(action: dict[str, Any], context: dict[str, Any] | None) -> None:
    """模型只能选择目录里投影过的草稿、员工点名的资源或已确认的资源回执，目录中的基准修订不可自动更新。"""
    kind = action.get("type")
    if not isinstance(kind, str) or kind not in RESOURCE_LIFECYCLE_ACTIONS:
        raise _invalid()
    if validate_schema("AgentDraftOperations", action):
        raise _invalid()
    if context is None:
        return
    rid = action["resourceId"].lower()
    catalog = context.get("configurationCatalog", {})
    if rid in catalog:
        if action["revision"] != catalog[rid].get("revision"):
            raise _invalid()
        return
    named = {value.lower() for value in UUID_IN_TEXT.findall(context.get("request", ""))}
    previous = {
        (receipt.get("resourceId"), receipt.get("revision"))
        for item in context.get("history", [])
        if isinstance(receipt := item.get("receipt"), dict)
    }
    if rid not in named and (rid, action["revision"]) not in previous:
        raise _invalid()


async def _job_progress(repo: ResourceRepository, job: Job) -> dict[str, Any]:
    """使用不可变清单还原历史作业实际验证的资源修订，扫描状态只回传有限字段，诊断正文和连接参数始终留在服务端。"""
    if job.kind != "VALIDATE":
        raise Problem(404, "JOB_NOT_FOUND", "Validation job not found")
    # 只读取固定格式清单，先约束数据库内实际字节数，以免损坏的外键误指大制品时将整份原文载入内存。
    size = await repo.session.scalar(
        select(func.octet_length(Artifact.content)).where(
            Artifact.workspace_id == job.workspace_id, Artifact.sha256 == job.manifest_hash
        )
    )
    if size is None or size > 4096:
        raise _unavailable()
    content = (await repo.artifact(job.manifest_hash)).content
    try:
        manifest = json.loads(content)
    except (ValueError, RecursionError):
        raise _unavailable() from None
    if validate_schema("ValidateJobManifestV1", manifest) or (
        manifest["workspaceId"],
        manifest["jobId"],
        manifest["resourceId"],
    ) != (job.workspace_id, job.id, job.subject_id):
        raise _unavailable()
    result = {
        "validationJobId": job.id,
        "resourceId": job.subject_id,
        "revision": manifest["revision"],
        "sourceHash": manifest["sourceHash"],
        "state": job.state,
    }
    if job.outcome:
        result["outcome"] = job.outcome
    receipt = await repo.session.scalar(
        select(ValidationReceipt).where(
            ValidationReceipt.workspace_id == job.workspace_id, ValidationReceipt.job_id == job.id
        )
    )
    if (
        receipt
        and validation_origin_matches(job, receipt)
        and (receipt.source_hash, receipt.revision, receipt.engine_version)
        == (manifest["sourceHash"], manifest["revision"], manifest["engineVersion"])
    ):
        result["validationReceiptId"] = receipt.id
    return result


async def validation_progress(
    session: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    locator: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    """可按已有的编译作业号读取历史，或由确切草稿快照找到当前作业，同修订重试后的进度仍对应真实的独立作业。"""
    await WorkspaceRepository(session, scope).authorize(user, Permission.VIEW)
    repo = ResourceRepository(session, scope)
    if "validationJobId" in locator:
        job = await repo.job(locator["validationJobId"].lower())
    else:
        rid = locator["resourceId"].lower()
        preview = await _service(session, user, settings).preview(scope, rid)
        if preview["revision"] != locator["revision"]:
            raise Problem(409, "STALE_REVISION", "Draft revision changed; review the current draft")
        key = document_hash(
            {name: preview[name] for name in ("resourceId", "revision", "sourceHash")}
        )
        current = await session.scalar(
            select(Job).where(Job.workspace_id == scope.workspace_id, Job.validation_key == key)
        )
        if current is None:
            raise Problem(404, "JOB_NOT_FOUND", "No validation job exists for this draft")
        job = current
    return await _job_progress(repo, job)


async def prepare_resource_lifecycle(
    session: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    action: dict[str, Any],
    settings: Settings,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """审阅时冻结领域服务生成的源码摘要及受管回执，连接资源只使用保存在当前空间的配置，供应商不能提交连接凭据。"""
    _check_choice(action, context)
    rid = action["resourceId"].lower()
    service = _service(session, user, settings)
    await service.editable(scope, rid, _permission(action["type"]))
    preview = await service.preview(scope, rid)
    if preview["revision"] != action["revision"]:
        raise Problem(409, "STALE_REVISION", "Draft revision changed; review the current draft")
    prepared = {**action, "resourceId": rid, "sourceHash": preview["sourceHash"]}
    if action["type"] == "PUBLISH_RESOURCE":
        job_id = action["validationJobId"].lower()
        repo = ResourceRepository(session, scope)
        progress = await _job_progress(repo, await repo.job(job_id))
        if not progress.get("validationReceiptId") or any(
            progress[key] != prepared[key] for key in ("resourceId", "revision", "sourceHash")
        ):
            raise _unavailable()
        prepared.update(validationJobId=job_id, validationReceiptId=progress["validationReceiptId"])
    return prepared


async def apply_resource_lifecycle(
    session: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    action: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    """员工确认使用已保存的完整冻结值；队列、不可变版本和轮次回执在调用方持有安装锁的同一数据库事务内提交。"""
    kind, rid, revision = action["type"], action["resourceId"], action["revision"]
    permission = _permission(kind)
    service = _service(session, user, settings)
    if kind == "VALIDATE_RESOURCE":
        job = await service.validate(scope, rid, revision, action["sourceHash"])
        return {**action, "validationJobId": job["id"]}
    await service.editable(scope, rid, permission)
    repo = ResourceRepository(session, scope)
    receipt = await repo.receipt(action["validationReceiptId"])
    if receipt is None or (receipt.job_id, receipt.source_hash) != (
        action["validationJobId"],
        action["sourceHash"],
    ):
        raise _unavailable()
    version = await service.publish(scope, rid, revision, receipt.id)
    return {**action, "versionId": version["id"]}


async def _prepare_tool(call: "ToolExecution", args: dict[str, Any]) -> dict[str, Any]:
    """工具只准备所选修订的待确认动作，模型无权指定服务端计算的源码摘要或自行签发可发布的校验回执。"""
    return await prepare_resource_lifecycle(
        call.session, call.scope, call.user, args["proposal"], call.settings, call.context
    )


async def _progress_tool(call: "ToolExecution", args: dict[str, Any]) -> dict[str, Any]:
    """工作区查看者通过单个作业或确切草稿查询当前进度，返回结果不包含任何连接信息、编译器日志和用户源码。"""
    return await validation_progress(call.session, call.scope, call.user, args, call.settings)


def resource_lifecycle_tools() -> dict[str, "AgentTool"]:
    """注册无副作用的准备与查询入口，供应商工具形状只包含必要标识，员工确认仍由独立的事务接口处理。"""
    from .agent_tools import AgentTool

    defs = _schema()["$defs"]
    ref = {"$ref": "#/$defs/Id"}
    common = {
        "resourceId": ref,
        "revision": defs["AgentResourceDraftProposal"]["properties"]["revision"],
    }
    job = {"validationJobId": ref}

    def closed(fields: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": fields,
            "required": list(fields),
            "additionalProperties": False,
        }

    choices = [
        option
        for option in defs["AgentDraftOperations"]["oneOf"]
        if option.get("properties", {}).get("type", {}).get("const") in RESOURCE_LIFECYCLE_ACTIONS
    ]
    ids = {"Id": defs["Id"]}
    tools = (
        AgentTool(
            "prepare_resource_lifecycle_v1",
            "Prepare exact-revision validation or publication. Publication requires the successful validation job ID.",
            {**closed({"proposal": {"oneOf": choices}}), "$defs": ids},
            Permission.EDIT,
            _prepare_tool,
            "proposal",
        ),
        AgentTool(
            "get_validation_progress_v1",
            "Read one validation job or the current exact draft revision.",
            {
                "type": "object",
                "properties": {**job, **common},
                "additionalProperties": False,
                "oneOf": [closed(job), closed(common)],
                "$defs": ids,
            },
            Permission.VIEW,
            _progress_tool,
            "validation",
        ),
    )
    return {tool.name: tool for tool in tools}
