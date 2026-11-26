"""ResourceRepository 在已授权 WorkspaceScope 内读取资源、草稿、版本、任务与内联产物，写路径必须先持有安装行锁护栏。
全部查询附加 workspace_id；产物读取校验 sha256、长度与未过期；

store 以内容寻址写入 INLINE。外部后端未过期对象在钉死内联字节前先 retire，避免双后端同时指向同一 digest。
"""

from hashlib import sha256
from typing import Any, Protocol, cast
from sqlalchemy import and_, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..db import (
    Resource,
    ResourceDraft,
    ResourceVersion,
    Artifact,
    Job,
    ValidationReceipt,
)
from ..pagination import Page
from ..service import Problem, stamp


class InlineArtifact(Protocol):
    """内联产物协议暴露只读 content 与 size_bytes，供仓储校验后返回视图，InlineArtifact 路径必须遵守 Workspace 作用域。
    InlineArtifact 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
    错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    @property
    def content(self) -> bytes:
        """返回已通过 sha256 校验的原始字节；不得假设可写，InlineArtifact.content 路径必须遵守 Workspace 作用域。
        content 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        ...

    @property
    def size_bytes(self) -> int:
        """返回与 content 长度一致的字节数，供清单交叉核对，InlineArtifact.size_bytes 路径必须遵守 Workspace 作用域。
        size_bytes 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        ...


class ResourceRepository:
    """绑定会话与 WorkspaceScope 的资源仓储，拒绝无租户谓词访问，ResourceRepository 路径必须遵守 Workspace 作用域。
    ResourceRepository 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
    错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def __init__(self, session: AsyncSession, scope: WorkspaceScope):
        """保存 AsyncSession 与 WorkspaceScope，查找强制带 workspace_id，ResourceRepository.__init__ 路径必须遵守
        Workspace 作用域。
        __init__ 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.session, self.scope = session, scope

    async def resource(self, resource_id: str) -> Resource:
        """按 Workspace 与资源 ID 加载资源头，缺失则 RESOURCE_NOT_FOUND，ResourceRepository.resource 路径必须遵守
        Workspace 作用域。
        resource 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        row = (
            await self.session.execute(
                select(Resource).where(
                    Resource.workspace_id == self.scope.workspace_id, Resource.id == resource_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "RESOURCE_NOT_FOUND", "Resource not found")
        return row

    async def draft(self, resource_id: str) -> ResourceDraft:
        """加载同租户草稿，缺失 DRAFT_NOT_FOUND，不回落其他租户，ResourceRepository.draft 路径必须遵守 Workspace
        作用域。
        draft 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        row = (
            await self.session.execute(
                select(ResourceDraft).where(
                    ResourceDraft.workspace_id == self.scope.workspace_id,
                    ResourceDraft.resource_id == resource_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "DRAFT_NOT_FOUND", "Draft not found")
        return row

    async def dataset_summaries(self, resource_ids: list[str]) -> dict[str, dict[str, Any]]:
        """批量投影已授权分页中的数据集草稿和发布修订，只返回形状、计数与时间，不提取正文或访问上游服务。"""
        if not resource_ids:
            return {}
        # 历史草稿的字段和行位于旧路径，且只支持静态表；新文档由形状及来源分类，空对象或数组的长度仍为零。
        document = ResourceDraft.document_json
        # 最新发布指针必须同时匹配工作区与资源；版本正文不参与计数，发布时间也不会覆盖草稿自己的保存时间。
        query = (
            select(
                Resource.id,
                func.json_unquote(func.json_extract(document, "$.document.source.kind")).label(
                    "source_kind"
                ),
                func.json_unquote(func.json_extract(document, "$.document.shape")).label("shape"),
                func.coalesce(
                    func.json_length(document, "$.document.fields"),
                    func.json_length(document, "$.document.columns"),
                ).label("field_count"),
                func.coalesce(
                    func.json_length(document, "$.document.source.rows"),
                    func.json_length(document, "$.document.rows"),
                ).label("entry_count"),
                ResourceDraft.revision,
                ResourceDraft.updated_at,
                ResourceVersion.draft_revision.label("published_revision"),
            )
            .join(
                ResourceDraft,
                and_(
                    ResourceDraft.workspace_id == Resource.workspace_id,
                    ResourceDraft.resource_id == Resource.id,
                ),
            )
            .outerjoin(
                ResourceVersion,
                and_(
                    ResourceVersion.workspace_id == Resource.workspace_id,
                    ResourceVersion.resource_id == Resource.id,
                    ResourceVersion.id == Resource.latest_version_id,
                ),
            )
            .where(
                Resource.workspace_id == self.scope.workspace_id,
                Resource.kind == "DATASET",
                Resource.id.in_(resource_ids),
            )
        )
        summaries = {}
        for row in await self.session.execute(query):
            # 一次新建或复制只创建初始修订，沿用现有草稿状态；后续保存及已发布资源的更新则与发布基线比较。
            baseline = row.published_revision if row.published_revision is not None else 1
            summary = {
                "format": f"{row.source_kind or 'STATIC'}_{row.shape or 'TABLE'}",
                "fieldCount": row.field_count,
                "lastSavedAt": stamp(row.updated_at),
                "hasUnpublishedChanges": row.revision > baseline,
            }
            if row.source_kind != "HTTP":
                summary["entryCount"] = row.entry_count
            summaries[row.id] = summary
        return summaries

    async def dataset_versions(self, page: Page) -> dict[str, Any]:
        """清单只投影来源空间内已发布数据集的身份与展示字段，翻页不读取或传送可能很大的版本正文。"""
        query = (
            select(
                Resource.id,
                Resource.key,
                Resource.name,
                ResourceVersion.id,
                ResourceVersion.version_no,
            )
            .join(ResourceVersion, ResourceVersion.resource_id == Resource.id)
            .where(
                Resource.workspace_id == self.scope.workspace_id,
                ResourceVersion.workspace_id == self.scope.workspace_id,
                Resource.kind == "DATASET",
            )
        )
        if page.last:
            query = query.where(
                tuple_(Resource.key, ResourceVersion.version_no) > (page.last[0], int(page.last[1]))
            )
        rows = (
            await self.session.execute(
                query.order_by(Resource.key, ResourceVersion.version_no).limit(page.limit + 1)
            )
        ).all()
        items = [
            {"resourceId": rid, "key": key, "name": name, "versionId": vid, "versionNo": number}
            for rid, key, name, vid, number in rows[: page.limit]
        ]
        return {
            "items": items,
            "nextCursor": (
                page.next((items[-1]["key"], str(items[-1]["versionNo"])), len(rows) > page.limit)
                if items
                else None
            ),
        }

    async def version(self, version_id: str) -> ResourceVersion:
        """读取不可变版本，必须属当前 Workspace，否则 VERSION_NOT_FOUND，ResourceRepository.version 路径必须遵守
        Workspace 作用域。
        version 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        row = (
            await self.session.execute(
                select(ResourceVersion).where(
                    ResourceVersion.workspace_id == self.scope.workspace_id,
                    ResourceVersion.id == version_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "VERSION_NOT_FOUND", "Version not found")
        return row

    async def job(self, job_id: str) -> Job:
        """在当前 Workspace 查找 Job，防止全局 job_id 跨租户误读，ResourceRepository.job 路径必须遵守 Workspace 作用域。
        job 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        row = (
            await self.session.execute(
                select(Job).where(Job.workspace_id == self.scope.workspace_id, Job.id == job_id)
            )
        ).scalar_one_or_none()
        if row is None:
            raise Problem(404, "JOB_NOT_FOUND", "Job not found")
        return row

    async def receipt(self, receipt_id: str) -> ValidationReceipt | None:
        """按回执 ID 查找校验回执，允许 None 由调用方判定合法性，ResourceRepository.receipt 路径必须遵守 Workspace
        作用域。
        receipt 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        return (
            await self.session.execute(
                select(ValidationReceipt).where(
                    ValidationReceipt.workspace_id == self.scope.workspace_id,
                    ValidationReceipt.id == receipt_id,
                )
            )
        ).scalar_one_or_none()

    async def artifact(self, digest: str) -> InlineArtifact:
        """读取未过期 INLINE 产物并校验摘要与长度，损坏则 INVALID_ARTIFACT，ResourceRepository.artifact 路径必须遵守
        Workspace 作用域。
        artifact 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        row = await self.session.get(Artifact, (self.scope.workspace_id, digest))
        if (
            row is None
            or row.content is None
            or row.expired_at is not None
            or row.sha256 != sha256(row.content).hexdigest()
            or row.size_bytes != len(row.content)
        ):
            raise Problem(409, "INVALID_ARTIFACT", "Immutable artifact missing or corrupt")
        return cast(InlineArtifact, row)

    async def store(self, content: bytes, media_type: str = "application/json") -> str:
        """内容寻址写入 INLINE；外部后端仍有效时先 retire 再钉死字节，ResourceRepository.store 路径必须遵守 Workspace
        作用域。
        已存在完好内联产物走 artifact() 校验，返回 digest。
        store 实现于 apps/srv/src/veriq_server/repositories/resource.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        digest = sha256(content).hexdigest()
        existing = await self.session.get(Artifact, (self.scope.workspace_id, digest))
        if existing is None:
            self.session.add(
                Artifact(
                    workspace_id=self.scope.workspace_id,
                    sha256=digest,
                    content=content,
                    size_bytes=len(content),
                    media_type=media_type,
                )
            )
            await self.session.flush()
        elif existing.content is None or existing.expired_at is not None:
            # 后续源码或清单写入会把精确字节钉死为内联；原始读取 ACL 仍绑定 AttemptUpload，而不是物理存储形态本身。
            if existing.storage_backend != "INLINE" and existing.expired_at is None:
                from ..services.publication import retire

                await retire(
                    self.session,
                    self.scope.workspace_id,
                    digest,
                    existing.storage_backend,
                    existing.storage_incarnation,
                )
            from ..services.jobs import database_time

            existing.created_at = await database_time(self.session)
            existing.content = content
            existing.storage_backend = "INLINE"
            existing.storage_incarnation = None
            existing.expired_at = existing.deleted_at = None
            await self.session.flush()
        else:
            await self.artifact(digest)
        return digest
