"""维护触发服务：幂等 key 执行租约收割、夹具清理调和、容量调和与产物过期，供内部维护 HTTP 调用，本文件注释描述专属不变量。
无内置 Cron；外部调度命中这些端点。过期未知进程隔离容量直至 stop 调和。
"""


from datetime import datetime, timedelta
import json
from hashlib import sha256
from typing import Any
from uuid import uuid4
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from ..contracts import canonical_bytes
from ..db import (
    Attempt,
    Job,
    MaintenanceReceipt,
    ClaimReceipt,
    AuditLog,
    AttemptUpload,
    ServiceToken,
    CapacityPool,
    ResourceLease,
    Run,
    CaseExecution,
)
from ..service import Problem, now, digest as token_digest
from ..auth.authorization import WorkspaceScope
from ..repositories.resource import ResourceRepository
from ..settings import Settings
from .capacity import CapacityService
from .jobs import database_time
from .runtime import RuntimeService
from .service_account import ServiceAccountService


class MaintenanceService:
    """执行幂等维护动作并写入 MaintenanceReceipt，必要时派生 CLEANUP Job，MaintenanceService 遵守本文件边界。"""
    def __init__(self, session: AsyncSession, settings: Settings):
        """注入会话与 Settings，读取保留天数与槽位相关配置，MaintenanceService.__init__ 遵守本文件边界。"""
        self.session, self.settings = session, settings

    async def execute(
        self,
        authorization: str,
        workspace_id: str,
        operation: str,
        key: str,
        limit: int,
        cursor: str = "",
    ) -> dict[str, Any]:
        """按维护类型与 key 幂等执行；重复 key 回放回执不加倍副作用，MaintenanceService.execute 遵守本文件边界。"""
        await ServiceAccountService(self.session).require_maintenance(
            authorization, workspace_id, operation
        )
        if not key or len(key) > 160:
            raise Problem(400, "IDEMPOTENCY_KEY_REQUIRED", "Bounded idempotency key required")
        digest = sha256(canonical_bytes([operation, limit, cursor])).hexdigest()
        old = await self.session.get(MaintenanceReceipt, (workspace_id, key))
        if old:
            if old.request_hash != digest:
                raise Problem(409, "IDEMPOTENCY_CONFLICT", "Maintenance request changed")
            return old.receipt
        current = await database_time(self.session)
        maintenance_id = str(uuid4())
        maintenance_record = MaintenanceReceipt(
            id=maintenance_id,
            workspace_id=workspace_id,
            idempotency_key=key,
            request_hash=digest,
            receipt={"status": "RUNNING"},
        )
        self.session.add(maintenance_record)
        await self.session.flush()
        count, more, next_cursor = 0, False, None
        if operation == "expired-leases/reap":
            from .completion import CompletionService

            completion = CompletionService(self.session, self.settings)
            timed_out = (
                (
                    await self.session.execute(
                        select(Job)
                        .join(Run, Run.id == Job.run_id)
                        .where(
                            Job.workspace_id == workspace_id,
                            Job.state != "FINISHED",
                            Run.created_at <= current - timedelta(minutes=30),
                        )
                        .order_by(Job.id)
                        .limit(limit + 1)
                        .with_for_update(skip_locked=True)
                    )
                )
                .scalars()
                .all()
            )
            more = len(timed_out) > limit
            for expired_job in timed_out[:limit]:
                run = await self.session.get(Run, expired_job.run_id)
                assert run
                run.state, run.reason_code = "CANCEL_REQUESTED", "RUN_TIMEOUT"
                active = (
                    await self.session.get(Attempt, expired_job.active_attempt_id)
                    if expired_job.active_attempt_id
                    else None
                )
                if active and active.phase != "FINISHED":
                    expired_job.state = "CANCEL_REQUESTED"
                    active.lease_expires_at = min(active.lease_expires_at, current)
                else:
                    expired_job.state, expired_job.outcome = "FINISHED", "CANCELLED"
                    execution = await self.session.get(CaseExecution, expired_job.case_execution_id)
                    assert execution
                    execution.state, execution.outcome = "FINISHED", "CANCELLED"
                    await completion.aggregate_run(run.id)
                count += 1
            await self.session.flush()
            attempts = (
                (
                    await self.session.execute(
                        select(Attempt)
                        .where(
                            Attempt.workspace_id == workspace_id,
                            Attempt.phase != "FINISHED",
                            Attempt.lease_expires_at <= current,
                        )
                        .order_by(Attempt.id)
                        .limit(limit + 1)
                        .with_for_update(skip_locked=True)
                    )
                )
                .scalars()
                .all()
            )
            more |= len(attempts) > limit
            for attempt in attempts[:limit]:
                attempt.phase, attempt.outcome = "FINISHED", "ERROR"
                if attempt.finished_at is None:
                    attempt.finished_at = current
                attempt.facts = {
                    "business": "UNKNOWN",
                    "cleanup": "UNKNOWN",
                    "evidence": "INCOMPLETE",
                    "errorCode": "WORKER_LOST",
                }
                job = await self.session.get(Job, attempt.job_id)
                assert job
                job.state, job.outcome = "FINISHED", "ERROR"
                capacity = CapacityService(self.session, self.settings)
                if attempt.activated_at is None:
                    await capacity.release(attempt)
                else:
                    await capacity.quarantine(attempt)
                from .completion import CompletionService

                await CompletionService(self.session, self.settings).aggregate_job(job, attempt)
                partials = (
                    await self.session.execute(
                        select(AttemptUpload).where(
                            AttemptUpload.attempt_id == attempt.id,
                            AttemptUpload.complete.is_(False),
                        )
                    )
                ).scalars()
                for partial in partials:
                    partial.content = b""
                count += 1
            # 24-hour receipt window is explicit. Old UUIDs must never be reused by clients.
            receipts = (
                (
                    await self.session.execute(
                        select(ClaimReceipt)
                        .where(
                            ClaimReceipt.workspace_id == workspace_id,
                            ClaimReceipt.attempt_id.is_(None),
                            ClaimReceipt.created_at < current - timedelta(hours=24),
                        )
                        .order_by(ClaimReceipt.created_at)
                        .limit(limit)
                    )
                )
                .scalars()
                .all()
            )
            for receipt in receipts:
                await self.session.delete(receipt)
            more |= len(receipts) == limit
        elif operation == "fixture-cleanups/reconcile":
            token = (
                await self.session.execute(
                    select(ServiceToken).where(
                        ServiceToken.token_hash == token_digest(authorization[7:])
                    )
                )
            ).scalar_one()
            attempts = (
                (
                    await self.session.execute(
                        select(Attempt)
                        .where(
                            Attempt.workspace_id == workspace_id,
                            Attempt.phase == "FINISHED",
                            Attempt.id > cursor,
                        )
                        .order_by(Attempt.id)
                        .limit(limit + 1)
                    )
                )
                .scalars()
                .all()
            )
            more = len(attempts) > limit
            next_cursor = attempts[limit - 1].id if more else None
            repo = ResourceRepository(self.session, WorkspaceScope(workspace_id))
            for attempt in attempts[:limit]:
                job = await self.session.get(Job, attempt.job_id)
                assert job
                snapshot_hash = job.required_capabilities.get("cleanupSnapshotSha256")
                if (
                    job.kind != "TEST"
                    or not snapshot_hash
                    or attempt.facts.get("cleanup") in {"SUCCEEDED", "NOT_REQUIRED"}
                ):
                    continue
                existing = (
                    await self.session.execute(
                        select(Job).where(
                            Job.workspace_id == workspace_id,
                            Job.origin_attempt_id == attempt.id,
                            Job.kind == "CLEANUP",
                        )
                    )
                ).scalar_one_or_none()
                if existing:
                    continue
                snapshot = json.loads((await repo.artifact(snapshot_hash)).content)
                # A retry has its own namespace; recover the original immutable namespace.
                execution_snapshot = json.loads(
                    (await repo.artifact(attempt.snapshot_hash)).content
                )
                identity = execution_snapshot.get("environment", {}).get("fixtureIdentity")
                if (
                    not identity
                    or execution_snapshot.get("workspaceId") != workspace_id
                    or snapshot.get("workspaceId") != workspace_id
                    or snapshot.get("environment", {}).get("fixtureIdentity") != identity
                ):
                    raise Problem(
                        409, "INVALID_CLEANUP_SOURCE", "Original fixture identity is unavailable"
                    )
                pins = [
                    pin
                    for pin in execution_snapshot.get("secretVersions", [])
                    if pin["secretRef"] == identity["secretRef"]
                    and pin["versionId"] == identity["secretVersionId"]
                ]
                if len(pins) != 1:
                    raise Problem(
                        409,
                        "INVALID_CLEANUP_SOURCE",
                        "Original fixture credential pin is unavailable",
                    )
                snapshot["caseExecutionId"] = execution_snapshot["caseExecutionId"]
                snapshot["attemptNo"] = execution_snapshot["attemptNo"]
                snapshot["secretVersions"] = pins
                # Compensation needs only the original fixture service identity, never business pins.
                snapshot["environment"] = {
                    key: value
                    for key, value in execution_snapshot["environment"].items()
                    if key in {"allowedOrigins", "fixtureBaseURL", "fixtureIdentity"}
                }
                snapshot["authAdapters"] = [
                    adapter
                    for adapter in execution_snapshot.get("authAdapters", [])
                    if adapter["versionId"] == identity["authAdapterVersionId"]
                    and adapter["workspaceId"] == workspace_id
                ]
                if len(snapshot["authAdapters"]) != 1:
                    raise Problem(
                        409, "INVALID_CLEANUP_SOURCE", "Original fixture adapter is unavailable"
                    )
                snapshot["namespace"] = execution_snapshot["namespace"]
                snapshot_hash = await repo.store(canonical_bytes(snapshot))
                jid = str(uuid4())
                manifest = {
                    "schemaVersion": "1.0",
                    "workspaceId": workspace_id,
                    "jobId": jid,
                    "kind": "CLEANUP",
                    "snapshotSha256": snapshot_hash,
                    "engineVersion": snapshot["engineVersion"],
                    "maintenanceId": maintenance_id,
                    "fixtureVersionId": snapshot["fixtureVersionId"],
                    "namespace": snapshot["namespace"],
                    "cleanupRef": snapshot["fixture"]["cleanup"]["path"],
                }
                self.session.add(
                    Job(
                        id=jid,
                        workspace_id=workspace_id,
                        kind="CLEANUP",
                        subject_id=maintenance_id,
                        maintenance_id=maintenance_id,
                        origin_attempt_id=attempt.id,
                        requester_service_token_id=token.id,
                        state="QUEUED",
                        snapshot_hash=snapshot_hash,
                        manifest_hash=await repo.store(canonical_bytes(manifest)),
                        validation_key=sha256(("cleanup:" + attempt.id).encode()).hexdigest(),
                        required_capabilities={
                            "engineVersion": snapshot["engineVersion"],
                            "resourceKeys": [sha256(snapshot["namespace"].encode()).hexdigest()],
                        },
                        created_by=job.created_by,
                        created_at=current,
                    )
                )
                count += 1
        elif operation == "artifacts/expire":
            from ..db import Artifact, ValidationReceipt
            from .artifact import RAW_KINDS
            from .publication import recover, retire, offline_pins, expire_offline

            await recover(self.session, workspace_id, limit)
            # Preserve legacy online cursors, then transition once to offline aliases.
            offline_cursor = cursor[8:] if cursor.startswith("offline:") else None

            rows = (
                []
                if offline_cursor is not None
                else list(
                    (
                        await self.session.execute(
                            select(AttemptUpload, Attempt)
                            .join(Attempt, Attempt.id == AttemptUpload.attempt_id)
                            .join(Job, Job.id == Attempt.job_id)
                            .where(
                                AttemptUpload.workspace_id == workspace_id,
                                AttemptUpload.id > cursor,
                                Attempt.phase == "FINISHED",
                                Job.kind == "TEST",
                                Attempt.finished_at
                                < current
                                - timedelta(
                                    days=min(
                                        self.settings.artifact_retention_days,
                                        self.settings.artifact_success_retention_days,
                                    )
                                ),
                            )
                            .order_by(AttemptUpload.id)
                            .limit(limit + 1)
                        )
                    ).all()
                )
            )
            more = len(rows) > limit
            next_cursor = rows[limit - 1][0].id if more else None

            def cutoff(outcome: str | None) -> datetime:
                days = (
                    self.settings.artifact_success_retention_days
                    if outcome == "PASSED"
                    else self.settings.artifact_retention_days
                )
                return current - timedelta(days=days)

            for upload, attempt in rows[:limit]:
                if attempt.finished_at is None or attempt.finished_at >= cutoff(attempt.outcome):
                    continue
                if upload.metadata_json["kind"] not in RAW_KINDS:
                    continue
                if upload.expired_at is None:
                    upload.expired_at = current
                    self.session.add(
                        AuditLog(
                            id=str(uuid4()),
                            workspace_id=workspace_id,
                            actor_id=None,
                            target_id=upload.id,
                            action="artifact.expired",
                            created_at=current,
                        )
                    )
                    count += 1
                    await self.session.flush()
                artifact = await self.session.get(Artifact, (workspace_id, upload.sha256))
                if not artifact or artifact.expired_at:
                    continue
                references = list(
                    (
                        await self.session.execute(
                            select(AttemptUpload, Attempt, Job)
                            .join(Attempt, Attempt.id == AttemptUpload.attempt_id)
                            .join(Job, Job.id == Attempt.job_id)
                            .where(
                                AttemptUpload.workspace_id == workspace_id,
                                AttemptUpload.sha256 == upload.sha256,
                            )
                        )
                    ).all()
                )
                if any(u.expired_at is None for u, _, _ in references) or await offline_pins(
                    self.session, workspace_id, upload.sha256
                ):
                    continue
                # Exact source/assignment roots stay pinned. Compiler/engine closure members
                # are pinned by their retained non-raw uploads in the reference check above.
                digest = upload.sha256
                from ..db import Bundle

                roots = [
                    select(Bundle.id).where(
                        Bundle.workspace_id == workspace_id,
                        or_(
                            Bundle.manifest_hash == digest,
                            Bundle.archive_hash == digest,
                            Bundle.snapshot_hash == digest,
                        ),
                    ),
                    select(Job.id).where(
                        Job.workspace_id == workspace_id,
                        or_(
                            Job.snapshot_hash == digest,
                            Job.manifest_hash == digest,
                            Job.required_capabilities["cleanupSnapshotSha256"].as_string()
                            == digest,
                        ),
                    ),
                    select(Run.id).where(
                        Run.workspace_id == workspace_id, Run.snapshot_hash == digest
                    ),
                    select(CaseExecution.id).where(
                        CaseExecution.workspace_id == workspace_id,
                        CaseExecution.source_snapshot_hash == digest,
                    ),
                    select(Attempt.id).where(
                        Attempt.workspace_id == workspace_id,
                        or_(Attempt.snapshot_hash == digest, Attempt.manifest_hash == digest),
                    ),
                    select(ValidationReceipt.id).where(
                        ValidationReceipt.workspace_id == workspace_id,
                        ValidationReceipt.compiled_bundle_sha256 == digest,
                    ),
                ]
                pinned = False
                for root in roots:
                    if (await self.session.execute(root.limit(1))).first():
                        pinned = True
                        break
                if pinned:
                    continue
                artifact.expired_at = current
                if artifact.storage_backend == "INLINE":
                    artifact.content = None
                    artifact.deleted_at = current
                else:
                    await retire(
                        self.session,
                        workspace_id,
                        artifact.sha256,
                        artifact.storage_backend,
                        artifact.storage_incarnation,
                    )
            if not more:
                # The request budget counts scanned online rows as well as expired offline rows.
                remaining = limit - len(rows)
                offline_count, offline_last, offline_more = await expire_offline(
                    self.session, workspace_id, remaining, offline_cursor or ""
                )
                count += offline_count
                more = offline_more
                next_cursor = "offline:" + offline_last if more else None
        elif operation == "capacity/reconcile":
            keys = (
                (
                    await self.session.execute(
                        select(ResourceLease.pool_key)
                        .where(
                            ResourceLease.workspace_id == workspace_id,
                            ResourceLease.pool_key > cursor,
                        )
                        .distinct()
                        .order_by(ResourceLease.pool_key)
                        .limit(limit + 1)
                    )
                )
                .scalars()
                .all()
            )
            more = len(keys) > limit
            next_cursor = keys[limit - 1] if more else None
            for pool_key in keys[:limit]:
                pool = await self.session.get(CapacityPool, pool_key)
                held = (
                    (
                        await self.session.execute(
                            select(ResourceLease).where(
                                ResourceLease.pool_key == pool_key,
                                ResourceLease.state != "RELEASED",
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if not pool or pool.used != len(held):
                    raise Problem(
                        409,
                        "CAPACITY_INCONSISTENT",
                        "Capacity reconciliation requires administrator investigation",
                    )
                count += 1
        result = {
            "id": maintenance_id,
            "status": "FINISHED",
            "processedCount": count,
            "hasMore": more,
            **({"nextCursor": next_cursor} if next_cursor else {}),
        }
        maintenance_record.receipt = result
        return result

    async def stopped(
        self, authorization: str, attempt_id: str, facts: dict[str, Any]
    ) -> dict[str, Any]:
        """标记维护相关清理已停止或完成，供调和循环继续推进，MaintenanceService.stopped 遵守本文件边界。"""
        runtime, binding, _ = await RuntimeService(self.session).require_device(authorization)
        attempt = await self.session.get(Attempt, attempt_id)
        if (
            not attempt
            or attempt.runtime_id != runtime.id
            or attempt.workspace_id != binding.workspace_id
        ):
            raise Problem(
                403, "ATTEMPT_FORBIDDEN", "Only the assigned Runtime may confirm stopping"
            )
        if facts["fencingToken"] != attempt.fencing_token:
            raise Problem(409, "STALE_FENCE", "Stop confirmation does not match Attempt")
        if facts["processStopped"]:
            await CapacityService(self.session, self.settings).release(attempt)
            if attempt.phase != "FINISHED":
                attempt.phase, attempt.outcome = "FINISHED", "INCOMPLETE"
                if attempt.finished_at is None:
                    attempt.finished_at = await database_time(self.session)
                job = await self.session.get(Job, attempt.job_id)
                assert job
                job.state, job.outcome = "FINISHED", "INCOMPLETE"
                from .completion import CompletionService

                await CompletionService(self.session, self.settings).aggregate_job(job, attempt)
            attempt.facts = {**attempt.facts, "stopConfirmation": facts}
        else:
            await CapacityService(self.session, self.settings).quarantine(attempt)
            if attempt.phase != "FINISHED":
                attempt.phase, attempt.outcome = "FINISHED", "ERROR"
                if attempt.finished_at is None:
                    attempt.finished_at = await database_time(self.session)
                attempt.facts = {
                    **attempt.facts,
                    "business": "UNKNOWN",
                    "cleanup": "UNKNOWN",
                    "evidence": "INCOMPLETE",
                    "errorCode": "WORKER_LOST",
                }
                job = await self.session.get(Job, attempt.job_id)
                assert job
                job.state, job.outcome = "FINISHED", "ERROR"
                from .completion import CompletionService

                await CompletionService(self.session, self.settings).aggregate_job(job, attempt)
        record = AuditLog(
            id=str(uuid4()),
            action="attempt.stop_confirmed" if facts["processStopped"] else "attempt.stop_unknown",
            actor_id=runtime.owner_user_id,
            target_id=attempt.id,
            workspace_id=attempt.workspace_id,
            created_at=now(),
        )
        self.session.add(record)
        return {
            "attemptId": attempt.id,
            "capacityReleased": attempt.capacity_state == "RELEASED",
            "auditId": record.id,
        }
