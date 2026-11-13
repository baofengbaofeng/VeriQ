from sqlalchemy import select
from ..auth.authorization import WorkspaceScope
from ..db import Run
from ..pagination import Page
from ..service import lock_installation
from ..services.runs import RunService, run_dto
from ..services.workspace import WorkspaceRepository
from .base import API
from .trigger import ScopedExecutionAPI
from ..services.execution_principal import ServicePrincipal


class RunAPI(ScopedExecutionAPI):
    """运行入口显式区分员工会话与独立执行令牌，员工仍可创建和分页读取空间运行；服务令牌只允许读取或取消授权计划产生的单个运行，所有写操作在安装锁内复核当前权限和不可变关联。"""

    async def post(self, workspace_id: str, run_id: str | None = None) -> None:
        """普通员工通过既有幂等键创建运行，执行令牌必须使用计划触发入口而不能直接覆盖环境或资源选择；取消则委托运行服务检查相应主体的当前权限，接受请求不代表底层执行进程已停止。"""
        data = self.body("RunCreate" if self.action == "runs" else "CancelRequest")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user = await self.principal(session)
            service = RunService(session, user)
            if self.action == "runs":
                if isinstance(user, ServicePrincipal):
                    from ..service import Problem

                    raise Problem(
                        403, "PLAN_REQUIRED", "Service token must trigger an authorized plan"
                    )
                result = await service.create(
                    workspace_id, self.request.headers.get("Idempotency-Key", ""), data
                )
            else:
                assert run_id
                result = await service.cancel(workspace_id, run_id)
        self.respond(result, 202 if self.action == "runs" else 200)

    async def get(self, workspace_id: str, run_id: str | None = None) -> None:
        """单个运行读取允许员工或受限计划主体并由服务重新核对当前授权，空间列表仅允许员工成员枚举；即使 Bearer 同时携带有效 Cookie，也不能回退会话身份获得全部运行的列表权限。"""
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user = await self.principal(session)
            if run_id:
                result = run_dto(await RunService(session, user).get(workspace_id, run_id))
            else:
                if isinstance(user, ServicePrincipal):
                    from ..service import Problem

                    raise Problem(
                        403, "PLAN_REQUIRED", "Service token cannot enumerate Workspace Runs"
                    )
                # 列表路径先做 Workspace 成员校验，防止跨租户枚举 Run id。
                await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(user)
                page = Page.read(
                    self,
                    {"list": "runs", "workspaceId": workspace_id, "actor": user.id},
                    self.config.signing_key.get_secret_value(),
                )
                query = select(Run).where(Run.workspace_id == workspace_id)
                if page.last:
                    query = query.where(Run.id > page.last[1])
                rows = (
                    (await session.execute(query.order_by(Run.id).limit(page.limit + 1)))
                    .scalars()
                    .all()
                )
                shown = rows[: page.limit]
                result = {
                    "items": [run_dto(r) for r in shown],
                    "nextCursor": page.next((shown[-1].id, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
        self.respond(result)


class AttemptAuditAPI(API):
    """管理员 Attempt 容量强制释放：仅对已隔离/已释放 Attempt 写入停机确认审计；仅处理 QUARANTINED/RELEASED，活跃 Attempt 必须先取消。
    AttemptAuditAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    async def post(self, workspace_id: str, attempt_id: str) -> None:
        """要求 MANAGE_WORKSPACE 写权限；活跃 Attempt 必须先取消，成功后记录 administratorStopConfirmation。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        from uuid import uuid4
        from ..auth.authorization import Permission
        from ..db import Attempt, AuditLog
        from ..service import Problem, now
        from ..services.capacity import CapacityService

        data = self.body("AdminReconcileRequest")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                user, Permission.MANAGE_WORKSPACE, write=True
            )
            attempt = await session.get(Attempt, attempt_id)
            # Attempt 必须落在同一 Workspace，防止管理员跨租户误释放容量。
            if not attempt or attempt.workspace_id != workspace_id:
                raise Problem(404, "ATTEMPT_NOT_FOUND", "Attempt not found")
            if attempt.capacity_state not in {"QUARANTINED", "RELEASED"}:
                raise Problem(
                    409, "ATTEMPT_STILL_ACTIVE", "Active Attempt requires cancellation and stopping"
                )
            await CapacityService(session, self.config).release(attempt)
            attempt.facts = {
                **attempt.facts,
                "administratorStopConfirmation": {
                    "actorId": user.id,
                    "reason": data["reason"],
                    "processStopped": True,
                },
            }
            record = AuditLog(
                id=str(uuid4()),
                workspace_id=workspace_id,
                actor_id=user.id,
                target_id=attempt.id,
                action="attempt.admin_capacity_release",
                created_at=now(),
            )
            session.add(record)
            result = {"attemptId": attempt.id, "capacityReleased": True, "auditId": record.id}
        self.respond(result)
