"""租约与围栏服务校验 Attempt 证明中的 fencingToken、lease_token 哈希与激活状态，心跳续约默认六十秒。
proof 要求 Runtime 绑定匹配 Workspace；过期或 FINISHED 不得再授权执行副作用。
DatabaseAttemptProofVerifier 为凭据解析组装 VerifiedAttempt 与身份列表。
"""


import hmac
import json
from datetime import timedelta
from typing import Any
from sqlalchemy.ext.asyncio import AsyncSession
from ..credentials.resolve import CredentialProofTransport, VerifiedAttempt
from ..db import Attempt, Job, Runtime, RuntimeBinding, Run
from ..auth.authorization import WorkspaceScope
from ..repositories.resource import ResourceRepository
from ..service import Problem, digest, stamp
from ..settings import Settings
from .jobs import database_time, require_requester
from .runtime import RuntimeService


class LeaseService:
    """验证与维护 Attempt 租约；激活前禁止副作用，心跳可传播取消，LeaseService 路径必须遵守 Workspace 作用域。"""
    def __init__(self, session: AsyncSession, settings: Settings):
        """注入会话与 Settings，租约上限结合 Run 三十分钟预算裁剪，LeaseService.__init__ 路径必须遵守 Workspace 作用域。"""
        self.session, self.settings = session, settings

    async def proof(
        self,
        attempt_id: str,
        proof: CredentialProofTransport,
        *,
        active: bool = True,
        requester: bool = True,
    ) -> tuple[Attempt, Job, Runtime, RuntimeBinding]:
        """核验设备、归属、fence、lease_token 与未过期，失败返回 Problem，LeaseService.proof 路径必须遵守 Workspace 作用域。
        active 要求已激活；requester 复查原始请求者授权。
        """
        runtime, binding, _ = await RuntimeService(self.session).require_device(proof.authorization)
        attempt = await self.session.get(Attempt, attempt_id)
        if (
            not attempt
            or attempt.workspace_id != binding.workspace_id
            or attempt.runtime_id != runtime.id
        ):
            raise Problem(403, "ATTEMPT_FORBIDDEN", "Attempt is not assigned to this Runtime")
        job = await self.session.get(Job, attempt.job_id)
        assert job
        if requester:
            await require_requester(self.session, job, runtime.id)
        if (
            attempt.fencing_token != proof.fencing_token
            or job.fence != proof.fencing_token
            or job.active_attempt_id != attempt.id
            or not hmac.compare_digest(attempt.lease_token_hash, digest(proof.lease_token))
        ):
            raise Problem(409, "STALE_FENCE", "Attempt proof is no longer current")
        if (
            attempt.lease_expires_at <= await database_time(self.session)
            or attempt.phase == "FINISHED"
        ):
            raise Problem(409, "LEASE_EXPIRED", "Expired lease cannot authorize work")
        if active and attempt.activated_at is None:
            raise Problem(409, "ACTIVATION_REQUIRED", "Activate before any execution side effect")
        return attempt, job, runtime, binding

    async def activate(self, attempt_id: str, proof: CredentialProofTransport) -> dict[str, Any]:
        """写入 activated_at 与溯源，阶段 PREPARING；重复激活拒绝，LeaseService.activate 路径必须遵守 Workspace 作用域。
        取消中 Job 不可激活；返回 fencingToken。
        """
        attempt, job, runtime, binding = await self.proof(attempt_id, proof, active=False)
        if job.state == "CANCEL_REQUESTED":
            raise Problem(409, "CANCEL_REQUESTED", "Execution was cancelled")
        if attempt.activated_at is not None:
            raise Problem(
                409,
                "ATTEMPT_ALREADY_ACTIVATED",
                "Activation has already been acknowledged; reconcile local process state",
            )
        attempt.activated_at = await database_time(self.session)
        from .gate import activation_provenance
        attempt.execution_provenance = await activation_provenance(self.session, job, runtime, binding)
        attempt.phase, job.state = "PREPARING", "RUNNING"
        return {"attemptId": attempt.id, "activated": True, "fencingToken": attempt.fencing_token}

    async def heartbeat(
        self,
        attempt_id: str,
        proof: CredentialProofTransport,
        progress: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """续租并推进阶段；未激活不得离 LEASED，禁止阶段回退，LeaseService.heartbeat 路径必须遵守 Workspace 作用域。
        取消或 requester 失效时不再延长租约。
        """
        attempt, job, runtime, _ = await self.proof(
            attempt_id, proof, active=False, requester=False
        )
        if progress:
            phase = progress["phase"]
            phases = ["LEASED", "PREPARING", "RUNNING", "CLEANING", "FINALIZING"]
            if (attempt.activated_at is None and phase != "LEASED") or phases.index(
                phase
            ) < phases.index(attempt.phase):
                raise Problem(
                    409, "INVALID_PHASE", "Heartbeat cannot activate or regress Attempt phase"
                )
            attempt.phase = phase
        current = await database_time(self.session)
        run = await self.session.get(Run, job.run_id) if job.run_id else None
        cancel = job.state == "CANCEL_REQUESTED" or bool(
            run
            and (
                run.state == "CANCEL_REQUESTED" or run.created_at + timedelta(minutes=30) <= current
            )
        )
        if cancel and run:
            run.state = job.state = "CANCEL_REQUESTED"
        try:
            await require_requester(self.session, job, runtime.id)
        except Problem:
            cancel = True
            job.state = "CANCEL_REQUESTED"
        current = await database_time(self.session)
        if not cancel:
            runtime.last_seen_at = current
            attempt.lease_expires_at = (
                min(current + timedelta(seconds=60), run.created_at + timedelta(minutes=30))
                if run
                else current + timedelta(seconds=60)
            )
        return {
            "leaseExpiresAt": stamp(attempt.lease_expires_at),
            "cancelRequested": cancel,
            "serverTime": stamp(current),
            "leaseDurationMs": max(
                0, int((attempt.lease_expires_at - current).total_seconds() * 1000)
            ),
        }


class DatabaseAttemptProofVerifier:
    """为凭据解析校验 Attempt 证明并提取角色或夹具身份，DatabaseAttemptProofVerifier 路径必须遵守 Workspace 作用域。"""
    def __init__(self, settings: Settings):
        """保存 Settings，供内部 LeaseService 使用同一配置，DatabaseAttemptProofVerifier.__init__ 路径必须遵守 Workspace 作用域。"""
        self.settings = settings

    async def verify(
        self, session: AsyncSession, attempt_id: str, proof: CredentialProofTransport
    ) -> VerifiedAttempt:
        """proof 后组装 VerifiedAttempt；取消中 Job 置 active=False，DatabaseAttemptProofVerifier.verify 路径必须遵守 Workspace 作用域。
        TEST 读角色身份，CLEANUP 读夹具身份。
        """
        attempt, job, runtime, binding = await LeaseService(session, self.settings).proof(
            attempt_id, proof
        )
        identities = []
        if job.kind == "TEST":
            artifact = await ResourceRepository(session, WorkspaceScope(job.workspace_id)).artifact(
                attempt.snapshot_hash
            )
            if artifact:
                snapshot = json.loads(artifact.content)
                environment = snapshot["environment"]
                identities = [
                    role for role in environment["roles"] if role["roleKey"] == snapshot["roleKey"]
                ]
                if environment.get("fixtureIdentity"):
                    identities.append(environment["fixtureIdentity"])
        elif job.kind == "CLEANUP":
            artifact = await ResourceRepository(session, WorkspaceScope(job.workspace_id)).artifact(
                attempt.snapshot_hash
            )
            if artifact:
                snapshot = json.loads(artifact.content)
                fixture_identity = snapshot["environment"].get("fixtureIdentity")
                if fixture_identity:
                    identities = [fixture_identity]
        return VerifiedAttempt(
            workspace_id=job.workspace_id,
            attempt_id=attempt.id,
            device_id=runtime.id,
            active=job.state != "CANCEL_REQUESTED",
            trust_status=runtime.trust_status,
            credential_grant=binding.allow_credential_delivery,
            membership_active=True,
            lease_until=attempt.lease_expires_at,
            fence=proof.fencing_token,
            current_fence=job.fence,
            identities=identities,
        )
