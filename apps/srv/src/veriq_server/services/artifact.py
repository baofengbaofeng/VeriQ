"""产物存储抽象提供 File 与 S3 后端，按 Workspace、digest 与可选 incarnation 存取，并与发布围栏的 retire/delete 对齐。
ArtifactService 在用户授权下读取 Attempt 产物并判定敏感级别；verify 拒绝摘要或大小不匹配的字节。
listed_offline_artifact 用于离线导入确认上传出现在清单后方可提交。
"""


import asyncio
import os
import re
import tempfile
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..db import (
    Artifact,
    ArtifactPublication,
    Attempt,
    AttemptUpload,
    User,
    OfflineAttempt,
    OfflineImport,
    OfflineImportUpload,
)
from ..service import Problem
from ..settings import Settings
from .workspace import WorkspaceRepository

MAX_FILE = 32 * 1024 * 1024
RAW_KINDS = {"TRACE", "HTML", "SCREENSHOT", "DOWNLOAD", "LOG", "JUNIT"}


def listed_offline_artifact(document: dict[str, Any], upload: OfflineImportUpload) -> bool:
    """判断离线上传是否出现在清单文档中，决定是否允许提交该 digest，listed_offline_artifact 遵守本文件边界。
    listed_offline_artifact 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    return any(
        file["path"] == upload.path
        and file["sha256"] == upload.sha256
        and file["sizeBytes"] == upload.size_bytes
        and file.get("kind") == upload.kind
        for file in document.get("artifacts", [])
    )


def key(workspace: str, digest: str, incarnation: str | None = None) -> str:
    """构造存储对象键，包含 Workspace、digest 与可选 incarnation，防止代际互相覆盖，key 遵守本文件边界。
    key 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    if str(UUID(workspace)) != workspace or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("INVALID_ARTIFACT_KEY")
    if incarnation is not None and str(UUID(incarnation)) != incarnation:
        raise ValueError("INVALID_ARTIFACT_INCARNATION")
    return f"{workspace}/{digest}" + (f".{incarnation}" if incarnation else "")


def verify(content: bytes, digest: str, size: int) -> bytes:
    """校验内容 sha256 与声明大小一致且不超过上限，失败则拒绝写入，verify 遵守本文件边界，失败返回稳定 Problem。
    verify 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    if size > MAX_FILE or len(content) != size or sha256(content).hexdigest() != digest:
        raise ValueError("INVALID_ARTIFACT_BYTES")
    return content


class ArtifactStore(Protocol):
    """产物存储协议定义 put/read/delete/retire，供 FILE 与 S3 实现切换而不改业务层，ArtifactStore 遵守本文件边界。
    ArtifactStore 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    async def put(
        self, workspace: str, digest: str, content: bytes, incarnation: str | None = None
    ) -> None: ...
    async def read(
        self, workspace: str, digest: str, size: int, incarnation: str | None = None
    ) -> bytes: ...
    async def delete(self, workspace: str, digest: str, incarnation: str | None = None) -> None: ...
    async def retire(self, workspace: str, digest: str, incarnation: str | None = None) -> None: ...


class FileArtifactStore:
    """本地目录后端按键落盘，目录模式 0700，retire 保留代际以便恢复窗口，FileArtifactStore 遵守本文件边界。
    FileArtifactStore 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    def __init__(self, root: Path):
        """解析并保存根目录绝对路径，后续路径拼接都相对于该根，FileArtifactStore.__init__ 遵守本文件边界。
        __init__ 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        self.root = root.resolve()

    def _path(self, workspace: str, digest: str, incarnation: str | None = None) -> Path:
        path = self.root / key(workspace, digest, incarnation)
        if path.parent.is_symlink() or path.is_symlink():
            raise ValueError("UNSAFE_ARTIFACT_PATH")
        return path

    async def put(
        self, workspace: str, digest: str, content: bytes, incarnation: str | None = None
    ) -> None:
        """校验摘要后原子 staging 写入，已存在则复验字节，避免半写入文件，FileArtifactStore.put 遵守本文件边界。
        put 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        verify(content, digest, len(content))

        def write() -> None:
            path = self._path(workspace, digest, incarnation)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".stage-")
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    verify(path.read_bytes(), digest, len(content))
                directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                os.unlink(temporary)

        await asyncio.to_thread(write)

    async def read(
        self, workspace: str, digest: str, size: int, incarnation: str | None = None
    ) -> bytes:
        """读取指定 digest 字节并复验摘要与大小，路径穿越或符号链接拒绝，FileArtifactStore.read 遵守本文件边界。
        read 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        def read() -> bytes:
            path = self._path(workspace, digest, incarnation)
            with path.open("rb") as stream:
                return verify(stream.read(min(size, MAX_FILE) + 1), digest, size)

        return await asyncio.to_thread(read)

    async def delete(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        """删除对象文件；缺失视为幂等成功，供维护清理调用，FileArtifactStore.delete 遵守本文件边界，失败返回稳定 Problem。
        delete 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        await asyncio.to_thread(self._path(workspace, digest, incarnation).unlink, missing_ok=True)

    async def retire(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        """将当前对象迁到 incarnation 键，腾出主键给新内联或新代写入，FileArtifactStore.retire 遵守本文件边界。
        retire 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        def barrier() -> None:
            path = self._path(workspace, digest, incarnation)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".retire-")
            try:
                with os.fdopen(fd, "wb") as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
                directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                Path(temporary).unlink(missing_ok=True)

        await asyncio.to_thread(barrier)


class S3ArtifactStore:
    """S3 兼容后端，对象键隔离 Workspace，delete/retire 映射对象生命周期操作，S3ArtifactStore 遵守本文件边界。
    S3ArtifactStore 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    def __init__(self, bucket: str, endpoint: str | None = None, region: str = "us-east-1"):
        """保存 bucket、endpoint 与 region，惰性创建客户端以免无配置崩溃，S3ArtifactStore.__init__ 遵守本文件边界。
        __init__ 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        self.bucket, self.endpoint, self.region = bucket, endpoint, region
        self._client: Any = None

    @property
    def client(self) -> Any:
        """构造 boto3 客户端；endpoint 可用于兼容实现与本地测试，S3ArtifactStore.client 遵守本文件边界。
        client 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        if self._client is None:
            import boto3  # type: ignore[import-untyped]
            from botocore.config import Config  # type: ignore[import-untyped]

            self._client = boto3.client(
                "s3",
                endpoint_url=self.endpoint,
                region_name=self.region,
                config=Config(
                    connect_timeout=5,
                    read_timeout=15,
                    retries={"max_attempts": 1},
                    s3={"addressing_style": "path"},
                ),
            )
        return self._client

    async def put(
        self, workspace: str, digest: str, content: bytes, incarnation: str | None = None
    ) -> None:
        """校验后上传对象，键含 Workspace 与 digest，可选 incarnation 后缀，S3ArtifactStore.put 遵守本文件边界。
        put 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        from botocore.exceptions import ClientError  # type: ignore[import-untyped]

        verify(content, digest, len(content))
        object_key = key(workspace, digest, incarnation)

        def write() -> None:
            try:
                self.client.put_object(
                    Bucket=self.bucket,
                    Key=object_key,
                    Body=content,
                    IfNoneMatch="*",
                    ContentType="application/octet-stream",
                )
            except ClientError as exc:
                if exc.response["ResponseMetadata"]["HTTPStatusCode"] != 412:
                    raise
                self._read(object_key, digest, len(content))

        await asyncio.to_thread(write)

    def _read(self, object_key: str, digest: str, size: int) -> bytes:
        result = self.client.get_object(Bucket=self.bucket, Key=object_key)
        try:
            return verify(result["Body"].read(min(size, MAX_FILE) + 1), digest, size)
        finally:
            result["Body"].close()

    async def read(
        self, workspace: str, digest: str, size: int, incarnation: str | None = None
    ) -> bytes:
        """下载对象并复验摘要大小，不匹配则视为损坏，S3ArtifactStore.read 遵守本文件边界，失败返回稳定 Problem。
        read 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        return await asyncio.to_thread(
            self._read, key(workspace, digest, incarnation), digest, size
        )

    async def delete(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        """删除对象键；不存在视为幂等成功，S3ArtifactStore.delete 遵守本文件边界，失败返回稳定 Problem。
        delete 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        await asyncio.to_thread(
            lambda: self.client.delete_object(
                Bucket=self.bucket, Key=key(workspace, digest, incarnation)
            )
        )

    async def retire(self, workspace: str, digest: str, incarnation: str | None = None) -> None:
        """复制或迁移到 incarnation 键后删除主键，配合围栏退休，S3ArtifactStore.retire 遵守本文件边界。
        retire 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        # Keep the key occupied forever: late conditional puts cannot resurrect bytes.
        await asyncio.to_thread(
            lambda: self.client.put_object(
                Bucket=self.bucket,
                Key=key(workspace, digest, incarnation),
                Body=b"",
                ContentType="application/octet-stream",
                Metadata={"veriq-retired": "true"},
            )
        )


def artifact_store(settings: Settings, backend: str | None = None) -> ArtifactStore:
    """按 Settings.artifact_backend 选择 FILE 或 S3 实现并返回 ArtifactStore。
    artifact_store 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    if (backend or settings.artifact_backend) == "FILE":
        return FileArtifactStore(Path(settings.artifact_directory))
    if not settings.artifact_s3_bucket:
        raise Problem(503, "ARTIFACT_STORE_UNAVAILABLE", "S3 bucket is not configured")
    return S3ArtifactStore(
        settings.artifact_s3_bucket, settings.artifact_s3_endpoint, settings.artifact_s3_region
    )


def effective_sensitivity(metadata: dict[str, Any]) -> str:
    """从元数据推导证据敏感级别，影响下载授权与是否需要强权限，effective_sensitivity 遵守本文件边界，失败返回稳定 Problem。
    effective_sensitivity 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    # Raw uploads are not proof of sanitized content, including caller-labelled LOG/SOURCE.
    return "CREDENTIAL_RESTRICTED"


class ArtifactService:
    """在用户与 Workspace 授权下列出或读取 Attempt 产物，强制租户边界，ArtifactService 遵守本文件边界。
    ArtifactService 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    def __init__(self, session: AsyncSession, user: User):
        """保存会话与用户，后续授权经 WorkspaceRepository 判定，ArtifactService.__init__ 遵守本文件边界。
        __init__ 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        self.session, self.user = session, user

    async def authorized(
        self, scope: WorkspaceScope, attempt_id: str, upload_id: str
    ) -> tuple[AttemptUpload | OfflineImportUpload, Artifact]:
        """校验用户对 Attempt 所属 Workspace 的下载类权限后返回作用域，ArtifactService.authorized 遵守本文件边界。
        authorized 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        await WorkspaceRepository(self.session, scope).authorize(
            self.user, Permission.MANAGE_ENVIRONMENT
        )
        offline = await self.session.get(OfflineAttempt, attempt_id)
        if offline and offline.workspace_id == scope.workspace_id:
            imported = await self.session.get(OfflineImport, offline.import_id)
            offline_upload = await self.session.get(OfflineImportUpload, upload_id)
            if (
                not imported
                or not offline_upload
                or offline_upload.workspace_id != scope.workspace_id
                or offline_upload.bundle_id != imported.bundle_id
                or offline_upload.local_run_id != imported.local_run_id
                or offline_upload.local_attempt_id != offline.local_attempt_id
                or offline_upload.state != "COMPLETE"
                or not listed_offline_artifact(offline.document, offline_upload)
            ):
                raise Problem(404, "ARTIFACT_NOT_FOUND", "Artifact not found in this Attempt")
            artifact = await self.session.get(Artifact, (scope.workspace_id, offline_upload.sha256))
            publication = (
                await self.session.get(ArtifactPublication, artifact.storage_incarnation)
                if artifact and artifact.storage_incarnation
                else None
            )
            if (
                not artifact
                or offline_upload.expired_at
                or artifact.expired_at
                or (publication and publication.state == "RETIRED")
            ):
                raise Problem(410, "ARTIFACT_EXPIRED", "Evidence retention has expired")
            return offline_upload, artifact
        attempt = await self.session.get(Attempt, attempt_id)
        upload = await self.session.get(AttemptUpload, upload_id)
        if (
            not attempt
            or attempt.workspace_id != scope.workspace_id
            or not upload
            or upload.workspace_id != scope.workspace_id
            or upload.attempt_id != attempt.id
            or not upload.complete
        ):
            raise Problem(404, "ARTIFACT_NOT_FOUND", "Artifact not found in this Attempt")
        artifact = await self.session.get(Artifact, (scope.workspace_id, upload.sha256))
        if not artifact:
            raise Problem(409, "INVALID_ARTIFACT", "Artifact metadata missing")
        publication = (
            await self.session.get(ArtifactPublication, artifact.storage_incarnation)
            if artifact.storage_incarnation
            else None
        )
        if (
            upload.expired_at
            or artifact.expired_at
            or (publication and publication.state == "RETIRED")
        ):
            raise Problem(410, "ARTIFACT_EXPIRED", "Evidence retention has expired")
        return upload, artifact
