"""AI 草稿服务：管理 Workspace 内提供方、预算、上下文预览与生成草稿，模型输出永不自动发布为资源版本，本文件注释描述专属不变量。
sanitize 去除受保护字段；测试可在无真实模型凭据下覆盖失败路径。
review 仅在人工确认后进入可编辑草稿，取消与预算超限返回稳定错误码。
"""


from contextlib import asynccontextmanager
from decimal import Decimal, ROUND_CEILING
from hashlib import sha256
from typing import Any, AsyncIterator, Awaitable, Callable
from uuid import uuid4
import asyncio

from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession
from jsonschema import Draft202012Validator

from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import canonical_bytes, _schema, validate_schema
from ..credentials.crypto import EncryptedValue
from ..credentials.service import configured_keyring
from ..db import AiProvider, AiGeneration, Database, User, UserSession
from ..infrastructure.providers import DraftContext, ProviderGateway, ModelReply, allowed_endpoint
from ..pagination import Page
from ..repositories.resource import ResourceRepository
from ..service import Problem, lock_installation, now, stamp, audit
from ..settings import Settings
from .workspace import WorkspaceRepository
from .resource import ResourceService, asset_references
from .report import ReportService, redact

PURPOSE = "veriq-ai-provider-v1"
ADVICE_SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "maxItems": 30,
            "items": {"type": "string", "maxLength": 2000},
        },
        "basis": {"type": "string", "maxLength": 4000},
    },
    "required": ["suggestions", "basis"],
    "additionalProperties": False,
}


def output_schema(purpose: str) -> dict[str, Any]:
    """按生成目的返回期望输出 JSON schema，供模型响应结构校验，output_schema 遵守本文件边界，失败返回稳定 Problem。"""
    if purpose != "CASE_DRAFT":
        return ADVICE_SCHEMA
    definitions = _schema()["$defs"]
    needed: dict[str, Any] = {}

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if "$ref" in value:
                name = value["$ref"].split("/")[-1]
                if name not in needed:
                    needed[name] = definitions[name]
                    visit(needed[name])
            for v in value.values():
                visit(v)
        elif isinstance(value, list):
            for v in value:
                visit(v)

    result = {
        "type": "object",
        "properties": {"kind": {"const": "CASE"}, "document": {"$ref": "#/$defs/CaseDslV1"}},
        "required": ["kind", "document"],
        "additionalProperties": False,
    }
    visit(result)
    return {**result, "$defs": needed}


def micros(value: Any) -> int:
    """将价格输入规范为微单位整数，拒绝非有限或非法数值，micros 遵守本文件边界，失败返回稳定 Problem，并在事务提交前完成全部不变量检查。"""
    return int((Decimal(str(value)) * 1000000).to_integral_value(rounding=ROUND_CEILING))


def priced(input_tokens: int, output_tokens: int, prices: dict[str, Any]) -> int:
    """按输入输出 token 数量与单价计算费用微单位，priced 遵守本文件边界，失败返回稳定 Problem，并在事务提交前完成全部不变量检查。"""
    return int(
        (
            Decimal(input_tokens) * Decimal(str(prices["inputUsdPerMillion"]))
            + Decimal(output_tokens) * Decimal(str(prices["outputUsdPerMillion"]))
        ).to_integral_value(rounding=ROUND_CEILING)
    )


def sanitize(value: Any, protected: set[str] | None = None) -> Any:
    """递归清理提示与上下文中的受保护密钥字段，防止回显泄露，sanitize 遵守本文件边界，失败返回稳定 Problem，并在事务提交前完成全部不变量检查。"""
    value = redact(value, protected or set())
    if isinstance(value, str):
        return "[WITHHELD_REFERENCE]" if "secretRef" in value or "{{secret" in value else value
    if isinstance(value, list):
        return [sanitize(v, protected) for v in value]
    if isinstance(value, dict):
        return {
            k: "[WITHHELD]"
            if k.lower()
            in {
                "secretref",
                "secretrefs",
                "secretversions",
                "credentialreferences",
                "apikey",
                "api_key",
                "headers",
                "cookies",
                "securityschemes",
                "authorization",
                "x-api-key",
            }
            else sanitize(v, protected)
            for k, v in value.items()
        }
    return value


class AiService:
    """编排提供方 CRUD、生成、预览、取消与审核，强制 Workspace 与预算边界，AiService 遵守本文件边界。"""
    def __init__(
        self,
        db: Database,
        settings: Settings,
        identity: Callable[[AsyncSession], Awaitable[tuple[User, UserSession]]],
        registry: Any = None,
    ):
        """注入依赖，包括会话工厂、设置与可选模型调用端口，AiService.__init__ 遵守本文件边界，失败返回稳定 Problem。"""
        self.db, self.settings, self.identity, self.registry = db, settings, identity, registry

    @asynccontextmanager
    async def transaction(
        self, scope: WorkspaceScope, permission: Permission = Permission.VIEW, write: bool = False
    ) -> AsyncIterator[tuple[AsyncSession, User]]:
        """在事务中执行 AI 相关写操作并统一映射为 Problem，AiService.transaction 遵守本文件边界。"""
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            await WorkspaceRepository(s, scope).authorize(user, permission, write=write)
            yield s, user

    async def provider(
        self, s: AsyncSession, scope: WorkspaceScope, pid: str, *, enabled: bool = False
    ) -> AiProvider:
        """按 ID 加载本 Workspace 的 AI 提供方配置行，AiService.provider 遵守本文件边界，失败返回稳定 Problem。"""
        row = await s.get(AiProvider, pid)
        if not row or row.workspace_id != scope.workspace_id or row.deleted:
            raise Problem(404, "AI_PROVIDER_NOT_FOUND", "Provider not found")
        if enabled and not row.enabled:
            raise Problem(409, "AI_PROVIDER_DISABLED", "Provider is disabled")
        if enabled:
            allowed_endpoint(row.config["baseURL"], self.settings)
        return row

    async def budget(self, s: AsyncSession, row: AiProvider) -> dict[str, Any]:
        """计算提供方剩余预算与当前用量快照信息，AiService.budget 遵守本文件边界，失败返回稳定 Problem，并在事务提交前完成全部不变量检查。"""
        month = now().strftime("%Y-%m")
        used, held = (
            await s.execute(
                select(
                    func.coalesce(
                        func.sum(
                            case((AiGeneration.month == month, AiGeneration.cost_micros), else_=0)
                        ),
                        0,
                    ),
                    func.coalesce(
                        func.sum(
                            case(
                                (AiGeneration.cost_micros.is_(None), AiGeneration.reserved_micros),
                                else_=0,
                            )
                        ),
                        0,
                    ),
                ).where(AiGeneration.provider_id == row.id)
            )
        ).one()
        return {
            "month": month,
            "estimatedUsedUsd": int(used) / 1000000,
            "heldUsd": int(held) / 1000000,
            "availableUsd": max(0, micros(row.config["monthlyBudgetUsd"]) - int(used) - int(held))
            / 1000000,
            "pricingBasis": "CONFIGURED_ESTIMATE",
        }

    async def provider_dto(self, s: AsyncSession, row: AiProvider) -> dict[str, Any]:
        """导出提供方 DTO，并遮蔽任何密钥明文材料，AiService.provider_dto 遵守本文件边界，失败返回稳定 Problem。"""
        return {
            **row.config,
            "id": row.id,
            "revision": row.revision,
            "enabled": row.enabled,
            "keyConfigured": bool(row.ciphertext),
            "budget": await self.budget(s, row),
        }

    async def providers(
        self, scope: WorkspaceScope, page: Page, pid: str | None = None
    ) -> dict[str, Any]:
        """列出当前 Workspace 内全部 AI 提供方配置，AiService.providers 遵守本文件边界，失败返回稳定 Problem。"""
        async with self.transaction(scope) as (s, _):
            if pid:
                return await self.provider_dto(s, await self.provider(s, scope, pid))
            query = select(AiProvider).where(
                AiProvider.workspace_id == scope.workspace_id, AiProvider.deleted.is_(False)
            )
            if page.last:
                query = query.where(AiProvider.id > page.last[1])
            rows = list(
                (await s.scalars(query.order_by(AiProvider.id).limit(page.limit + 1))).all()
            )
            result: dict[str, Any] = {
                "items": [await self.provider_dto(s, r) for r in rows[: page.limit]],
                "nextCursor": None,
            }
            if rows:
                result["nextCursor"] = page.next(
                    (
                        rows[min(len(rows), page.limit) - 1].id,
                        rows[min(len(rows), page.limit) - 1].id,
                    ),
                    len(rows) > page.limit,
                )
            return result

    async def write_provider(
        self, scope: WorkspaceScope, data: dict[str, Any], pid: str | None = None
    ) -> dict[str, Any]:
        """创建或更新提供方，校验允许的 base URL 白名单，AiService.write_provider 遵守本文件边界。"""
        allowed_endpoint(data["baseURL"], self.settings)
        async with self.transaction(scope, Permission.MANAGE_WORKSPACE, True) as (s, user):
            config = {k: v for k, v in data.items() if k not in {"apiKey", "enabled"}}
            if pid:
                row = await self.provider(s, scope, pid)
                held = await self.budget(s, row)
                if micros(data["monthlyBudgetUsd"]) < micros(held["heldUsd"]) + micros(
                    held["estimatedUsedUsd"]
                ):
                    raise Problem(
                        409, "AI_BUDGET_HELD", "Budget is below existing spending and reservations"
                    )
                running = await s.scalar(
                    select(func.count())
                    .select_from(AiGeneration)
                    .where(AiGeneration.provider_id == pid, AiGeneration.status == "RUNNING")
                )
                if running and (config != row.config or data.get("apiKey")):
                    raise Problem(
                        409,
                        "AI_PROVIDER_BUSY",
                        "Only enable/disable is allowed during an active call",
                    )
                row.config = config
                row.enabled = data["enabled"]
                row.revision += 1
            else:
                if not data.get("apiKey"):
                    raise Problem(
                        422, "AI_KEY_REQUIRED", "Enter a provider key in the protected form"
                    )
                count = await s.scalar(
                    select(func.count())
                    .select_from(AiProvider)
                    .where(
                        AiProvider.workspace_id == scope.workspace_id, AiProvider.deleted.is_(False)
                    )
                )
                if count and count >= 20:
                    raise Problem(
                        409, "AI_PROVIDER_LIMIT", "At most 20 active provider configurations"
                    )
                row = AiProvider(
                    id=str(uuid4()),
                    workspace_id=scope.workspace_id,
                    revision=1,
                    config=config,
                    enabled=data["enabled"],
                    deleted=False,
                )
                s.add(row)
            if data.get("apiKey"):
                row.key_version = str(uuid4())
                sealed = configured_keyring(self.settings, purpose=PURPOSE).encrypt(
                    scope.workspace_id, row.id, row.key_version, data["apiKey"]
                )
                row.key_id, row.nonce, row.ciphertext = (
                    sealed.key_id,
                    sealed.nonce,
                    sealed.ciphertext,
                )
            await s.flush()
            audit(s, "ai.provider_configured", user.id, row.id, workspace_id=scope.workspace_id)
            return await self.provider_dto(s, row)

    async def delete_provider(self, scope: WorkspaceScope, pid: str) -> dict[str, Any]:
        """删除提供方配置，不影响既有生成历史行，AiService.delete_provider 遵守本文件边界，失败返回稳定 Problem。"""
        async with self.transaction(scope, Permission.MANAGE_WORKSPACE, True) as (s, user):
            row = await self.provider(s, scope, pid)
            row.enabled = False
            row.deleted = True
            row.revision += 1
            audit(s, "ai.provider_deleted", user.id, pid, workspace_id=scope.workspace_id)
            return {}

    async def context(
        self,
        s: AsyncSession,
        user: User,
        scope: WorkspaceScope,
        req: dict[str, Any],
        provider: AiProvider,
    ) -> tuple[dict[str, Any], DraftContext]:
        """组装生成上下文预览，内容已经过 sanitize 处理，AiService.context 遵守本文件边界，失败返回稳定 Problem。"""
        repo = ResourceRepository(s, scope)
        context = {
            "purpose": req["purpose"],
            "requirement": req["prompt"],
            "openapi": req.get("openapi", {}),
            "data": req.get("data", {}),
            "resources": [],
        }
        provenance: list[dict[str, Any]] = []
        original = None
        revision = None
        selected = set(req.get("versionIds", []))
        if req.get("resourceId"):
            r = await repo.resource(req["resourceId"])
            if r.kind != "CASE" or r.status == "ARCHIVED":
                raise Problem(422, "AI_SOURCE_KIND", "Only an active CASE can be a draft target")
            draft = await repo.draft(r.id)
            original = draft.document_json
            revision = draft.revision
            context["candidate"] = original
            provenance.append({"resourceId": r.id, "revision": revision})
            selected.update(v for v, _ in asset_references(original))
        if len(selected) > 20:
            raise Problem(
                413, "AI_CONTEXT_LIMIT", "Selected dependency context exceeds 20 versions"
            )
        for vid in sorted(selected):
            version = await repo.version(vid)
            resource = await repo.resource(version.resource_id)
            if resource.status == "ARCHIVED" or resource.kind not in {
                "ELEMENT_CATALOG",
                "DATASET",
                "FLOW",
                "ASSERTION_TEMPLATE",
                "FIXTURE",
            }:
                raise Problem(422, "AI_SOURCE_KIND", "Selected version kind is not permitted")
            # Fixture identities/transport configuration never leave the server.
            if resource.kind == "FIXTURE":
                value = {
                    "kind": "FIXTURE",
                    "document": {
                        "inputSchema": version.document_json["document"].get("inputSchema", {})
                    },
                }
            else:
                value = version.document_json
            context["resources"].append({"versionId": vid, "content": value})
            provenance.append(
                {
                    "versionId": vid,
                    "resourceId": resource.id,
                    "kind": resource.kind,
                    "sha256": version.sha256,
                }
            )
        if req["purpose"] == "FAILURE_ANALYSIS":
            if not req.get("runId"):
                raise Problem(422, "AI_RUN_REQUIRED", "Choose a Run for sanitized failure analysis")
            report = ReportService(s, user, self.settings)
            run = await report.get(scope, req["runId"])
            # Only normal scoped projections; never artifacts, raw logs or secret-resolution APIs.
            context["report"] = run
            events = []
            for attempt in (await report.attempts(scope, req["runId"]))[:10]:
                projection = await report.events(scope, attempt.id, 0, limit=30, byte_budget=8192)
                events.append(
                    {
                        "attemptId": attempt.id,
                        "events": projection["items"],
                        "hasMore": projection["hasMore"],
                    }
                )
            context["events"] = events
            provenance.append(
                {
                    "runId": req["runId"],
                    "projection": "sanitized",
                    "attemptLimit": 10,
                    "eventsPerAttempt": 30,
                }
            )
        key = self.key(provider)
        context = sanitize(context, {key})
        if len(canonical_bytes(context)) > 65536:
            raise Problem(
                413, "AI_CONTEXT_LIMIT", "Selected context exceeds 64 KiB; select fewer inputs"
            )
        dc = DraftContext(
            context, output_schema(req["purpose"]), provider.config["maxOutputTokens"]
        )
        bound = dc.input_bound()
        reserve = priced(bound, dc.max_output_tokens, provider.config)
        if bound > 262144 or reserve > micros(provider.config["maxRequestUsd"]):
            raise Problem(
                422, "AI_REQUEST_LIMIT", "Context and output reservation exceed request limits"
            )
        result = {
            "context": context,
            "contextHash": sha256(canonical_bytes(context)).hexdigest(),
            "inputTokenBound": bound,
            "reservedUsd": reserve / 1000000,
            "provenance": provenance,
        }
        # Internal-only fields are kept separately from the preview DTO.
        if original is not None:
            result["_original"] = sanitize(original, {key})
            result["_revision"] = revision
        return result, dc

    def key(self, row: AiProvider) -> str:
        """派生提供方缓存或幂等键，结果中不含密钥明文，AiService.key 遵守本文件边界，失败返回稳定 Problem，并在事务提交前完成全部不变量检查。"""
        try:
            result = configured_keyring(self.settings, purpose=PURPOSE).decrypt(
                row.workspace_id,
                row.id,
                row.key_version,
                EncryptedValue(row.key_id, row.nonce, row.ciphertext),
            )
            if not isinstance(result, str):
                raise ValueError
            return result
        except Exception:
            raise Problem(
                409, "AI_KEY_UNAVAILABLE", "Provider key is unavailable; configure it again"
            ) from None

    async def preview(self, scope: WorkspaceScope, req: dict[str, Any]) -> dict[str, Any]:
        """预览生成请求费用与上下文，不落库正式草稿，AiService.preview 遵守本文件边界，失败返回稳定 Problem。"""
        async with self.transaction(scope, Permission.EDIT) as (s, user):
            p = await self.provider(s, scope, req["providerId"], enabled=True)
            result, _ = await self.context(s, user, scope, req, p)
            return {k: v for k, v in result.items() if not k.startswith("_")}

    async def generation(self, s: AsyncSession, scope: WorkspaceScope, gid: str) -> AiGeneration:
        """加载生成记录并校验属于当前 Workspace，AiService.generation 遵守本文件边界，失败返回稳定 Problem。"""
        g = await s.get(AiGeneration, gid)
        if not g or g.workspace_id != scope.workspace_id:
            raise Problem(404, "AI_GENERATION_NOT_FOUND", "Generation not found")
        return g

    async def dto(self, s: AsyncSession, scope: WorkspaceScope, g: AiGeneration) -> dict[str, Any]:
        """导出生成记录 DTO，含状态与费用，不含原始密钥，AiService.dto 遵守本文件边界，失败返回稳定 Problem。"""
        result = {
            "id": g.id,
            "providerId": g.provider_id,
            "requestId": g.request_id,
            "createdAt": stamp(g.created_at),
            "status": g.status,
            "purpose": g.purpose,
            "reservedUsd": g.reserved_micros / 1000000,
            "costState": "UNKNOWN" if g.cost_micros is None else "ESTIMATED",
        }
        if g.cost_micros is not None:
            result["costUsd"] = g.cost_micros / 1000000
        p = await s.get(AiProvider, g.provider_id)
        public = {"inputTokens", "outputTokens", "errorCode", "pricing"}
        endpoint_authorized = False
        if p:
            try:
                allowed_endpoint(p.config["baseURL"], self.settings)
                endpoint_authorized = True
            except Problem:
                pass  # The operator may revoke an endpoint independently of its provider row.
        if (
            p
            and not p.deleted
            and p.enabled
            and endpoint_authorized
            and p.revision == g.data["providerRevision"]
        ):
            public |= {
                "output",
                "context",
                "provenance",
                "diagnostics",
                "resourceId",
                "resourceState",
                "revision",
                "original",
            }
        else:
            result["errorCode"] = "AI_OUTPUT_WITHHELD"
        result.update({k: v for k, v in g.data.items() if k in public and k != "errorCode"})
        if "errorCode" not in result and "errorCode" in g.data:
            result["errorCode"] = g.data["errorCode"]
        return result

    async def history(
        self, scope: WorkspaceScope, page: Page, gid: str | None = None
    ) -> dict[str, Any]:
        """分页列出 Workspace 内的 AI 生成历史记录，AiService.history 遵守本文件边界，失败返回稳定 Problem。"""
        async with self.transaction(scope) as (s, _):
            if gid:
                return await self.dto(s, scope, await self.generation(s, scope, gid))
            q = select(AiGeneration).where(AiGeneration.workspace_id == scope.workspace_id)
            if page.last:
                q = q.where(AiGeneration.id > page.last[1])
            rows = list((await s.scalars(q.order_by(AiGeneration.id).limit(page.limit + 1))).all())
            return {
                "items": [await self.dto(s, scope, g) for g in rows[: page.limit]],
                "nextCursor": page.next(
                    (
                        rows[min(len(rows), page.limit) - 1].id,
                        rows[min(len(rows), page.limit) - 1].id,
                    ),
                    len(rows) > page.limit,
                )
                if rows
                else None,
            }

    async def create_draft(
        self, scope: WorkspaceScope, req: dict[str, Any], *, connection: bool = False
    ) -> dict[str, Any]:
        """创建生成草稿并调用模型端口；失败记 FAILED 且不发布，AiService.create_draft 遵守本文件边界。"""
        request_hash = sha256(canonical_bytes(req)).hexdigest()
        async with self.transaction(
            scope, Permission.MANAGE_WORKSPACE if connection else Permission.EDIT, True
        ) as (s, user):
            p = await self.provider(s, scope, req["providerId"], enabled=True)
            existing = await s.scalar(
                select(AiGeneration).where(
                    AiGeneration.workspace_id == scope.workspace_id,
                    AiGeneration.request_id == req["requestId"],
                )
            )
            if existing:
                if existing.request_hash != request_hash:
                    raise Problem(
                        409, "IDEMPOTENCY_CONFLICT", "Request id already represents different input"
                    )
                # Rebuild current scoped references before replay, without another model request.
                await self.context(s, user, scope, req, p)
                return await self.dto(s, scope, existing)
            preview, context = await self.context(s, user, scope, req, p)
            if req.get("contextHash") and req["contextHash"] != preview["contextHash"]:
                raise Problem(409, "AI_CONTEXT_CHANGED", "Preview context changed; review it again")
            reserve = micros(preview["reservedUsd"])
            budget = await self.budget(s, p)
            if micros(p.config["monthlyBudgetUsd"]) == 0 or reserve > micros(
                budget["availableUsd"]
            ):
                raise Problem(
                    429, "AI_BUDGET_EXHAUSTED", "Provider budget cannot cover this bounded request"
                )
            data = {
                "context": preview["context"],
                "provenance": preview["provenance"],
                "providerRevision": p.revision,
                "pricing": {**p.config, "currency": "USD", "basis": "CONFIGURED_ESTIMATE"},
                "inputTokenBound": preview["inputTokenBound"],
                "selectedVersionIds": [
                    v["versionId"] for v in preview["provenance"] if "versionId" in v
                ],
            }
            if req.get("resourceId"):
                data.update(
                    resourceId=req["resourceId"],
                    revision=preview["_revision"],
                    original=preview["_original"],
                )
            if req.get("runId"):
                data["runId"] = req["runId"]
            g = AiGeneration(
                id=str(uuid4()),
                workspace_id=scope.workspace_id,
                provider_id=p.id,
                actor_id=user.id,
                request_id=req["requestId"],
                request_hash=request_hash,
                created_at=now(),
                month=budget["month"],
                status="RUNNING",
                purpose="CONNECTION_TEST" if connection else req["purpose"],
                reserved_micros=reserve,
                cost_micros=None,
                data=data,
            )
            s.add(g)
            key = self.key(p)
            config = dict(p.config)
            gid = g.id
            audit(s, "ai.request_reserved", user.id, gid, workspace_id=scope.workspace_id)
        reply: ModelReply | None = None
        error = None
        try:
            reply = await asyncio.wait_for(
                ProviderGateway(config, key).generate(context), timeout=35
            )
        except asyncio.CancelledError:
            # Durable RUNNING reservation remains unknown even if the worker is cancelled.
            raise
        except Exception:
            error = "AI_PROVIDER_ERROR"
        # Network has completed; a fresh transaction checks current session/permissions.
        async with self.transaction(
            scope, Permission.MANAGE_WORKSPACE if connection else Permission.EDIT, True
        ) as (s, user):
            g = await self.generation(s, scope, gid)
            p = await self.provider(s, scope, req["providerId"], enabled=True)
            if p.revision != g.data["providerRevision"]:
                raise Problem(
                    409, "AI_PROVIDER_CHANGED", "Provider changed while the call was running"
                )
            d = dict(g.data)
            if (
                reply
                and type(reply.input_tokens) is int
                and type(reply.output_tokens) is int
                and 0 <= reply.input_tokens <= d["inputTokenBound"]
                and 0 <= reply.output_tokens <= config["maxOutputTokens"]
            ):
                g.cost_micros = priced(reply.input_tokens, reply.output_tokens, config)
                d.update(inputTokens=reply.input_tokens, outputTokens=reply.output_tokens)
            if g.status == "CANCELLED":
                g.data = d
                return await self.dto(s, scope, g)
            if reply and reply.error_code:
                error = reply.error_code
            if reply and not error:
                repo = ResourceRepository(s, scope)
                try:
                    if d.get("resourceId"):
                        resource = await repo.resource(d["resourceId"])
                        current = await repo.draft(resource.id)
                        if resource.status == "ARCHIVED" or current.revision != d["revision"]:
                            error = "AI_CONTEXT_CHANGED"
                    for version_id in d["selectedVersionIds"]:
                        version = await repo.version(version_id)
                        source = await repo.resource(version.resource_id)
                        if source.status == "ARCHIVED":
                            error = "AI_CONTEXT_CHANGED"
                except Problem:
                    error = "AI_CONTEXT_CHANGED"
            if reply and not error:
                diagnostics = []
                output = None
                # Untrusted-content failures must not roll back verified usage or
                # leave the durable call RUNNING. Operational/auth errors stay outside.
                try:
                    canonical_bytes(reply.output)
                    output = sanitize(reply.output, {key})
                    canonical_bytes(output)
                    if req["purpose"] == "CASE_DRAFT":
                        if (
                            validate_schema("ResourceDocumentV1", output)
                            or not isinstance(output, dict)
                            or output.get("kind") != "CASE"
                        ):
                            diagnostics = [
                                {
                                    "code": "AI_SCHEMA_INVALID",
                                    "message": "Output must be a canonical CASE resource document",
                                }
                            ]
                        elif any(
                            v not in d["selectedVersionIds"] for v, _ in asset_references(output)
                        ):
                            diagnostics = [
                                {
                                    "code": "AI_REFERENCE_UNSELECTED",
                                    "message": "Output references a version outside reviewed context",
                                }
                            ]
                    elif not Draft202012Validator(ADVICE_SCHEMA).is_valid(output):
                        diagnostics = [
                            {
                                "code": "AI_SCHEMA_INVALID",
                                "message": "Advice must contain bounded suggestions and basis",
                            }
                        ]
                except RecursionError:
                    diagnostics = [
                        {
                            "code": "AI_OUTPUT_NESTING_LIMIT",
                            "message": "Model output exceeds supported JSON nesting",
                        }
                    ]
                except ValueError:
                    diagnostics = [
                        {
                            "code": "AI_OUTPUT_NOT_PORTABLE",
                            "message": "Model output must contain portable Unicode JSON",
                        }
                    ]
                if diagnostics:
                    error = "AI_OUTPUT_INVALID"
                    d["diagnostics"] = diagnostics
                else:
                    d["output"] = output
            if error:
                d["errorCode"] = error
            g.status = "FAILED" if error else "SUCCEEDED"
            g.data = d
            audit(s, "ai.request_finished", user.id, gid, workspace_id=scope.workspace_id)
            return await self.dto(s, scope, g)

    async def cancel(self, scope: WorkspaceScope, gid: str) -> dict[str, Any]:
        """取消进行中的生成任务并更新状态机，AiService.cancel 遵守本文件边界，失败返回稳定 Problem，并在事务提交前完成全部不变量检查。"""
        async with self.transaction(scope, Permission.EDIT, True) as (s, user):
            g = await self.generation(s, scope, gid)
            if g.status == "RUNNING":
                g.status = "CANCELLED"
                g.data = {**g.data, "errorCode": "AI_CANCELLED_UPSTREAM_UNKNOWN"}
                audit(s, "ai.cancelled", user.id, gid, workspace_id=scope.workspace_id)
            return await self.dto(s, scope, g)

    async def review(self, scope: WorkspaceScope, gid: str, data: dict[str, Any]) -> dict[str, Any]:
        """人工审核生成结果，通过后才可进入资源草稿编辑流，AiService.review 遵守本文件边界，失败返回稳定 Problem。"""
        async with self.transaction(scope, Permission.EDIT, True) as (s, user):
            g = await self.generation(s, scope, gid)
            p = await self.provider(s, scope, g.provider_id, enabled=True)
            if p.revision != g.data["providerRevision"]:
                raise Problem(409, "AI_PROVIDER_CHANGED", "Provider changed since generation")
            if g.status != "SUCCEEDED":
                raise Problem(
                    409, "AI_REVIEW_STATE", "Only successful unreviewed output can be reviewed"
                )
            if data["decision"] == "REJECT":
                g.status = "REJECTED"
            else:
                if g.purpose != "CASE_DRAFT":
                    raise Problem(
                        422,
                        "AI_ADVICE_ONLY",
                        "Analysis and boundary suggestions cannot be applied automatically",
                    )
                output = g.data["output"]
                repo = ResourceRepository(s, scope)
                for vid, kind in asset_references(output):
                    v = await repo.version(vid)
                    r = await repo.resource(v.resource_id)
                    if r.kind != kind or r.status == "ARCHIVED":
                        raise Problem(422, "INVALID_REFERENCE", "Referenced version is unavailable")
                resources = ResourceService(s, user, self.registry)
                if g.data.get("resourceId"):
                    if data.get("revision") != g.data["revision"]:
                        raise Problem(
                            409,
                            "STALE_REVISION",
                            "Review must match the original candidate revision",
                        )
                    draft = await resources.update_draft(
                        scope, g.data["resourceId"], data["revision"], output
                    )
                    rid = g.data["resourceId"]
                    revision = draft["revision"]
                else:
                    if not data.get("key") or not data.get("name"):
                        raise Problem(
                            422, "AI_DRAFT_NAME_REQUIRED", "Provide a resource key and name"
                        )
                    resource = await resources.create(
                        scope,
                        {
                            "kind": "CASE",
                            "key": data["key"],
                            "name": data["name"],
                            "content": output,
                        },
                    )
                    rid = resource["id"]
                    revision = 1
                g.data = {
                    **g.data,
                    "resourceId": rid,
                    "revision": revision,
                    "resourceState": "DRAFT",
                }
                g.status = "REVIEWED"
            audit(s, "ai.reviewed", user.id, gid, workspace_id=scope.workspace_id)
            return await self.dto(s, scope, g)
