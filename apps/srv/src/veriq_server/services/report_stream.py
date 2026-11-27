"""每轮在同一个数据库快照中读取运行和证据的变更依据，下一轮重新核验权限并比较两轮的读取结果。"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import (
    Artifact,
    Attempt,
    AttemptUpload,
    CaseExecution,
    Job,
    OfflineAttempt,
    OfflineImport,
    OfflineImportUpload,
    Run,
)
from .gate import ReportAuthorities, report_authorities
from .runs import run_dto


@dataclass
class ReportStreamState:
    """记录当前数据库快照可见的报告输入、事件水位及门禁结果，供同一连接在下一次短事务中检测变化。"""

    inputs: tuple[object, ...]
    known: dict[str, int]
    authorities: ReportAuthorities


def evidence_revision(
    upload: type[AttemptUpload] | type[OfflineImportUpload],
) -> Select[tuple[int, Any]]:
    """按不可变上传标识与两处过期状态汇总固定长度摘要，避免每个订阅者常驻整个证据列表。"""
    entry = func.json_array(upload.id, upload.expired_at, Artifact.expired_at)
    return (
        select(func.count(), func.bit_xor(func.unhex(func.sha2(entry, 256))))
        .select_from(upload)
        .join(
            Artifact,
            (Artifact.workspace_id == upload.workspace_id) & (Artifact.sha256 == upload.sha256),
        )
    )


async def observe_report(session: AsyncSession, run: Run) -> ReportStreamState:
    """从已授权运行读取窄列与 JSON 摘要，覆盖无新事件的撤权、元数据到期及证据投递变化。"""
    cases = (
        await session.execute(
            select(
                CaseExecution.id,
                CaseExecution.case_version_id,
                CaseExecution.state,
                CaseExecution.outcome,
                func.sha2(CaseExecution.provenance, 256),
            )
            .where(CaseExecution.workspace_id == run.workspace_id, CaseExecution.run_id == run.id)
            .order_by(CaseExecution.id)
            .limit(1001)
        )
    ).all()
    inputs = (run_dto(run), cases)
    if run.source == "OFFLINE_IMPORT":
        imported = (
            await session.execute(
                select(
                    OfflineImport.id,
                    OfflineImport.bundle_id,
                    OfflineImport.local_run_id,
                    func.sha2(OfflineImport.declared, 256),
                    func.sha2(OfflineImport.verified, 256),
                    OfflineImport.created_at,
                ).where(
                    OfflineImport.run_id == run.id, OfflineImport.workspace_id == run.workspace_id
                )
            )
        ).one()
        attempts = (
            await session.execute(
                select(
                    OfflineAttempt.id,
                    OfflineAttempt.document["lastSequence"].as_integer(),
                    OfflineAttempt.case_execution_id,
                    OfflineAttempt.attempt_no,
                    OfflineAttempt.outcome,
                    func.sha2(OfflineAttempt.facts, 256),
                )
                .where(
                    OfflineAttempt.import_id == imported.id,
                    OfflineAttempt.workspace_id == run.workspace_id,
                )
                .order_by(OfflineAttempt.id)
            )
        ).all()
        uploads = evidence_revision(OfflineImportUpload).where(
            OfflineImportUpload.workspace_id == run.workspace_id,
            OfflineImportUpload.bundle_id == imported.bundle_id,
            OfflineImportUpload.local_run_id == imported.local_run_id,
            OfflineImportUpload.state == "COMPLETE",
        )
        return ReportStreamState(
            (*inputs, imported, attempts, (await session.execute(uploads)).one()),
            {row[0]: row[1] for row in attempts},
            {},
        )

    rows = (
        await session.execute(
            select(
                Attempt.id,
                Attempt.last_sequence,
                Attempt.job_id,
                Attempt.runtime_id,
                Attempt.attempt_no,
                Attempt.phase,
                Attempt.outcome,
                Attempt.activated_at,
                Attempt.finished_at,
                Attempt.created_at,
                func.sha2(Attempt.facts, 256),
                func.sha2(Attempt.execution_provenance, 256),
                Job.case_execution_id,
                Job.created_by,
                Job.requester_service_token_id,
            )
            .join(Job, Attempt.job_id == Job.id)
            .where(Job.workspace_id == run.workspace_id, Job.run_id == run.id, Job.kind == "TEST")
            .order_by(Attempt.id)
            .limit(2001)
        )
    ).all()
    known = {row.id: row.last_sequence for row in rows}
    authorities = await report_authorities(
        session,
        run.workspace_id,
        {
            (row.job_id, row.runtime_id): (row.created_by, row.requester_service_token_id)
            for row in rows
        },
    )
    cleanups = (
        (
            await session.execute(
                select(Job.id, Job.origin_attempt_id, Job.state, Job.outcome)
                .where(
                    Job.workspace_id == run.workspace_id,
                    Job.kind == "CLEANUP",
                    Job.origin_attempt_id.in_(known),
                )
                .order_by(Job.id)
            )
        ).all()
        if known
        else []
    )
    evidence = (
        (
            await session.execute(
                evidence_revision(AttemptUpload).where(
                    AttemptUpload.workspace_id == run.workspace_id,
                    AttemptUpload.attempt_id.in_(known),
                    AttemptUpload.complete.is_(True),
                )
            )
        ).one()
        if known
        else None
    )
    return ReportStreamState((*inputs, rows, cleanups, evidence), known, authorities)
