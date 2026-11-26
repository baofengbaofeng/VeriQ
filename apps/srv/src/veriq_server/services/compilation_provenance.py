"""编译回执的来源证明由作业的最终状态与身份关联共同构成，读取和发布共享相同门禁，避免设备与服务端来源彼此替代。"""

from typing import Any

from sqlalchemy import and_, or_
from sqlalchemy.sql.elements import ColumnElement

from ..db import Job, ValidationReceipt


def validation_origin_matches(job: Job, receipt: ValidationReceipt) -> bool:
    """按工作区、资源和作业核对完成回执，再用互斥字段区分服务端编译标识与历史设备尝试标识。"""
    if (
        job.kind != "VALIDATE"
        or job.state != "FINISHED"
        or receipt.compiler_trust != "MANAGED"
        or job.server_compile_expires_at is not None
    ):
        return False
    if (job.workspace_id, job.id, job.subject_id) != (
        receipt.workspace_id,
        receipt.job_id,
        receipt.resource_id,
    ):
        return False
    # 服务端回执只能引用该作业最后完成的编译标识，租约仍有效或设备仍占有作业时均无法提供发布证明。
    if receipt.server_compilation_id is not None:
        return (
            job.outcome == "PASSED"
            and job.server_compilation_id == receipt.server_compilation_id
            and job.active_attempt_id is None
            and receipt.runtime_id is None
            and receipt.attempt_id is None
        )
    # 历史设备与尝试的复合外键已验证归属，旧回执仍要求明确的设备标识和作业活动尝试的一致性。
    return (
        job.outcome in (None, "PASSED")
        and job.server_compilation_id is None
        and receipt.runtime_id is not None
        and receipt.attempt_id is not None
        and job.active_attempt_id == receipt.attempt_id
    )


def validation_origin_filter() -> ColumnElement[bool]:
    """在选择替代编译回执时用同一来源约束过滤 SQL 候选，分页或取首条之前排除伪造的完成关系。"""
    return and_(
        Job.id == ValidationReceipt.job_id,
        Job.workspace_id == ValidationReceipt.workspace_id,
        Job.subject_id == ValidationReceipt.resource_id,
        Job.kind == "VALIDATE",
        Job.state == "FINISHED",
        ValidationReceipt.compiler_trust == "MANAGED",
        Job.server_compile_expires_at.is_(None),
        or_(
            and_(
                or_(Job.outcome.is_(None), Job.outcome == "PASSED"),
                ValidationReceipt.server_compilation_id.is_(None),
                Job.server_compilation_id.is_(None),
                ValidationReceipt.runtime_id.is_not(None),
                ValidationReceipt.attempt_id.is_not(None),
                Job.active_attempt_id == ValidationReceipt.attempt_id,
            ),
            and_(
                Job.outcome == "PASSED",
                ValidationReceipt.server_compilation_id.is_not(None),
                Job.server_compilation_id == ValidationReceipt.server_compilation_id,
                Job.active_attempt_id.is_(None),
                ValidationReceipt.runtime_id.is_(None),
                ValidationReceipt.attempt_id.is_(None),
            ),
        ),
    )


def compilation_identity_fields(receipt: ValidationReceipt) -> dict[str, Any]:
    """公开实际编译来源的标识集合，旧设备回执保留原字段便于读取已有归档和已发布版本的溯源记录。"""
    if receipt.server_compilation_id is not None:
        return {"serverCompilationId": receipt.server_compilation_id}
    return {"runtimeId": receipt.runtime_id, "attemptId": receipt.attempt_id}
