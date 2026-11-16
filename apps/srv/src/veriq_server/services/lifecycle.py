"""VeriQ 生命周期维护按有界游标压缩已经终结的报告与导出载荷，保留请求指纹、结果摘要和退役屏障；任何活动引用、隔离容量或未知清理事实都会阻止过期处理。"""

from datetime import timedelta
from typing import Any
import json
from sqlalchemy import select, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import (
    Attempt,
    AttemptEvent,
    AttemptUpload,
    ResourceLease,
    Job,
    Run,
    OfflineAttempt,
    OfflineImport,
    OfflineImportUpload,
    Bundle,
    BundleExport,
    Artifact,
    Base,
    AiGeneration,
    CaseExecution,
)
from ..service import Problem, stamp
from ..settings import Settings
from .jobs import database_time

PHASES = (
    "online",
    "offline",
    "exports",
    "uploads",
    "imports",
    "model-cache",
    "provenance",
    "cache",
)


async def archive_pinned(session: AsyncSession, workspace: str, bundle: Bundle) -> bool:
    """导出归档即使超过保留期也可能被其它不可变根引用，此处按已注册表的内容引用列逐项存在性检查，跳过的只有当前归档所有者，无法证明独占时继续保留而不破坏共享摘要。"""
    fields = {
        "snapshot_hash",
        "manifest_hash",
        "source_snapshot_hash",
        "source_hash",
        "compiled_bundle_sha256",
        "archive_hash",
    }
    for table in Base.metadata.tables.values():
        if "workspace_id" not in table.c:
            continue
        conditions = [table.c[name] == bundle.archive_hash for name in fields if name in table.c]
        if table.name in {"veriq_attempt_uploads", "veriq_offline_import_uploads"}:
            conditions.append(table.c.sha256 == bundle.archive_hash)
        if not conditions:
            continue
        query = (
            select(1).select_from(table).where(table.c.workspace_id == workspace, or_(*conditions))
        )
        if table.name == "veriq_bundles":
            query = query.where(
                or_(
                    table.c.id != bundle.id,
                    table.c.manifest_hash == bundle.archive_hash,
                    table.c.snapshot_hash == bundle.archive_hash,
                )
            )
        if (await session.execute(query.limit(1))).first():
            return True
    cleanup = (
        await session.execute(
            select(Job.id)
            .where(
                Job.workspace_id == workspace,
                Job.required_capabilities["cleanupSnapshotSha256"].as_string()
                == bundle.archive_hash,
            )
            .limit(1)
        )
    ).first()
    return cleanup is not None


async def expire_lifecycle(
    session: AsyncSession, settings: Settings, workspace: str, limit: int, cursor: str
) -> tuple[int, bool, str | None]:
    """单次请求只扫描一个阶段的一页记录，下一游标包含阶段和稳定主键；同一回执由既有维护幂等框架保存，删除事件以有限批次推进而不是在安装锁内处理无界历史。"""
    phase, separator, after = cursor.partition(":")
    if not cursor:
        phase, after = "online", ""
    if phase not in PHASES or (cursor and not separator):
        raise Problem(400, "INVALID_CURSOR", "Lifecycle cursor is invalid")
    if phase == "cache":
        from .cache_retention import expire_cache

        count, more, last = await expire_cache(session, settings, workspace, limit, after)
        return count, more, f"cache:{last}" if last else None
    current = await database_time(session)
    cutoff = current - timedelta(days=settings.metadata_retention_days)
    query: Any
    model: Any
    if phase == "online":
        query = select(Attempt).where(
            Attempt.workspace_id == workspace,
            Attempt.id > after,
            Attempt.phase == "FINISHED",
            Attempt.finished_at < cutoff,
            Attempt.capacity_state == "RELEASED",
        )
        model = Attempt
    elif phase == "offline":
        query = (
            select(OfflineAttempt)
            .join(OfflineImport, OfflineImport.id == OfflineAttempt.import_id)
            .join(Run, Run.id == OfflineImport.run_id)
            .where(
                OfflineAttempt.workspace_id == workspace,
                OfflineAttempt.id > after,
                OfflineImport.created_at < cutoff,
                Run.state == "FINISHED",
            )
        )
        model = OfflineAttempt
    elif phase == "exports":
        query = select(Bundle).where(
            Bundle.workspace_id == workspace,
            Bundle.id > after,
            Bundle.created_at < current - timedelta(days=settings.export_retention_days),
        )
        model = Bundle
    elif phase == "uploads":
        query = select(OfflineImportUpload).where(
            OfflineImportUpload.workspace_id == workspace,
            OfflineImportUpload.id > after,
            OfflineImportUpload.expires_at <= current,
            OfflineImportUpload.created_at
            < current - timedelta(days=settings.upload_retention_days),
        )
        model = OfflineImportUpload
    elif phase == "imports":
        query = select(OfflineImport).where(
            OfflineImport.workspace_id == workspace,
            OfflineImport.id > after,
            OfflineImport.created_at < cutoff,
        )
        model = OfflineImport
    elif phase == "provenance":
        query = (
            select(CaseExecution)
            .join(Run, Run.id == CaseExecution.run_id)
            .where(
                CaseExecution.workspace_id == workspace,
                CaseExecution.id > after,
                CaseExecution.state == "FINISHED",
                Run.state == "FINISHED",
                Run.created_at < cutoff,
            )
        )
        model = CaseExecution
    else:
        query = select(AiGeneration).where(
            AiGeneration.workspace_id == workspace,
            AiGeneration.id > after,
            AiGeneration.created_at < cutoff,
            AiGeneration.status.in_(["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "REVIEWED"]),
        )
        model = AiGeneration
    rows = list((await session.execute(query.order_by(model.id).limit(limit + 1))).scalars())
    processed = 0
    payload_budget = min(limit, 256) if phase == "provenance" else limit
    last = after
    for row in rows[:limit]:
        if payload_budget <= 0:
            return processed, True, f"{phase}:{last}"
        if phase == "online":
            held = (
                await session.execute(
                    select(ResourceLease.attempt_id)
                    .where(
                        ResourceLease.workspace_id == workspace,
                        ResourceLease.attempt_id == row.id,
                        ResourceLease.state != "RELEASED",
                    )
                    .limit(1)
                )
            ).first()
            pending = (
                await session.execute(
                    select(Job.id)
                    .where(
                        Job.workspace_id == workspace,
                        Job.origin_attempt_id == row.id,
                        or_(
                            Job.state != "FINISHED", Job.outcome != "PASSED", Job.outcome.is_(None)
                        ),
                    )
                    .limit(1)
                )
            ).first()
            owner = await session.get(Job, row.job_id)
            owner_run = await session.get(Run, owner.run_id) if owner and owner.run_id else None
            if (
                held
                or pending
                or not owner
                or owner.state != "FINISHED"
                or (owner_run and owner_run.state != "FINISHED")
                or row.facts.get("cleanup") not in {"SUCCEEDED", "NOT_REQUIRED"}
            ):
                last = row.id
                continue
            event_sequences = list(
                (
                    await session.execute(
                        select(AttemptEvent.sequence)
                        .where(
                            AttemptEvent.workspace_id == workspace,
                            AttemptEvent.attempt_id == row.id,
                        )
                        .order_by(AttemptEvent.sequence)
                        .limit(payload_budget + 1)
                    )
                ).scalars()
            )
            removed = event_sequences[:payload_budget]
            more_events = len(event_sequences) > payload_budget
            if removed:
                await session.execute(
                    delete(AttemptEvent).where(
                        AttemptEvent.workspace_id == workspace,
                        AttemptEvent.attempt_id == row.id,
                        AttemptEvent.sequence.in_(removed),
                    )
                )
            if not row.facts.get("metadataExpiredAt"):
                row.facts = {
                    **{
                        key: value
                        for key, value in row.facts.items()
                        if key
                        in {
                            "business",
                            "cleanup",
                            "evidence",
                            "errorCode",
                            "processStopped",
                            "processStopScope",
                            "stopConfirmation",
                        }
                    },
                    "metadataExpiredAt": stamp(current),
                }
            # 当前 Attempt 的事件可能超过整页预算，因此继续游标必须仍指向上一行；过期标记先提交，读路径立即拒绝部分删除后的不完整报告，围栏与完成回执原样保留。
            payload_budget -= len(removed)
            if more_events or payload_budget <= 0:
                return processed + len(removed), True, f"{phase}:{last}"
            uploads = list(
                (
                    await session.execute(
                        select(AttemptUpload)
                        .where(
                            AttemptUpload.workspace_id == workspace,
                            AttemptUpload.attempt_id == row.id,
                            AttemptUpload.complete.is_(False),
                            AttemptUpload.expired_at.is_(None),
                        )
                        .limit(payload_budget + 1)
                    )
                ).scalars()
            )
            more_uploads = len(uploads) > payload_budget
            for upload in uploads[:payload_budget]:
                upload.expired_at, upload.content = current, b""
            payload_budget -= min(len(uploads), payload_budget)
            if more_uploads:
                return processed + len(removed) + len(uploads) - 1, True, f"{phase}:{last}"
        elif phase == "offline":
            if not row.facts.get("metadataExpiredAt"):
                row.document = {**row.document, "events": []}
                row.facts = {**row.facts, "metadataExpiredAt": stamp(current)}
        elif phase == "exports":
            manifest = await session.get(Artifact, (workspace, row.manifest_hash))
            archive = await session.get(Artifact, (workspace, row.archive_hash))
            if not manifest or not manifest.content or not archive or archive.expired_at:
                last = row.id
                continue
            document = json.loads(manifest.content)
            from datetime import datetime, timezone

            expiration = (
                datetime.fromisoformat(document["expiresAt"].replace("Z", "+00:00"))
                .astimezone(timezone.utc)
                .replace(tzinfo=None)
            )
            active = (
                await session.execute(
                    select(OfflineImportUpload.id)
                    .where(
                        OfflineImportUpload.workspace_id == workspace,
                        OfflineImportUpload.bundle_id == row.id,
                        OfflineImportUpload.expired_at.is_(None),
                        OfflineImportUpload.expires_at > current,
                    )
                    .limit(1)
                )
            ).first()
            reservation = (
                await session.execute(
                    select(BundleExport.id)
                    .where(
                        BundleExport.workspace_id == workspace,
                        BundleExport.bundle_id == row.id,
                        BundleExport.state == "IN_PROGRESS",
                    )
                    .limit(1)
                )
            ).first()
            # 已签名包在有效期内仍是离线回传的验证权威，即使下载保留期更短也不能先清除它；只清除独立归档载荷，清单、快照、签名和幂等映射继续保留以拒绝迟到复活。
            if (
                expiration > current
                or active
                or reservation
                or archive.storage_backend != "INLINE"
                or await archive_pinned(session, workspace, row)
            ):
                last = row.id
                continue
            archive.content, archive.expired_at, archive.deleted_at = None, current, current
        elif phase == "uploads":
            if row.state == "COMPLETE" and not row.expired_at:
                last = row.id
                continue
            row.expired_at, row.content = row.expired_at or current, None
        elif phase == "imports":
            attempts = list(
                (
                    await session.execute(
                        select(OfflineAttempt.facts).where(
                            OfflineAttempt.workspace_id == workspace,
                            OfflineAttempt.import_id == row.id,
                        )
                    )
                ).scalars()
            )
            if not attempts or any(not facts.get("metadataExpiredAt") for facts in attempts):
                last = row.id
                continue
            row.declared = {
                key: value
                for key, value in row.declared.items()
                if key in {"bundleId", "localRunId", "manifestSha256", "dirty", "schemaVersion"}
            }
            row.declared = {**row.declared, "metadataExpiredAt": stamp(current)}
        elif phase == "provenance":
            jobs = list(
                (
                    await session.execute(
                        select(Job)
                        .where(Job.workspace_id == workspace, Job.case_execution_id == row.id)
                        .limit(33)
                    )
                ).scalars()
            )
            attempts = list(
                (
                    await session.execute(
                        select(Attempt)
                        .join(Job, Job.id == Attempt.job_id)
                        .where(Attempt.workspace_id == workspace, Job.case_execution_id == row.id)
                        .limit(33)
                    )
                ).scalars()
            )
            offline = list(
                (
                    await session.execute(
                        select(OfflineAttempt)
                        .where(
                            OfflineAttempt.workspace_id == workspace,
                            OfflineAttempt.case_execution_id == row.id,
                        )
                        .limit(33)
                    )
                ).scalars()
            )
            if (
                len(jobs) > 32
                or len(attempts) > 32
                or len(offline) > 32
                or any(job.state != "FINISHED" for job in jobs)
                or any(
                    not attempt.facts.get("metadataExpiredAt") for attempt in [*attempts, *offline]
                )
            ):
                last = row.id
                continue
            row.provenance = {
                **{
                    key: value
                    for key, value in row.provenance.items()
                    if key
                    in {"source", "engineVersion", "validationStatus", "publishedCaseVersionId"}
                },
                "metadataExpiredAt": stamp(current),
            }
            for attempt in attempts:
                if attempt.execution_provenance is not None:
                    attempt.execution_provenance = {
                        key: value
                        for key, value in attempt.execution_provenance.items()
                        if key
                        in {
                            "formalEligible",
                            "credentialDeliveryRequired",
                            "credentialDeliveryAllowed",
                            "runtimeId",
                            "workspaceId",
                            "requesterId",
                            "trustStatus",
                            "source",
                            "bindingActive",
                            "requesterAuthorized",
                            "dirty",
                        }
                    }
        else:
            row.data = {
                **{
                    key: value
                    for key, value in row.data.items()
                    if key
                    in {"providerRevision", "inputTokens", "outputTokens", "errorCode", "pricing"}
                },
                "metadataExpiredAt": stamp(current),
            }
        payload_budget -= 1
        processed += 1
        last = row.id
    if len(rows) > limit:
        return processed, True, f"{phase}:{last}"
    index = PHASES.index(phase) + 1
    return processed, index < len(PHASES), f"{PHASES[index]}:" if index < len(PHASES) else None
