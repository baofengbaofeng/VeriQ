"""把对话中的资源配置约束为有界、可审阅的草稿，候选与确认都复用当前空间授权及资源领域服务。"""

from typing import Any

from jsonschema import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import WorkspaceScope
from ..contracts import _schema, canonical_bytes
from ..db import User, Resource, ResourceDraft, ResourceVersion
from ..repositories.resource import ResourceRepository
from ..service import Problem
from ..validation import validate_api
from .agent_context import UUID_IN_TEXT
from .ai import sanitize
from .resource import ResourceService, asset_references, check_document

RESOURCE_ACTION = "SAVE_RESOURCE_DRAFT"
CONFIGURABLE_KINDS = tuple(_schema()["$defs"]["AgentConfigurableResourceKind"]["enum"])
MAX_RESOURCE_PROPOSAL_BYTES = 32768
MAX_DISCOVERY_RESULTS = 8
MAX_DRAFT_PROJECTION_BYTES = 2500


def _invalid() -> Problem:
    """模型输入不符合资源配置工具支持的形状时返回稳定错误，不把无效文档或未知字段的值传回供应商。"""
    return Problem(
        422, "AGENT_RESOURCE_INVALID", "Choose a supported draft and review its full configuration"
    )


def _source_allowed(content: dict[str, Any]) -> bool:
    """连接数据集含凭据及端点，其他文档中敏感字段也可能承载原始业务数据，所以由资源编辑器单独处理。"""
    return bool(
        content["document"].get("source", {}).get("kind") != "HTTP" and sanitize(content) == content
    )


async def _require_references(
    s: AsyncSession, scope: WorkspaceScope, content: dict[str, Any]
) -> None:
    """一次查询校验文档中的直接依赖均为当前空间的活动发布版本，既有发布流程仍负责递归冻结及编译。"""
    references = asset_references(content)
    if not references:
        return
    query = (
        select(ResourceVersion.id, ResourceVersion.kind)
        .join(Resource, Resource.id == ResourceVersion.resource_id)
        .where(
            ResourceVersion.workspace_id == scope.workspace_id,
            Resource.workspace_id == scope.workspace_id,
            Resource.status != "ARCHIVED",
            Resource.kind == ResourceVersion.kind,
            ResourceVersion.id.in_({rid for rid, _ in references}),
        )
    )
    if not set(references) <= set((await s.execute(query)).tuples().all()):
        raise Problem(
            422, "AGENT_RESOURCE_REFERENCE_INVALID", "A referenced published version is unavailable"
        )


def _candidate_ids(context: dict[str, Any]) -> tuple[set[str], set[str]]:
    """仅用已投影的资源元数据和员工主动点名的标识确认选择，其他轮次留存全文不能扩大供应商的候选范围。"""
    explicit = {match.lower() for match in UUID_IN_TEXT.findall(context.get("request", ""))}
    catalog = context.get("configurationCatalog", {})
    resources = {item["resourceId"] for item in catalog.values()}
    versions = {a["versionId"] for a in context["assets"]}
    versions.update(item["versionId"] for item in catalog.values() if "versionId" in item)
    return resources | explicit, versions | explicit | set(
        context.get("configurationDraftVersions", [])
    )


def _draft_projection(content: dict[str, Any]) -> dict[str, Any]:
    """精确查找只投影配置结构，套件成员可完整分享；数据表行值、用例参数和其他草稿字段仍留在领域服务。"""
    kind, doc = content["kind"], content["document"]
    if kind == "SUITE" and len(canonical_bytes(content)) <= MAX_DRAFT_PROJECTION_BYTES:
        return {"content": content}
    if kind == "DATASET":
        fields = doc.get("fields", doc.get("columns", {}))
        rows = doc.get("source", {}).get("rows", doc.get("rows", []))
        return {
            "shape": doc.get("shape", "TABLE"),
            "fields": dict[str, Any](list(fields.items())[:16]),
            "rowCount": len(rows),
        }
    if kind in {"CASE", "FLOW"}:
        return {
            "steps": [{"id": step["id"], "action": step["action"]} for step in doc["steps"][:12]]
        }
    return {}


async def _exact_draft_projection(
    s: AsyncSession, scope: WorkspaceScope, rid: str, context: dict[str, Any], protected: set[str]
) -> dict[str, Any]:
    """单个草稿即使匹配查找目标，也只在范围、数据类型和保护值检查通过时向当前模型投递有界的结构。"""
    content = (await ResourceRepository(s, scope).draft(rid)).document_json
    if not _source_allowed(content) or sanitize(content, protected) != content:
        return {}
    projection = _draft_projection(content)
    if len(canonical_bytes(projection)) > MAX_DRAFT_PROJECTION_BYTES:
        return {}
    if "content" in projection:
        await _require_references(s, scope, content)
        context.setdefault("configurationDraftVersions", []).extend(
            v for v, _ in asset_references(content)
        )
    return projection


async def find_configuration(
    s: AsyncSession,
    scope: WorkspaceScope,
    arguments: dict[str, Any],
    context: dict[str, Any],
    protected: set[str],
) -> dict[str, Any]:
    """按空间与类型查找有界配置元数据；只记住实际提供给模型的资源及版本，避免用截掉候选准备后续草稿。"""
    query = (
        select(
            Resource.id.label("resourceId"),
            Resource.kind,
            Resource.key,
            Resource.name,
            Resource.latest_version_id.label("versionId"),
            ResourceDraft.revision,
        )
        .outerjoin(
            ResourceDraft,
            (ResourceDraft.resource_id == Resource.id)
            & (ResourceDraft.workspace_id == Resource.workspace_id),
        )
        .where(Resource.workspace_id == scope.workspace_id, Resource.status != "ARCHIVED")
        .order_by(Resource.kind, Resource.key, Resource.id)
        .limit(MAX_DISCOVERY_RESULTS)
    )
    if "kind" in arguments:
        query = query.where(Resource.kind == arguments["kind"])
    if "query" in arguments:
        term = arguments["query"].strip()
        query = query.where(
            or_(
                Resource.key.contains(term, autoescape=True),
                Resource.name.contains(term, autoescape=True),
            )
        )
    if "resourceId" in arguments:
        query = query.where(Resource.id == arguments["resourceId"].lower())
    items = []
    for row in (await s.execute(query)).mappings():
        item = {field: value for field, value in row.items() if value is not None}
        if row["kind"] not in CONFIGURABLE_KINDS:
            item.pop("revision", None)
        items.append(item)
    filtered = sanitize({"items": items}, protected)
    if not isinstance(filtered, dict):
        return {"items": []}
    result: dict[str, Any] = {
        "items": [
            item
            for item in filtered["items"]
            if isinstance(item, dict) and UUID_IN_TEXT.fullmatch(item["resourceId"])
        ]
    }
    catalog = context.setdefault("configurationCatalog", {})
    for item in result["items"]:
        catalog[item["resourceId"]] = item
    if "resourceId" in arguments and result["items"] and "revision" in result["items"][0]:
        result["draft"] = await _exact_draft_projection(
            s, scope, result["items"][0]["resourceId"], context, protected
        )
    return result


async def prepare_resource_draft(
    s: AsyncSession,
    scope: WorkspaceScope,
    user: User,
    value: object,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """审阅时验证完整替换内容及当前修订，确认时同一事务再次检查修订、资源状态和依赖后才允许写入。"""
    if not isinstance(value, dict) or value.get("type") != RESOURCE_ACTION:
        raise _invalid()
    try:
        if len(canonical_bytes(value)) > MAX_RESOURCE_PROPOSAL_BYTES:
            raise _invalid()
        validate_api("AgentProposal", value)
    except (ValidationError, ValueError, RecursionError):
        raise _invalid() from None
    resource = value["resource"]
    kind, content = resource["kind"], resource["content"]
    check_document(kind, content)
    if not resource["name"].strip() or not _source_allowed(content):
        raise _invalid()
    if context is not None:
        resources, versions = _candidate_ids(context)
        if value.get("resourceId", "").lower() not in resources and "resourceId" in value:
            raise _invalid()
        if any(vid not in versions for vid, _ in asset_references(content)):
            raise _invalid()
    service = ResourceService(s, user)
    await service.authorize(scope, kind)
    if "resourceId" in value:
        rid = value["resourceId"].lower()
        existing = await service.editable(scope, rid)
        if (existing.kind, existing.key, existing.name) != (
            kind,
            resource["key"],
            resource["name"],
        ):
            raise _invalid()
        draft = await ResourceRepository(s, scope).draft(rid)
        service.require_revision(draft, value["revision"])
        if not _source_allowed(draft.document_json):
            raise _invalid()
        value = {**value, "resourceId": rid}
    await _require_references(s, scope, content)
    return value


async def save_resource_draft(
    s: AsyncSession, scope: WorkspaceScope, user: User, action: dict[str, Any]
) -> dict[str, Any]:
    """已确认配置复用编辑器写入校验及审计，返回持久资源标识与新修订，回执由同一轮次事务保存以阻止重复写入。"""
    proposal = await prepare_resource_draft(s, scope, user, action)
    resource = proposal["resource"]
    service = ResourceService(s, user)
    if "resourceId" in proposal:
        rid = proposal["resourceId"]
        draft = await service.update_draft(scope, rid, proposal["revision"], resource["content"])
        revision = draft["revision"]
    else:
        rid = (await service.create(scope, resource))["id"]
        revision = 1
    return {
        "type": RESOURCE_ACTION,
        "resourceId": rid,
        "revision": revision,
        "kind": resource["kind"],
    }
