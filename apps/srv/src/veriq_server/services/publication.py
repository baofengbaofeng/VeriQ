"""产物发布围栏：retire/recover/expire_offline 管理 PENDING 到 COMMITTED/RETIRED 与外部对象清理，均限定 Workspace。
offline_pins 判断 digest 是否仍被离线导入钉住，决定过期删除是否必须让路。
恢复路径按 limit 批量推进，避免一次扫描拖垮控制面事务。
"""


from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import (
    Artifact,
    ArtifactDeletion,
    ArtifactPublication,
    AttemptUpload,
    Attempt,
    Job,
    OfflineImportUpload,
)
from .jobs import database_time


async def retire(
    session: AsyncSession, workspace: str, digest: str, backend: str, incarnation: str | None
) -> None:
    """将指定 digest 的外部 incarnation 标为待删除并推进围栏 RETIRED，供内联钉死前调用，retire 遵守本文件 Workspace/事务边界。"""
    if incarnation:
        publication = await session.get(ArtifactPublication, incarnation)
        if publication:
            publication.state = "RETIRED"
    previous = (
        await session.execute(
            select(ArtifactDeletion.id)
            .where(
                ArtifactDeletion.workspace_id == workspace,
                ArtifactDeletion.sha256 == digest,
                ArtifactDeletion.storage_backend == backend,
                ArtifactDeletion.storage_incarnation == incarnation,
            )
            .limit(1)
        )
    ).first()
    if not previous:
        session.add(
            ArtifactDeletion(
                id=str(uuid4()),
                workspace_id=workspace,
                sha256=digest,
                storage_backend=backend,
                storage_incarnation=incarnation,
            )
        )


async def recover(session: AsyncSession, workspace: str, limit: int) -> None:
    """在 Workspace 内批量恢复或清理卡住的 publication/deletion 行，受 limit 限制，recover 遵守本文件 Workspace/事务边界。"""
    current = await database_time(session)
    pending = (
        (
            await session.execute(
                select(ArtifactPublication)
                .where(
                    ArtifactPublication.workspace_id == workspace,
                    ArtifactPublication.state == "PENDING",
                )
                .order_by(ArtifactPublication.id)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    for publication in pending:
        artifact = await session.get(Artifact, (workspace, publication.sha256))
        same = bool(
            artifact
            and not artifact.expired_at
            and artifact.storage_backend == publication.storage_backend
            and artifact.storage_incarnation == publication.id
        )
        offline = list(
            (
                await session.execute(
                    select(OfflineImportUpload).where(
                        OfflineImportUpload.workspace_id == workspace,
                        OfflineImportUpload.sha256 == publication.sha256,
                        OfflineImportUpload.expired_at.is_(None),
                    )
                )
            ).scalars()
        )
        if same and any(u.state == "COMPLETE" for u in offline):
            publication.state = "COMMITTED"
            continue
        if same and any(u.expires_at > current for u in offline):
            continue
        references = select(AttemptUpload.id).where(
            AttemptUpload.workspace_id == workspace,
            AttemptUpload.sha256 == publication.sha256,
            AttemptUpload.expired_at.is_(None),
        )
        if (
            same
            and (
                await session.execute(references.where(AttemptUpload.complete.is_(True)).limit(1))
            ).first()
        ):
            publication.state = "COMMITTED"
            continue
        active = (
            references.join(Attempt, Attempt.id == AttemptUpload.attempt_id)
            .join(Job, Job.id == Attempt.job_id)
            .where(
                Attempt.phase != "FINISHED",
                Attempt.lease_expires_at > current,
                Job.active_attempt_id == Attempt.id,
                Job.fence == Attempt.fencing_token,
            )
            .limit(1)
        )
        if same and (await session.execute(active)).first():
            continue
        await retire(
            session, workspace, publication.sha256, publication.storage_backend, publication.id
        )
        if same:
            assert artifact
            artifact.expired_at = current


async def offline_pins(session: AsyncSession, workspace: str, digest: str) -> bool:
    """检查离线导入是否仍钉住该 digest，防止过早物理删除仍需展示的证据，offline_pins 遵守本文件 Workspace/事务边界。"""
    current = await database_time(session)
    rows = (
        await session.execute(
            select(OfflineImportUpload).where(
                OfflineImportUpload.workspace_id == workspace,
                OfflineImportUpload.sha256 == digest,
                OfflineImportUpload.expired_at.is_(None),
            )
        )
    ).scalars()
    return any(u.state == "COMPLETE" or u.expires_at > current for u in rows)


async def expire_offline(
    session: AsyncSession, workspace: str, limit: int, after: str = ""
) -> tuple[int, str, bool]:
    """按保留策略过期离线产物并排队删除，遇到 pins 则跳过该 digest，expire_offline 遵守本文件 Workspace/事务边界。"""
    current = await database_time(session)
    rows = list(
        (
            await session.execute(
                select(OfflineImportUpload)
                .where(
                    OfflineImportUpload.workspace_id == workspace,
                    OfflineImportUpload.id > after,
                    OfflineImportUpload.expired_at.is_(None),
                    OfflineImportUpload.expires_at <= current,
                )
                .order_by(OfflineImportUpload.id)
                .limit(limit + 1)
            )
        ).scalars()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    for upload in rows:
        upload.expired_at = current
        upload.content = None
        await session.flush()
        if await offline_pins(session, workspace, upload.sha256):
            continue
        online = (
            await session.execute(
                select(AttemptUpload.id)
                .where(
                    AttemptUpload.workspace_id == workspace,
                    AttemptUpload.sha256 == upload.sha256,
                    AttemptUpload.expired_at.is_(None),
                )
                .limit(1)
            )
        ).first()
        if online:
            continue
        artifact = await session.get(Artifact, (workspace, upload.sha256))
        if not artifact or artifact.expired_at or artifact.storage_backend == "INLINE":
            continue
        # INLINE roots are immutable source content, not raw-store authority.
        artifact.expired_at = current
        await retire(
            session,
            workspace,
            artifact.sha256,
            artifact.storage_backend,
            artifact.storage_incarnation,
        )
    return len(rows), rows[-1].id if rows else after, more
