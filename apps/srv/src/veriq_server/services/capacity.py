"""Atomic bounded pools. Expiry changes state, never decrements usage."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import Attempt, CapacityPool, Job, ResourceLease
from ..settings import Settings


class CapacityService:
    def __init__(self, session: AsyncSession, settings: Settings):
        self.session, self.settings = session, settings

    def requirements(self, job: Job, runtime_id: str) -> list[tuple[str, int]]:
        kind = (
            "browser" if job.kind == "TEST" else "compile" if job.kind == "VALIDATE" else "cleanup"
        )
        global_limit = 4 if kind == "browser" else getattr(self.settings, kind + "_slots")
        pools = [
            (f"00/global/{kind}", global_limit),
            (f"01/workspace/{job.workspace_id}/{kind}", 2 if kind == "browser" else 1),
            (f"02/runtime/{runtime_id}", self.settings.runtime_job_slots),
        ]
        environment = job.required_capabilities.get("environmentVersionId")
        if environment and kind == "browser":
            pools.append((f"03/environment/{job.workspace_id}/{environment}", 2))
        for key in job.required_capabilities.get("resourceKeys", []):
            pools.append((f"04/resource/{job.workspace_id}/{key}", 1))
        return sorted(dict(pools).items())

    async def available(self, job: Job, runtime_id: str) -> list[CapacityPool] | None:
        # Installation authorization guard is held before these fixed-order pool locks.
        pools = []
        for key, limit in self.requirements(job, runtime_id):
            pool = (
                await self.session.execute(
                    select(CapacityPool).where(CapacityPool.key == key).with_for_update()
                )
            ).scalar_one_or_none()
            if pool is None:
                pool = CapacityPool(key=key, limit=limit, used=0)
                self.session.add(pool)
                await self.session.flush()
            if pool.used > limit:
                return None
            pool.limit = limit
            if pool.used >= pool.limit:
                return None
            pools.append(pool)
        return pools

    def reserve(self, attempt: Attempt, pools: list[CapacityPool]) -> None:
        for pool in pools:
            pool.used += 1
            self.session.add(
                ResourceLease(
                    attempt_id=attempt.id,
                    workspace_id=attempt.workspace_id,
                    pool_key=pool.key,
                    state="HELD",
                )
            )

    async def quarantine(self, attempt: Attempt) -> None:
        attempt.capacity_state = "QUARANTINED"
        rows = (
            await self.session.execute(
                select(ResourceLease).where(ResourceLease.attempt_id == attempt.id)
            )
        ).scalars()
        for row in rows:
            if row.state != "RELEASED":
                row.state = "QUARANTINED"

    async def release(self, attempt: Attempt) -> None:
        rows = (
            await self.session.execute(
                select(ResourceLease)
                .where(ResourceLease.attempt_id == attempt.id)
                .order_by(ResourceLease.pool_key)
            )
        ).scalars()
        for row in rows:
            pool = (
                await self.session.execute(
                    select(CapacityPool).where(CapacityPool.key == row.pool_key).with_for_update()
                )
            ).scalar_one()
            if row.state != "RELEASED":
                pool.used -= 1
                row.state = "RELEASED"
        attempt.capacity_state = "RELEASED"
