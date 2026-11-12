from typing import Any
import re
from sqlalchemy import and_, or_, select
from ..auth.authorization import Permission, WorkspaceScope
from ..db import Resource, ResourceVersion, ResourceDependency, ValidationReceipt, Attempt
from ..pagination import Page
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, lock_installation
from ..services.workspace import WorkspaceRepository
from ..services.resource import ResourceService, resource_dto, draft_dto, version_dto, job_dto
from ..services.publish import PublishService, receipt_dto
from .base import API


class ResourceAPI(API):
    """工作区资源生命周期 HTTP 面：草稿读写、校验、发布、版本与依赖方查询以及编译产物下载；发布依赖校验回执，禁止跳过验证直接升版本。"""

    def prepare(self) -> None:
        """资源信封放宽到约 2 MiB，其余操作保留 64 KiB；并按 action 白名单限制动词；draft/resources 放宽正文，其它动作保持账户级上限。"""
        # JSON 资源信封：2 MiB 加有界信封开销；其他操作保留 64 KiB 账户/API 上限。
        self.body_limit = 2 * 1024 * 1024 + 4096 if self.action in {"resources", "draft"} else 65536
        super().prepare()
        allowed = {
            "resources": {"GET", "POST"},
            "resource": {"GET", "PATCH"},
            "draft": {"GET", "PUT"},
            "validation-preview": {"GET"},
            "validate": {"POST"},
            "publish": {"POST"},
            "versions": {"GET"},
            "version": {"GET"},
            "dependents": {"GET"},
            "job": {"GET"},
            "validation-receipt": {"GET"},
            "compiled-source": {"GET"},
        }
        if self.request.method not in allowed[self.action]:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    def service(self, session: Any, user: Any, publish: bool = False) -> ResourceService:
        """按需构造 ResourceService 或 PublishService，并注入可选身份引用注册表；publish=True 时切换到 PublishService 实现。"""
        cls = PublishService if publish else ResourceService
        return cls(session, user, self.application.settings.get("identity_reference_registry"))

    async def get(
        self, workspace_id: str, resource_id: str | None = None, version_id: str | None = None
    ) -> None:
        """GET 分发资源元数据、草稿、预览、版本、依赖方、作业、校验回执与编译源；compiled-source 以沙箱 CSP 输出纯文本，防脚本执行。"""
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions() as s:
            user, _ = await self.identity(s)
            await WorkspaceRepository(s, scope).authorize(user)
            repo = ResourceRepository(s, scope)
            if self.action in {"job", "validation-receipt"}:
                assert resource_id
                job = await repo.job(resource_id)
                if self.action == "job":
                    dto = job_dto(job)
                    if job.active_attempt_id:
                        attempt = await s.get(Attempt, job.active_attempt_id)
                        # 仅当 Attempt 仍属本 Workspace/作业时才投影诊断，防止串租户事实。
                        if (
                            attempt
                            and attempt.workspace_id == workspace_id
                            and attempt.job_id == job.id
                        ):
                            code = attempt.facts.get("errorCode")
                            if isinstance(code, str) and re.fullmatch(
                                r"[A-Z][A-Z0-9_]{0,79}", code
                            ):
                                dto["errorCode"] = code
                            if attempt.facts.get("diagnostics"):
                                dto["diagnostics"] = attempt.facts["diagnostics"]
                    self.respond(dto)
                    return
                receipt = (
                    await s.execute(
                        select(ValidationReceipt).where(
                            ValidationReceipt.workspace_id == workspace_id,
                            ValidationReceipt.job_id == job.id,
                        )
                    )
                ).scalar_one_or_none()
                if receipt is None:
                    raise Problem(
                        409,
                        "VALIDATION_NOT_COMPLETED",
                        "No successful validation receipt is available",
                    )
                self.respond(receipt_dto(receipt))
                return
            if self.action == "compiled-source":
                from ..services.resource_source import compiled_source

                assert resource_id and version_id
                metadata, content = await compiled_source(
                    repo, resource_id, version_id, self.get_query_argument("path", None)
                )
                self.set_header("Cache-Control", "private, no-store")
                self.set_header("X-Content-Type-Options", "nosniff")
                self.set_header("Content-Security-Policy", "default-src 'none'; sandbox")
                if content is None:
                    self.respond(metadata)
                else:
                    self.set_header("Content-Type", "text/plain; charset=utf-8")
                    self.finish(content)
                return
            resource = await repo.resource(resource_id) if resource_id else None
            if self.action == "resource":
                assert resource
                self.respond(resource_dto(resource))
                return
            if self.action == "draft":
                assert resource_id
                self.respond(draft_dto(await repo.draft(resource_id)))
                return
            if self.action == "validation-preview":
                assert resource_id
                self.respond(await self.service(s, user).preview(scope, resource_id))
                return
            if self.action == "version":
                assert version_id
                version = await repo.version(version_id)
                if version.resource_id != resource_id:
                    raise Problem(404, "VERSION_NOT_FOUND", "Version not found")
                self.respond(version_dto(version))
                return
            filters: dict[str, Any] = {}
            if self.action == "resources":
                kind, status = (
                    self.get_query_argument("kind", None),
                    self.get_query_argument("status", None),
                )
                if (
                    kind is not None
                    and kind
                    not in {
                        "CASE",
                        "ELEMENT_CATALOG",
                        "ASSERTION_TEMPLATE",
                        "DATASET",
                        "FLOW",
                        "FIXTURE",
                        "SUITE",
                        "ENVIRONMENT",
                    }
                    or status is not None
                    and status not in {"DRAFT", "PUBLISHED", "ARCHIVED"}
                ):
                    raise Problem(400, "INVALID_FILTER", "Invalid resource filter")
                filters = {"kind": kind, "status": status}
            page = Page.read(
                self,
                {
                    "list": self.action,
                    "actor": user.id,
                    "workspaceId": workspace_id,
                    "resourceId": resource_id,
                    **filters,
                },
                self.config.signing_key.get_secret_value(),
            )
            if self.action == "versions":
                query_v = select(ResourceVersion).where(
                    ResourceVersion.workspace_id == workspace_id,
                    ResourceVersion.resource_id == resource_id,
                )
                if page.last:
                    query_v = query_v.where(ResourceVersion.version_no > int(page.last[0]))
                rows_v = (
                    (
                        await s.execute(
                            query_v.order_by(ResourceVersion.version_no).limit(page.limit + 1)
                        )
                    )
                    .scalars()
                    .all()
                )
                shown_v = rows_v[: page.limit]
                self.respond(
                    {
                        "items": [version_dto(v) for v in shown_v],
                        "nextCursor": page.next(
                            (str(shown_v[-1].version_no), shown_v[-1].id), len(rows_v) > page.limit
                        )
                        if shown_v
                        else None,
                    }
                )
                return
            query = select(Resource).where(Resource.workspace_id == workspace_id)
            if self.action == "dependents":
                targets = select(ResourceVersion.id).where(
                    ResourceVersion.workspace_id == workspace_id,
                    ResourceVersion.resource_id == resource_id,
                )
                dependents = (
                    select(ResourceVersion.resource_id)
                    .join(
                        ResourceDependency,
                        and_(
                            ResourceDependency.version_id == ResourceVersion.id,
                            ResourceDependency.workspace_id == ResourceVersion.workspace_id,
                        ),
                    )
                    .where(
                        ResourceVersion.workspace_id == workspace_id,
                        ResourceDependency.dependency_version_id.in_(targets),
                    )
                )
                query = query.where(Resource.id.in_(dependents))
            for key, value in filters.items():
                if value is not None:
                    query = query.where(getattr(Resource, key) == value)
            if page.last:
                query = query.where(
                    or_(
                        Resource.key > page.last[0],
                        and_(Resource.key == page.last[0], Resource.id > page.last[1]),
                    )
                )
            rows = (
                (await s.execute(query.order_by(Resource.key, Resource.id).limit(page.limit + 1)))
                .scalars()
                .all()
            )
            shown = rows[: page.limit]
            self.respond(
                {
                    "items": [resource_dto(r) for r in shown],
                    "nextCursor": page.next((shown[-1].key, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
            )

    async def post(self, workspace_id: str, resource_id: str | None = None) -> None:
        """POST 创建资源、异步启动校验（202）或在校验回执通过后发布不可变版本；validate 返回 202 表示作业已入队，不是已通过。"""
        data = self.body(
            {
                "resources": "ResourceCreate",
                "validate": "ValidationRequest",
                "publish": "PublishRequest",
            }[self.action]
        )
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            service = self.service(s, user)
            if self.action == "resources":
                result = await service.create(scope, data)
            elif self.action == "validate":
                assert resource_id
                result = await service.validate(
                    scope, resource_id, data["revision"], data["sourceHash"]
                )
            else:
                assert resource_id
                result = await PublishService(
                    s, user, self.application.settings.get("identity_reference_registry")
                ).publish(scope, resource_id, data["revision"], data["validationReceiptId"])
        self.respond(result, 202 if self.action == "validate" else 201)

    async def put(self, workspace_id: str, resource_id: str) -> None:
        """PUT draft：在安装锁下按 revision 乐观并发写入草稿内容；revision 不匹配时由服务层映射并发冲突。"""
        data = self.body("DraftWrite")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            result = await self.service(s, user).update_draft(
                WorkspaceScope(workspace_id), resource_id, data["revision"], data["content"]
            )
        self.respond(result)

    async def patch(self, workspace_id: str, resource_id: str) -> None:
        """PATCH 更新显示名与归档态；要求 EDIT 写权限并按资源 kind 再授权；归档态根据是否已有 latest_version_id 回退 PUBLISHED/DRAFT。"""
        data = self.body("ResourceUpdate")
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            await WorkspaceRepository(s, scope).authorize(user, Permission.EDIT, write=True)
            resource = await ResourceRepository(s, scope).resource(resource_id)
            await self.service(s, user).authorize(scope, resource.kind)
            resource.name = data["name"]
            if "archived" in data:
                resource.status = (
                    "ARCHIVED"
                    if data["archived"]
                    else "PUBLISHED"
                    if resource.latest_version_id
                    else "DRAFT"
                )
            audit(s, "resource.updated", user.id, resource.id, workspace_id=workspace_id)
            result = resource_dto(resource)
        self.respond(result)
