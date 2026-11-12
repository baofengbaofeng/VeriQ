"""正式执行门禁综合 Attempt 结果、激活溯源与当前 Runtime 信任/绑定/请求者是否仍有效，本模块注释描述其专属不变量与失败语义。
activation_provenance 固化 formalEligible；凭据投递事后吊销会追加失败原因。
"""


import json
from typing import Any
from ..auth.authorization import WorkspaceScope
from ..repositories.resource import ResourceRepository
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..db import Attempt, Job, Runtime, RuntimeBinding, CaseExecution, RuntimeGrant
from ..service import Problem
from .jobs import require_requester


def gate(
    outcome: str | None, provenance: dict[str, Any] | None, *, current: bool = True
) -> dict[str, Any]:
    """汇总 outcome、provenance、current 为 passed/reasons 供报告门禁，gate 路径必须遵守 Workspace 作用域。"""
    reasons = []
    if outcome != "PASSED":
        reasons.append("OUTCOME_NOT_PASSED")
    if not provenance:
        reasons.append("EXECUTION_PROVENANCE_UNKNOWN")
    elif not provenance.get("formalEligible"):
        reasons.append("EXECUTION_NOT_FORMAL")
    if not current:
        reasons.append("CURRENT_RUNTIME_AUTHORITY_REVOKED")
    return {"passed": not reasons, "reasons": reasons}


async def activation_provenance(
    session: AsyncSession, job: Job, runtime: Runtime, binding: RuntimeBinding
) -> dict[str, Any]:
    """激活时采集信任、共享、凭据许可与正式资格写入 Attempt，activation_provenance 路径必须遵守 Workspace 作用域。"""
    case = (
        await session.get(CaseExecution, job.case_execution_id) if job.case_execution_id else None
    )
    grants = list(
        (
            await session.execute(
                select(RuntimeGrant.user_id)
                .where(
                    RuntimeGrant.runtime_id == runtime.id,
                    RuntimeGrant.workspace_id == job.workspace_id,
                )
                .order_by(RuntimeGrant.user_id)
            )
        ).scalars()
    )
    snapshot = json.loads(
        (
            await ResourceRepository(session, WorkspaceScope(job.workspace_id)).artifact(
                job.snapshot_hash
            )
        ).content
    )
    formal = bool(case and case.published_case_version_id and runtime.trust_status == "MANAGED")
    return {
        "runtimeId": runtime.id,
        "trustStatus": runtime.trust_status,
        "source": runtime.location,
        "workspaceId": job.workspace_id,
        "requesterId": job.created_by,
        "ownerUserId": runtime.owner_user_id,
        "sharedWithUserIds": grants,
        "credentialDeliveryAllowed": binding.allow_credential_delivery,
        "credentialDeliveryRequired": bool(snapshot.get("secretVersions")),
        "bindingActive": binding.active,
        "sharedWithWorkspace": binding.shared_with_workspace,
        "requesterAuthorized": True,
        "dirty": False,
        "formalEligible": formal,
    }


async def current_gate(session: AsyncSession, attempt: Attempt) -> dict[str, Any]:
    """结合冻结溯源与当前权威重算门禁，投递许可吊销时追加原因，current_gate 路径必须遵守 Workspace 作用域。"""
    runtime = await session.get(Runtime, attempt.runtime_id)
    binding = await session.get(RuntimeBinding, (attempt.runtime_id, attempt.workspace_id))
    job = await session.get(Job, attempt.job_id)
    current = bool(
        runtime and runtime.trust_status == "MANAGED" and binding and binding.active and job
    )
    if current and job:
        try:
            await require_requester(session, job, attempt.runtime_id)
        except Problem:
            current = False
    result = gate(attempt.outcome, attempt.execution_provenance, current=current)
    provenance = attempt.execution_provenance or {}
    # required 表示快照钉死了密钥引用，并不臆造运行时一定使用过这些密钥。
    # 缺少该字段区分的旧快照，保守沿用当时捕获的 credentialDeliveryAllowed 作为 required。
    required = provenance.get(
        "credentialDeliveryRequired", provenance.get("credentialDeliveryAllowed", False)
    )
    if (
        required
        and provenance.get("credentialDeliveryAllowed")
        and (not binding or not binding.allow_credential_delivery)
    ):
        result["passed"] = False
        result["reasons"].append("CREDENTIAL_DELIVERY_APPROVAL_REVOKED")
    return result
