"""VeriQ 运维指标只聚合当前已授权工作区的数据，容量和设备信息通过工作区引用过滤，不输出令牌、池名称、模型输入或其他工作区的全局使用量与身份。"""

from datetime import timedelta
from typing import Any
from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import (
    Job,
    Attempt,
    AttemptEvent,
    ResourceLease,
    Runtime,
    RuntimeBinding,
    Artifact,
    ArtifactDeletion,
    ArtifactPublication,
    AttemptUpload,
    AiGeneration,
    CapacityPool,
)
from ..service import stamp
from .jobs import database_time


async def workspace_metrics(session: AsyncSession, workspace_id: str) -> dict[str, Any]:
    """读取带工作区条件的实际聚合值并明确指标口径，事件积压表示已接受事件与已持久化行的差额，模型未知账单独立计数而不会被零成本或预留金额冒充。"""
    current = await database_time(session)

    async def count(model: Any, *conditions: Any) -> int:
        return int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(model)
                    .where(model.workspace_id == workspace_id, *conditions)
                )
            ).scalar_one()
        )

    async def states(model: Any, column: Any, *conditions: Any) -> dict[str, int]:
        return {
            str(state): int(total)
            for state, total in (
                await session.execute(
                    select(column, func.count())
                    .where(model.workspace_id == workspace_id, *conditions)
                    .group_by(column)
                )
            ).all()
        }

    retained = func.coalesce(Attempt.facts["metadataExpiredAt"].as_string(), "") == ""
    events = int(
        (
            await session.execute(
                select(func.count())
                .select_from(AttemptEvent)
                .join(Attempt, Attempt.id == AttemptEvent.attempt_id)
                .where(AttemptEvent.workspace_id == workspace_id, retained)
            )
        ).scalar_one()
    )
    accepted = int(
        (
            await session.execute(
                select(func.coalesce(func.sum(Attempt.last_sequence), 0)).where(
                    Attempt.workspace_id == workspace_id, retained
                )
            )
        ).scalar_one()
    )
    runtimes = select(RuntimeBinding.runtime_id).where(
        RuntimeBinding.workspace_id == workspace_id, RuntimeBinding.active.is_(True)
    )
    heartbeat = (
        await session.execute(
            select(
                func.count(),
                func.sum(
                    (Runtime.last_seen_at.is_(None))
                    | (Runtime.last_seen_at < current - timedelta(seconds=30))
                ),
            ).where(Runtime.id.in_(runtimes))
        )
    ).one()
    storage = (
        await session.execute(
            select(
                func.count(),
                func.coalesce(func.sum(Artifact.size_bytes), 0),
            ).where(Artifact.workspace_id == workspace_id, Artifact.expired_at.is_(None))
        )
    ).one()
    costs = (
        await session.execute(
            select(
                func.coalesce(func.sum(AiGeneration.cost_micros), 0),
                func.coalesce(
                    func.sum(
                        case(
                            (AiGeneration.status == "RUNNING", AiGeneration.reserved_micros),
                            else_=0,
                        )
                    ),
                    0,
                ),
            ).where(AiGeneration.workspace_id == workspace_id)
        )
    ).one()
    capacity = await states(ResourceLease, ResourceLease.state)
    for kind, default in (("browser", 2), ("compile", 1), ("cleanup", 1)):
        pool = await session.get(CapacityPool, f"01/workspace/{workspace_id}/{kind}")
        capacity[kind + "Limit"] = pool.limit if pool else default
        capacity[kind + "Used"] = pool.used if pool else 0
    return {
        "workspaceId": workspace_id,
        "observedAt": stamp(current),
        "queue": await states(Job, Job.state),
        "capacity": capacity,
        "leases": {
            "active": await count(Attempt, Attempt.phase != "FINISHED"),
            "expired": await count(
                Attempt, Attempt.phase != "FINISHED", Attempt.lease_expires_at <= current
            ),
        },
        "heartbeat": {"devices": int(heartbeat[0]), "stale": int(heartbeat[1] or 0)},
        "events": {"persisted": events, "accepted": accepted, "backlog": max(0, accepted - events)},
        "cleanup": await states(Job, Job.state, Job.kind == "CLEANUP"),
        "storage": {
            "objects": int(storage[0]),
            "bytes": int(storage[1]),
            "pendingDeletions": await count(
                ArtifactDeletion, ArtifactDeletion.deleted_at.is_(None)
            ),
            "pendingPublications": await count(
                ArtifactPublication, ArtifactPublication.state == "PENDING"
            ),
            "incompleteUploads": await count(
                AttemptUpload, AttemptUpload.complete.is_(False), AttemptUpload.expired_at.is_(None)
            ),
        },
        "modelCost": {
            "recordedMicros": int(costs[0]),
            "reservedMicros": int(costs[1]),
            "unknown": await count(AiGeneration, AiGeneration.cost_micros.is_(None)),
        },
    }
