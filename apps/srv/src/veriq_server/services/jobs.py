"""Job 领取服务：按 Runtime 能力与容量用 FOR UPDATE SKIP LOCKED 领取任务，递增 fencingToken，原子分配 Attempt 与租约。
require_requester 验证原始请求者对 Runtime 仍有效；database_time 使用服务器 UTC。
claim 失败返回 None 让 Agent 退避，禁止先 count 再无锁启动。
"""

import secrets
import json
from dataclasses import dataclass, field
from collections.abc import AsyncIterator
from datetime import timedelta, datetime
from hashlib import sha256
from typing import Any, cast
from uuid import uuid4, UUID
from sqlalchemy import func, select, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession
from ..contracts import canonical_bytes
from ..auth.authorization import WorkspaceScope
from ..repositories.resource import ResourceRepository
from ..db import (
    Attempt,
    ClaimReceipt,
    Job,
    User,
    ValidationReceipt,
    Run,
    CaseExecution,
    ServiceToken,
    ServiceAccount,
    RuntimeBinding,
)
from ..service import Problem, audit, digest, stamp
from ..settings import Settings
from .capacity import CapacityService
from .runtime import RuntimeService
from .engines import ApprovedEngines


@dataclass(frozen=True)
class RuntimeIdentity:
    """封装领取方 Runtime 身份与能力，供 claim 过滤候选 Job 与容量键，RuntimeIdentity 遵守本文件边界。
    RuntimeIdentity 实现于 apps/srv/src/veriq_server/services/jobs.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    authorization: str = field(repr=False)


ClaimRequest = dict[str, Any]
ClaimDTO = dict[str, Any]


async def database_time(session: AsyncSession) -> datetime:
    """读取数据库 UTC 当前时间，作为租约与过期判断的权威时钟，避免节点时钟漂移，database_time 遵守本文件边界。
    database_time 实现于 apps/srv/src/veriq_server/services/jobs.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return cast(datetime, (await session.execute(select(func.utc_timestamp(6)))).scalar_one())


async def require_requester(session: AsyncSession, job: Job, runtime_id: str) -> User | None:
    """每次领取、续租和结果提交都重验最初请求者的当前权限，执行令牌必须匹配冻结运行关联并保有计划与设备派发权；维护令牌继续走清理专用范围，普通用户仍通过原有成员和所有者检查。"""
    if job.requester_service_token_id and job.kind == "TEST":
        from .execution_principal import ServicePrincipal

        run = await session.get(Run, job.run_id)
        if (
            not run
            or not run.plan_id
            or run.requester_service_token_id != job.requester_service_token_id
        ):
            raise Problem(403, "REQUESTER_REVOKED", "Frozen service plan association required")
        await ServicePrincipal(job.requester_service_token_id, job.created_by).runtime(
            session, job.workspace_id, run.plan_id, runtime_id
        )
        return None
    if job.requester_service_token_id:
        token = await session.get(ServiceToken, job.requester_service_token_id)
        account = await session.get(ServiceAccount, token.service_account_id) if token else None
        binding = await session.get(RuntimeBinding, (runtime_id, job.workspace_id))
        if (
            job.kind != "CLEANUP"
            or not token
            or token.purpose != "MAINTENANCE"
            or token.revoked_at
            or token.expires_at <= await database_time(session)
            or "fixture-cleanups/reconcile" not in (token.operation_scopes or [])
            or not account
            or account.disabled
            or account.workspace_id != job.workspace_id
            or not binding
            or not binding.active
            or not binding.shared_with_workspace
        ):
            raise Problem(
                403,
                "REQUESTER_REVOKED",
                "Current scoped maintenance grant and shared Runtime required",
            )
        return None
    actor = await session.get(User, job.created_by)
    if not actor or actor.disabled:
        raise Problem(403, "REQUESTER_REVOKED", "Execution requester authorization is inactive")
    await RuntimeService(session).require_dispatch(actor, job.workspace_id, runtime_id)
    return actor


class JobService:
    """编排候选扫描、容量预留与 claim 提交，产出含租约秘密的 ClaimDTO，JobService 遵守本文件边界，失败返回稳定 Problem。
    JobService 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    def __init__(self, session: AsyncSession, settings: Settings):
        """注入会话与 Settings，供容量槽位与租约时长配置读取，JobService.__init__ 遵守本文件边界，失败返回稳定 Problem。
        __init__ 实现于 apps/srv/src/veriq_server/services/jobs.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.session, self.settings = session, settings

    def response(self, job: Job, attempt: Attempt, secret: str, current: Any) -> ClaimDTO:
        """将 Job/Attempt 与明文 lease secret 组装为 ClaimDTO 响应，JobService.response 遵守本文件边界。
        response 实现于 apps/srv/src/veriq_server/services/jobs.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        return {
            "jobId": job.id,
            "jobKind": job.kind,
            "attemptId": attempt.id,
            "leaseToken": secret,
            "fencingToken": attempt.fencing_token,
            "expiresAt": stamp(attempt.lease_expires_at),
            "serverTime": stamp(current),
            "leaseDurationMs": max(
                0, int((attempt.lease_expires_at - current).total_seconds() * 1000)
            ),
            "activationRequired": True,
            "snapshotUrl": f"{self.settings.public_url}/internal/v1/workspaces/{job.workspace_id}/attempts/{attempt.id}/content/{job.manifest_hash}",
            "snapshotSha256": job.manifest_hash,
        }

    async def candidates(
        self,
        workspace_id: str,
        runtime_id: str,
        location: str,
        capabilities: dict[str, Any],
        current: datetime,
    ) -> AsyncIterator[Job]:
        """按能力与状态筛选可领 Job，使用 SKIP LOCKED 避免领取互撞，JobService.candidates 遵守本文件边界。
        candidates 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        query = select(Job).where(
            Job.workspace_id == workspace_id,
            Job.state == "QUEUED",
            Job.created_at <= current,
            or_(Job.requested_runtime_id.is_(None), Job.requested_runtime_id == runtime_id),
            or_(Job.requested_location.is_(None), Job.requested_location == location),
            Job.kind.in_(capabilities.get("jobKinds", ["TEST", "VALIDATE", "CLEANUP"])),
            Job.required_capabilities["engineVersion"].as_string() == capabilities["engineVersion"],
        )
        cursor: tuple[datetime, str] | None = None
        while True:
            page_query = query
            if cursor:
                page_query = page_query.where(
                    or_(
                        Job.created_at > cursor[0],
                        and_(Job.created_at == cursor[0], Job.id > cursor[1]),
                    )
                )
            page = (
                (await self.session.execute(page_query.order_by(Job.created_at, Job.id).limit(100)))
                .scalars()
                .all()
            )
            if not page:
                return
            cursor = page[-1].created_at, page[-1].id
            for job in page:
                yield job
            if len(page) < 100:
                return

    async def claim(self, identity: RuntimeIdentity, req: ClaimRequest) -> ClaimDTO | None:
        """领取在安装锁和任务锁保护下预留容量、递增栅栏并建立租约，计划任务还必须等待前驱逻辑结束和物理占用释放；任何授权或容量条件不满足都不启动执行，未知进程不能凭时间超期重用容量。"""
        req = {
            **req,
            "clientRequestId": str(UUID(req["clientRequestId"])),
            "runnerId": str(UUID(req["runnerId"])),
        }
        runtime, binding, _ = await RuntimeService(self.session).require_device(
            identity.authorization
        )
        if req["runnerId"] != runtime.id:
            raise Problem(403, "DEVICE_MISMATCH", "Claim must use the authenticated Runtime")
        current = await database_time(self.session)
        runtime.last_seen_at = current
        request_hash = sha256(canonical_bytes(req)).hexdigest()
        old = await self.session.get(ClaimReceipt, (runtime.id, req["clientRequestId"]))
        if old:
            if old.workspace_id != binding.workspace_id or old.request_hash != request_hash:
                raise Problem(409, "IDEMPOTENCY_CONFLICT", "Claim request changed")
            if not old.attempt_id:
                return None
            attempt = await self.session.get(Attempt, old.attempt_id)
            assert attempt
            job = await self.session.get(Job, attempt.job_id)
            assert job
            await require_requester(self.session, job, runtime.id)
            if attempt.activated_at is not None:
                raise Problem(
                    409,
                    "ATTEMPT_ALREADY_ACTIVATED",
                    "Existing Attempt requires reconciliation; no new execution authority issued",
                )
            if (
                attempt.lease_expires_at <= current
                or attempt.phase == "FINISHED"
                or job.active_attempt_id != attempt.id
            ):
                raise Problem(409, "LEASE_EXPIRED", "Claim lease cannot be recovered")
            secret = secrets.token_urlsafe(32)
            if job.fence >= 9007199254740991:
                raise Problem(409, "FENCE_EXHAUSTED", "Job fencing token is exhausted")
            job.fence += 1
            attempt.fencing_token, attempt.lease_token_hash = job.fence, digest(secret)
            audit(
                self.session,
                "attempt.proof_rotated",
                None,
                attempt.id,
                workspace_id=job.workspace_id,
            )
            return self.response(job, attempt, secret, current)
        # Bound idle receipts even if the external scheduler is unavailable.
        count = (
            await self.session.execute(
                select(func.count())
                .select_from(ClaimReceipt)
                .where(ClaimReceipt.runtime_id == runtime.id, ClaimReceipt.attempt_id.is_(None))
            )
        ).scalar_one()
        if count >= 10000:
            raise Problem(
                429, "CLAIM_RECEIPT_LIMIT", "External claim-receipt maintenance is required"
            )
        receipt = ClaimReceipt(
            runtime_id=runtime.id,
            workspace_id=binding.workspace_id,
            client_request_id=req["clientRequestId"],
            request_hash=request_hash,
            created_at=current,
        )
        self.session.add(receipt)
        if req["availableSlots"] == 0:
            return None
        capacity = CapacityService(self.session, self.settings)
        async for job in self.candidates(
            binding.workspace_id, runtime.id, runtime.location, runtime.capabilities, current
        ):
            run = await self.session.get(Run, job.run_id) if job.run_id else None
            if run and (
                run.state in {"CANCEL_REQUESTED", "FINISHED"}
                or run.created_at + timedelta(minutes=30) <= current
            ):
                continue
            if run and run.plan_id:
                from .execution_plan import earlier_plan_work

                if await earlier_plan_work(self.session, run.plan_id, run.plan_sequence):
                    job.wait_reason = "RESOURCE_LOCK"
                    continue
            try:
                await require_requester(self.session, job, runtime.id)
            except Problem:
                continue
            if job.origin_attempt_id:
                origin = await self.session.get(Attempt, job.origin_attempt_id)
                if (
                    not origin
                    or origin.workspace_id != job.workspace_id
                    or origin.capacity_state != "RELEASED"
                ):
                    job.wait_reason = "QUARANTINED"
                    continue
            if (
                job.required_capabilities.get("runtimeIds")
                and runtime.id not in job.required_capabilities["runtimeIds"]
            ):
                continue
            if dependency := job.required_capabilities.get("validationJobId"):
                compiled_receipt = (
                    await self.session.execute(
                        select(ValidationReceipt).where(
                            ValidationReceipt.workspace_id == job.workspace_id,
                            ValidationReceipt.job_id == dependency,
                        )
                    )
                ).scalar_one_or_none()
                if not compiled_receipt:
                    failed_dependency = await self.session.get(Job, dependency)
                    if failed_dependency and failed_dependency.state == "FINISHED":
                        job.state, job.outcome = "FINISHED", "ERROR"
                        execution = await self.session.get(CaseExecution, job.case_execution_id)
                        assert execution and job.run_id
                        execution.state, execution.outcome = "FINISHED", "ERROR"
                        from .completion import CompletionService

                        await CompletionService(self.session, self.settings).aggregate_run(
                            job.run_id
                        )
                    else:
                        job.wait_reason = "NO_CAPABILITY"
                    continue
                repo = ResourceRepository(self.session, WorkspaceScope(job.workspace_id))
                frozen = json.loads((await repo.artifact(job.snapshot_hash)).content)
                dependency_job = await self.session.get(Job, dependency)
                if (
                    compiled_receipt.compiler_trust != "MANAGED"
                    or compiled_receipt.source_hash != frozen["assetSourceHash"]
                    or not dependency_job
                    or dependency_job.state != "FINISHED"
                    or dependency_job.active_attempt_id != compiled_receipt.attempt_id
                ):
                    raise Problem(
                        409,
                        "COMPILED_PROVENANCE_REQUIRED",
                        "Draft validation receipt does not match frozen candidate",
                    )
                manifest = json.loads((await repo.artifact(job.manifest_hash)).content)
                manifest.pop("pendingValidationJobId", None)
                manifest["compiledBundleSha256"] = compiled_receipt.compiled_bundle_sha256
                job.manifest_hash = await repo.store(canonical_bytes(manifest))
                job.required_capabilities = {
                    k: v for k, v in job.required_capabilities.items() if k != "validationJobId"
                }
            if job.requested_runtime_id and job.requested_runtime_id != runtime.id:
                continue
            if job.requested_location and job.requested_location != runtime.location:
                continue
            caps = runtime.capabilities
            if job.required_capabilities.get("engineVersion") != caps["engineVersion"]:
                job.wait_reason = "NO_CAPABILITY"
                continue
            if job.kind not in caps.get("jobKinds", ["TEST", "VALIDATE", "CLEANUP"]):
                continue
            browser = job.required_capabilities.get("browser")
            if browser and browser not in caps["browsers"]:
                continue
            if job.kind == "VALIDATE":
                if runtime.trust_status != "MANAGED":
                    continue
                try:
                    ApprovedEngines(self.settings).require(caps["engineVersion"])
                except Problem:
                    job.wait_reason = "NO_CAPABILITY"
                    continue
            pools = await capacity.available(job, runtime.id)
            if pools is None:
                job.wait_reason = "CAPACITY"
                continue
            locked = (
                await self.session.execute(
                    select(Job)
                    .where(Job.id == job.id, Job.state == "QUEUED")
                    .with_for_update(skip_locked=True)
                )
            ).scalar_one_or_none()
            if locked is None:
                continue
            number = (
                await self.session.execute(
                    select(func.count()).select_from(Attempt).where(Attempt.job_id == job.id)
                )
            ).scalar_one() + 1
            if number > 2:
                continue
            secret = secrets.token_urlsafe(32)
            if job.fence >= 9007199254740991:
                raise Problem(409, "FENCE_EXHAUSTED", "Job fencing token is exhausted")
            job.fence += 1
            attempt = Attempt(
                id=str(uuid4()),
                workspace_id=job.workspace_id,
                job_id=job.id,
                runtime_id=runtime.id,
                attempt_no=number,
                snapshot_hash=job.snapshot_hash,
                manifest_hash=job.manifest_hash,
                lease_token_hash=digest(secret),
                fencing_token=job.fence,
                lease_expires_at=min(
                    current + timedelta(seconds=60), run.created_at + timedelta(minutes=30)
                )
                if run
                else current + timedelta(seconds=60),
                phase="LEASED",
                capacity_state="HELD",
                created_at=current,
                facts={},
                last_sequence=0,
            )
            self.session.add(attempt)
            await self.session.flush()
            job.active_attempt_id, job.state, job.wait_reason = attempt.id, "LEASED", None
            receipt.attempt_id = attempt.id
            capacity.reserve(attempt, pools)
            if job.run_id:
                run = await self.session.get(Run, job.run_id)
                if run:
                    run.state = "RUNNING"
            if job.case_execution_id:
                execution = await self.session.get(CaseExecution, job.case_execution_id)
                if execution:
                    execution.state = "RUNNING"
            return self.response(job, attempt, secret, current)
        return None
