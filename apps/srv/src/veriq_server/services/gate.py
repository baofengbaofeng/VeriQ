"""正式执行门禁综合 Attempt 结果、激活溯源与当前 Runtime 信任/绑定/请求者是否仍有效，本模块注释描述其专属不变量与失败语
义。activation_provenance 固化 formalEligible；

凭据投递事后吊销会追加失败原因。
"""

import json
from typing import Any, NamedTuple
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
    """汇总 outcome、provenance、current 为 passed/reasons 供报告门禁，gate 路径必须遵守 Workspace 作用域。
    gate 实现于 apps/srv/src/veriq_server/services/gate.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """
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
    """激活时采集信任、共享、凭据许可与正式资格写入 Attempt，activation_provenance 路径必须遵守 Workspace 作用域。
    activation_provenance 实现于 apps/srv/src/veriq_server/services/gate.py：请按该符号的输入校验、
    错误码与调用方契约阅读，勿假设通用成功默认值。
    """
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


class RuntimeAuthority(NamedTuple):
    """分别记录本次派发资格与凭据投递许可，使每次尝试可以按自己冻结的凭据要求解释同一份设备绑定。"""

    current: bool
    allow_delivery: bool


type ReportAuthorities = dict[tuple[str, str], RuntimeAuthority]


async def report_authorities(
    session: AsyncSession,
    workspace_id: str,
    requesters: dict[tuple[str, str], tuple[str, str | None]],
) -> ReportAuthorities:
    """批量读取本轮涉及的设备绑定，同一报告内共用请求主体与设备的 TEST 作业只重验一次派发权。"""
    runtime_ids = {runtime_id for _, runtime_id in requesters}
    if not runtime_ids:
        return {}
    bindings = {
        runtime_id: (trust == "MANAGED" and active, delivery)
        for runtime_id, trust, active, delivery in await session.execute(
            select(
                Runtime.id,
                Runtime.trust_status,
                RuntimeBinding.active,
                RuntimeBinding.allow_credential_delivery,
            )
            .join(RuntimeBinding, RuntimeBinding.runtime_id == Runtime.id)
            .where(RuntimeBinding.workspace_id == workspace_id, Runtime.id.in_(runtime_ids))
        )
    }
    authorities: dict[tuple[str, str | None, str], RuntimeAuthority] = {}
    result = {}
    for (job_id, runtime_id), (requester, token) in requesters.items():
        key = (requester, token, runtime_id)
        if key not in authorities:
            current, delivery = bindings.get(runtime_id, (False, False))
            if current:
                job = await session.get(Job, job_id)
                assert job is not None
                try:
                    await require_requester(session, job, runtime_id)
                except Problem:
                    current = False
            authorities[key] = RuntimeAuthority(current, delivery)
        result[(job_id, runtime_id)] = authorities[key]
    return result


def current_gate(attempt: Attempt, authority: RuntimeAuthority) -> dict[str, Any]:
    """使用本次读取的权威资格和绑定投递许可，按每个 Attempt 自己的冻结溯源计算当前门禁。"""
    result = gate(attempt.outcome, attempt.execution_provenance, current=authority.current)
    provenance = attempt.execution_provenance or {}
    # required 表示快照钉死了密钥引用，并不臆造运行时一定使用过这些密钥。缺少该字段区分的旧快照，保守沿用当时捕获的
    # credentialDeliveryAllowed 作为 required。
    required = provenance.get(
        "credentialDeliveryRequired", provenance.get("credentialDeliveryAllowed", False)
    )
    if required and provenance.get("credentialDeliveryAllowed") and not authority.allow_delivery:
        result["passed"] = False
        result["reasons"].append("CREDENTIAL_DELIVERY_APPROVAL_REVOKED")
    return result
