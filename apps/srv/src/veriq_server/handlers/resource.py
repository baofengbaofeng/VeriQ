from collections.abc import Sequence
from typing import Any
import re
from sqlalchemy import and_, or_, select
from ..auth.authorization import Permission, WorkspaceScope
from ..datasets.bindings import authorize_dataset
from ..datasets.policy import DatasetBinding
from ..datasets.request import fetch_rows, masked_preview, verify_signature
from ..db import Resource, ResourceVersion, ResourceDependency, ValidationReceipt, Attempt
from ..contracts import validate_schema
from ..pagination import Page
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, lock_installation
from ..services.agent_form_receipts import FORM_ORIGIN_HEADER
from ..services.compilation_provenance import validation_origin_matches
from ..services.workspace import WorkspaceRepository
from ..services.resource import (
    DATASET_DOCUMENT_LIMIT,
    DOCUMENT_LIMIT,
    ResourceService,
    resource_dto,
    draft_dto,
    version_dto,
    job_dto,
)
from ..services.publish import PublishService, receipt_dto
from .base import API

_RESOURCE_BODY_LIMIT = DOCUMENT_LIMIT + 4096
DATASET_WRITE_BODY_LIMIT = DATASET_DOCUMENT_LIMIT + 4096
DATASET_WRITE_ACTIONS = frozenset({("resources", "POST"), ("draft", "PUT")})


async def _resource_list_items(
    repo: ResourceRepository, shown: Sequence[Resource], *, dataset_summary: bool
) -> list[dict[str, Any]]:
    """只为数据集目录的实际返回行组装草稿摘要，通用资源列表、依赖方列表和分页探测行不读取草稿。"""
    items = [resource_dto(row) for row in shown]
    if dataset_summary:
        summaries = await repo.dataset_summaries([row.id for row in shown])
        for item in items:
            if item["id"] in summaries:
                item["datasetSummary"] = summaries[item["id"]]
    return items


class ResourceAPI(API):
    """工作区资源生命周期 HTTP 面：草稿读写、校验、发布、版本与依赖方查询以及编译产物下载；发布依赖校验回执，
    禁止跳过验证直接升版本。ResourceAPI 必须坚持 Workspace 归属与成员授权，

    嵌套资源引用不得跨空间隐式放行。
    """

    def prepare(self) -> None:
        """仅为创建和写草稿预留数据集包络的空间，随后依据已验证的正文种类收紧普通资源限额，其他动作保持原约束。"""
        if (self.action, self.request.method) in DATASET_WRITE_ACTIONS:
            self.body_limit = DATASET_WRITE_BODY_LIMIT
        elif self.action in {"resources", "draft", "http-preview"}:
            self.body_limit = _RESOURCE_BODY_LIMIT
        super().prepare()
        allowed = {
            "dataset-copies": {"GET", "POST"},
            "http-preview": {"POST"},
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

    def _resource_write_body(self, schema: str) -> dict[str, Any]:
        """普通包络超限时仅允许契约校验通过且明确声明为数据集的请求继续，持久化资源的种类仍由领域服务核对。"""
        if len(self.request.body) <= _RESOURCE_BODY_LIMIT:
            return self.body(schema)
        try:
            data = self.body(schema)
        except Problem:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit") from None
        if data["content"]["kind"] != "DATASET" or data.get("kind", "DATASET") != "DATASET":
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        return data

    def service(self, session: Any, user: Any, publish: bool = False) -> ResourceService:
        """按需构造 ResourceService 或 PublishService，并注入可选身份引用注册表；publish=True 时切换到 PublishService
        实现。
        service 实现于 apps/srv/src/veriq_server/handlers/resource.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        cls = PublishService if publish else ResourceService
        return cls(
            session,
            user,
            self.application.settings.get("identity_reference_registry"),
            engine_version=self.config.validation_engine_version,
            settings=self.config,
            form_origin=self.request.headers.get(FORM_ORIGIN_HEADER),
        )

    async def get(
        self, workspace_id: str, resource_id: str | None = None, version_id: str | None = None
    ) -> None:
        """GET 分发资源元数据、草稿、预览、版本、依赖方、作业、校验回执与编译源；compiled-source 以沙箱 CSP 输出纯文本，
        防脚本执行。get 必须坚持 Workspace 归属与成员授权，

        嵌套资源引用不得跨空间隐式放行。
        """
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions() as s:
            user, _ = await self.identity(s)
            if self.action == "dataset-copies":
                source = self.get_query_argument("sourceWorkspaceId")
                if validate_schema("Id", source):
                    raise Problem(400, "INVALID_FILTER", "Invalid source workspace ID")
                repo = await self.service(s, user).dataset_copy_source(scope, source)
                page = Page.read(
                    self,
                    {
                        "list": self.action,
                        "actor": user.id,
                        "workspaceId": workspace_id,
                        "source": source,
                    },
                    self.config.signing_key.get_secret_value(),
                )
                self.respond(await repo.dataset_versions(page))
                return
            await WorkspaceRepository(s, scope).authorize(user)
            repo = ResourceRepository(s, scope)
            if self.action in {"job", "validation-receipt"}:
                assert resource_id
                job = await repo.job(resource_id)
                if self.action == "job":
                    dto = job_dto(job)
                    facts = {}
                    # 服务端失败事实只能来自已经关闭的编译租约，旧设备事实仍由工作区及作业归属检查决定可见性。
                    if (
                        job.kind == "VALIDATE"
                        and job.state == "FINISHED"
                        and job.outcome == "ERROR"
                        and job.server_compilation_id is not None
                        and job.server_compile_expires_at is None
                        and job.active_attempt_id is None
                        and isinstance(job.server_compile_result, dict)
                    ):
                        facts = job.server_compile_result
                    if job.active_attempt_id:
                        attempt = await s.get(Attempt, job.active_attempt_id)
                        # 仅当 Attempt 仍属本 Workspace/作业时才投影诊断，防止串租户事实。
                        if (
                            attempt
                            and attempt.workspace_id == workspace_id
                            and attempt.job_id == job.id
                        ):
                            facts = attempt.facts
                    code = facts.get("errorCode")
                    if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code):
                        dto["errorCode"] = code
                    if facts.get("diagnostics"):
                        dto["diagnostics"] = facts["diagnostics"]
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
                if receipt is None or not validation_origin_matches(job, receipt):
                    raise Problem(
                        409,
                        "VALIDATION_RECEIPT_UNAVAILABLE",
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
                        "nextCursor": (
                            page.next(
                                (str(shown_v[-1].version_no), shown_v[-1].id),
                                len(rows_v) > page.limit,
                            )
                            if shown_v
                            else None
                        ),
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
                    "items": await _resource_list_items(
                        repo,
                        shown,
                        dataset_summary=self.action == "resources"
                        and filters.get("kind") == "DATASET",
                    ),
                    "nextCursor": (
                        page.next((shown[-1].key, shown[-1].id), len(rows) > page.limit)
                        if shown
                        else None
                    ),
                }
            )

    async def _preview_binding(
        self,
        scope: WorkspaceScope,
        resource_id: str,
        doc: dict[str, Any],
        *,
        resolve: bool = False,
        delivered: bool = False,
    ) -> DatasetBinding:
        async with self.db.sessions.begin() as session:
            user, _ = await self.identity(session)
            resource = await self.service(session, user).editable(scope, resource_id)
            if resource.kind != "DATASET":
                raise Problem(422, "DATASET_UNAVAILABLE", "Dataset cannot be previewed")
            result = await authorize_dataset(
                session,
                self.config,
                scope.workspace_id,
                user.id,
                doc["source"].get("environmentVersionId"),
                doc,
                resolve=resolve,
            )
            if delivered:
                audit(
                    session,
                    "dataset.http.previewed",
                    user.id,
                    resource_id,
                    workspace_id=scope.workspace_id,
                )
            return result

    async def post(self, workspace_id: str, resource_id: str | None = None) -> None:
        """POST 创建资源、异步启动校验（202）或在校验回执通过后发布不可变版本；validate 返回 202 表示作业已入队，
        不是已通过。post 必须坚持 Workspace 归属与成员授权，

        嵌套资源引用不得跨空间隐式放行。
        """
        data = (
            self._resource_write_body("ResourceCreate")
            if self.action == "resources"
            else self.body(
                {
                    "dataset-copies": "DatasetCopyRequest",
                    "http-preview": "HttpDatasetPreviewRequest",
                    "validate": "ValidationRequest",
                    "publish": "PublishRequest",
                }[self.action]
            )
        )
        scope = WorkspaceScope(workspace_id)
        if self.action == "http-preview":
            assert resource_id
            doc = data["document"]
            config, secret = await self._preview_binding(scope, resource_id, doc, resolve=True)
            if "verifySignature" in data:
                output = verify_signature(
                    config, data["arguments"], secret, data["verifySignature"]
                )
            else:

                async def recheck() -> None:
                    await self._preview_binding(scope, resource_id, doc)

                output = masked_preview(
                    await fetch_rows(config, data["arguments"], secret, recheck=recheck)
                )
            await self._preview_binding(scope, resource_id, doc, delivered=True)
            self.set_header("Cache-Control", "no-store")
            self.respond(output)
            return
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            service = self.service(s, user)
            if self.action == "resources":
                result = await service.create(scope, data)
            elif self.action == "dataset-copies":
                result = await service.copy_dataset(scope, data)
            elif self.action == "validate":
                assert resource_id
                result = await service.validate(
                    scope, resource_id, data["revision"], data["sourceHash"]
                )
            else:
                assert resource_id
                publish_service = self.service(s, user, publish=True)
                assert isinstance(publish_service, PublishService)
                result = await publish_service.publish(
                    scope, resource_id, data["revision"], data["validationReceiptId"]
                )
        self.respond(result, 202 if self.action == "validate" else 201)

    async def put(self, workspace_id: str, resource_id: str) -> None:
        """PUT draft：在安装锁下按 revision 乐观并发写入草稿内容；revision 不匹配时由服务层映射并发冲突。put 必须坚持
        Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        data = self._resource_write_body("DraftWrite")
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            result = await self.service(s, user).update_draft(
                WorkspaceScope(workspace_id), resource_id, data["revision"], data["content"]
            )
        self.respond(result)

    async def patch(self, workspace_id: str, resource_id: str) -> None:
        """PATCH 更新显示名与归档态；要求 EDIT 写权限并按资源 kind 再授权；归档态根据是否已有 latest_version_id 回退
        PUBLISHED/DRAFT。
        patch 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        data = self.body("ResourceUpdate")
        scope = WorkspaceScope(workspace_id)
        async with self.db.sessions.begin() as s:
            await lock_installation(s)
            user, _ = await self.identity(s)
            await WorkspaceRepository(s, scope).authorize(user, Permission.EDIT, write=True)
            resource = await ResourceRepository(s, scope).resource(resource_id)
            service = self.service(s, user)
            await service.authorize(scope, resource.kind)
            previous = (resource.name, resource.status)
            resource.name = data["name"]
            if "archived" in data:
                if data["archived"]:
                    resource.status = "ARCHIVED"
                else:
                    resource.status = "PUBLISHED" if resource.latest_version_id else "DRAFT"
            audit(s, "resource.updated", user.id, resource.id, workspace_id=workspace_id)
            if service.form_origin is not None and previous != (resource.name, resource.status):
                draft = await ResourceRepository(s, scope).draft(resource.id)
                await service.record_draft_form(draft, "resource.updated")
            result = resource_dto(resource)
        self.respond(result)
