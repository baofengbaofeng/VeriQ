"""容量池服务按固定键序锁定 global/workspace/runtime/environment/resource 槽位，默认浏览器全局四、Workspace 二。
available 在安装护栏下 FOR UPDATE；超卖返回 None。过期进程 quarantine 至 release。
"""


from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import Attempt, CapacityPool, Job, ResourceLease
from ..settings import Settings


class CapacityService:
    """为 claim 预留容量，支持释放或隔离，杜绝无锁 count 超卖，CapacityService 路径必须遵守 Workspace 作用域。"""
    def __init__(self, session: AsyncSession, settings: Settings):
        """保存会话与 Settings，读取各类槽位上限配置，CapacityService.__init__ 路径必须遵守 Workspace 作用域。"""
        self.session, self.settings = session, settings

    def requirements(self, job: Job, runtime_id: str) -> list[tuple[str, int]]:
        """按 Job 种类与能力展开有序容量键列表，CapacityService.requirements 路径必须遵守 Workspace 作用域。"""
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
        """固定顺序锁池；已满或 used>limit 则返回 None，CapacityService.available 路径必须遵守 Workspace 作用域。"""
        # 调用方须先持有安装授权护栏，再按固定顺序对容量池加锁，避免与开局突变死锁。
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
        """递增 used 并写入 HELD 状态 ResourceLease，CapacityService.reserve 路径必须遵守 Workspace 作用域。"""
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
        """标记 QUARANTINED 不回退 used，剥夺过期权威，CapacityService.quarantine 路径必须遵守 Workspace 作用域。"""
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
        """按 pool_key 锁池回退 used，状态改为 RELEASED，CapacityService.release 路径必须遵守 Workspace 作用域。"""
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
