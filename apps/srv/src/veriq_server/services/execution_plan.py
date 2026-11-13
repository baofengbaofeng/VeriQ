"""计划服务在安装锁内冻结已发布资源选择并分配稳定序号，复用现有运行服务展开矩阵与统一任务队列；幂等请求绑定调用输入和主体，计划后续修改不会重写已经接受的运行快照。"""

from hashlib import sha256
from typing import Any, Literal, TypedDict
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import canonical_bytes
from ..db import ExecutionPlan, Run, Attempt, Job, User
from ..repositories.resource import ResourceRepository
from ..service import Problem, now, audit
from .workspace import WorkspaceRepository
from .runtime import RuntimeService
from .execution_principal import ServicePrincipal
from .runs import RunService


class TriggerReceipt(TypedDict):
    """触发回执只描述本次请求的接受、复用或跳过决策与权威状态地址，不承载业务通过结论；服务接口返回统一类型，由 HTTP 层依据决策选择状态码，避免调用者误把创建成功当作执行成功。"""

    decision: Literal["ENQUEUED", "REUSED", "SKIPPED"]
    runId: str
    statusUrl: str


async def earlier_plan_work(
    session: AsyncSession, plan_id: str, sequence: int | None = None
) -> bool:
    """后续运行既等待前驱逻辑终态，也等待其真实进程占用已释放；序号由安装锁串行分配而不依赖同一微秒时间排序，未知物理进程即使已标记失败也继续阻止重叠运行领取。"""
    query = select(Run.id).where(Run.plan_id == plan_id)
    if sequence is not None:
        query = query.where(Run.plan_sequence < sequence)
    pending = await session.scalar(query.where(Run.state != "FINISHED").limit(1))
    held = await session.scalar(
        select(Attempt.id)
        .join(Job, Attempt.job_id == Job.id)
        .where(
            Job.run_id.in_(query),
            Attempt.capacity_state != "RELEASED",
        )
        .limit(1)
    )
    return pending is not None or held is not None


def plan_dto(plan: ExecutionPlan) -> dict[str, Any]:
    """计划响应包含当前修订和显式归档状态以及原始选择，客户端必须携带修订才能更新或归档；服务只返回资源引用和非敏感配置，不从身份适配器或凭证库补入任何秘密明文。"""
    return {
        "id": plan.id,
        "workspaceId": plan.workspace_id,
        "name": plan.name,
        "revision": plan.revision,
        "archived": plan.archived,
        **plan.selection,
    }


class ExecutionPlanService:
    """计划管理与触发分别校验编辑、执行权限，服务账号仅能使用已授予的计划而不能修改其配置；所有方法依赖调用者提供安装锁事务以原子处理修订、重叠判定和全局运行准入。"""

    def __init__(self, session: AsyncSession, actor: User | ServicePrincipal):
        """保存调用主体但不将服务账号转换成员工，后续管理操作明确要求用户而触发允许受限服务身份；归因仍由现有用户外键承载，权限判定只读取当前主体自己的授权来源。"""
        self.session, self.actor = session, actor

    async def get(self, workspace_id: str, plan_id: str) -> ExecutionPlan:
        """嵌套计划查询总是先约束空间归属，用户需当前成员权限而独立服务身份需具体计划执行范围；归档计划保留供管理界面展示，实际触发路径再拒绝使用其生成新运行。"""
        if isinstance(self.actor, ServicePrincipal):
            _, granted_plan = await self.actor.require(
                self.session, workspace_id, plan_id, "trigger"
            )
            return granted_plan
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(self.actor)
        plan = await self.session.get(ExecutionPlan, plan_id)
        if not plan or plan.workspace_id != workspace_id:
            raise Problem(404, "PLAN_NOT_FOUND", "Execution plan not found")
        return plan

    async def write(
        self, workspace_id: str, data: dict[str, Any], plan_id: str | None = None
    ) -> ExecutionPlan:
        """管理写入验证真实已发布套件和环境、当前设备派发权与角色集合，更新以修订号防止覆盖并保留原序号；计划只能引用本空间资源，变量和值会随触发复制到不可变运行快照。"""
        if isinstance(self.actor, ServicePrincipal):
            raise Problem(403, "PLAN_MANAGEMENT_FORBIDDEN", "Employee editor permission required")
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(
            self.actor, Permission.EDIT, write=True
        )
        plan = await self.get(workspace_id, plan_id) if plan_id else None
        if plan and (
            plan.archived or data.get("revision") != plan.revision or plan.revision >= 2147483646
        ):
            raise Problem(409, "PLAN_REVISION_CONFLICT", "Current active plan revision required")
        if not plan and "revision" in data:
            raise Problem(400, "INVALID_REVISION", "New plan must not specify revision")
        repo = ResourceRepository(self.session, WorkspaceScope(workspace_id))
        for field, kind in [("suiteVersionId", "SUITE"), ("environmentVersionId", "ENVIRONMENT")]:
            version = await repo.version(data[field])
            resource = await repo.resource(version.resource_id)
            if resource.status == "ARCHIVED":
                raise Problem(
                    409, "RESOURCE_ARCHIVED", "Plan requires an active published resource"
                )
            if version.kind != kind:
                raise Problem(
                    422, "INVALID_SELECTION", "Published resource kind differs from plan selection"
                )
            if kind == "ENVIRONMENT" and not set(data["roleKeys"]) <= {
                r["roleKey"] for r in version.document_json["document"]["roles"]
            }:
                raise Problem(422, "ROLE_UNAVAILABLE", "Selected role is absent from Environment")
        for runtime_id in data["runtimeIds"]:
            await RuntimeService(self.session).require_dispatch(
                self.actor, workspace_id, runtime_id
            )
        selection = {k: v for k, v in data.items() if k not in {"name", "revision"}}
        if plan:
            plan.name, plan.selection, plan.revision = data["name"], selection, plan.revision + 1
        else:
            plan = ExecutionPlan(
                id=str(uuid4()),
                workspace_id=workspace_id,
                name=data["name"],
                selection=selection,
                revision=1,
                next_sequence=0,
                archived=False,
                created_by=self.actor.id,
                created_at=now(),
            )
            self.session.add(plan)
        audit(
            self.session,
            "execution_plan.updated" if plan_id else "execution_plan.created",
            self.actor.id,
            plan.id,
            workspace_id=workspace_id,
        )
        return plan

    async def archive(self, workspace_id: str, plan_id: str, revision: int) -> None:
        """归档只改变当前可用性并保留历史快照和运行关联，必须核对当前编辑权限与修订，防止管理界面陈旧请求覆盖新设置；服务执行阶段看到归档立即停止继续授予执行权限。"""
        if isinstance(self.actor, ServicePrincipal):
            raise Problem(403, "PLAN_MANAGEMENT_FORBIDDEN", "Employee editor permission required")
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(
            self.actor, Permission.EDIT, write=True
        )
        plan = await self.get(workspace_id, plan_id)
        if revision != plan.revision or plan.revision >= 2147483646:
            raise Problem(409, "PLAN_REVISION_CONFLICT", "Current plan revision required")
        plan.archived, plan.revision = True, plan.revision + 1
        audit(
            self.session,
            "execution_plan.archived",
            self.actor.id,
            plan.id,
            workspace_id=workspace_id,
        )


class TriggerService(ExecutionPlanService):
    """触发服务复用现有运行创建路径，仅增加计划冻结、稳定串行序号及轻量跳过记录；请求重放首先验证当前主体，再比较原始输入摘要，不重新套用已经修改的计划参数或重新生成任务。"""

    async def trigger(
        self, scope: WorkspaceScope, plan_id: str, input: dict[str, Any], idempotency_key: str
    ) -> TriggerReceipt:
        """首次准入返回接受或跳过回执，重复请求返回同一运行而不同输入冲突；重叠包含未知物理占用，QUEUE 准入继续受原有十运行限制，实际领取另核对前驱序号与物理释放状态。"""
        workspace_id = scope.workspace_id
        plan = await self.get(workspace_id, plan_id)
        if plan.archived:
            raise Problem(409, "PLAN_ARCHIVED", "Execution plan is archived")
        if (
            not idempotency_key
            or len(idempotency_key) > 160
            or any(ord(c) < 33 or ord(c) > 126 for c in idempotency_key)
        ):
            raise Problem(
                400, "IDEMPOTENCY_KEY_REQUIRED", "Printable bounded idempotency key required"
            )
        actor_key = (
            self.actor.token_id if isinstance(self.actor, ServicePrincipal) else self.actor.id
        )
        request_hash = sha256(
            canonical_bytes({"actor": actor_key, "planId": plan_id, "input": input})
        ).hexdigest()
        service = RunService(self.session, self.actor)
        service.plan_id = plan_id
        await service.authorize(workspace_id)
        existing = (
            await self.session.execute(
                select(Run).where(
                    Run.workspace_id == workspace_id, Run.idempotency_key == idempotency_key
                )
            )
        ).scalar_one_or_none()
        if existing:
            if existing.request_hash != request_hash or existing.plan_id != plan_id:
                raise Problem(409, "IDEMPOTENCY_CONFLICT", "Trigger input or principal changed")
            if isinstance(self.actor, ServicePrincipal):
                await self.actor.run(self.session, workspace_id, existing.id, "trigger")
            return self.receipt(existing, "REUSED")
        repo = ResourceRepository(self.session, scope)
        for version_id in [
            plan.selection["suiteVersionId"],
            plan.selection["environmentVersionId"],
        ]:
            version = await repo.version(version_id)
            if (await repo.resource(version.resource_id)).status == "ARCHIVED":
                raise Problem(
                    409, "RESOURCE_ARCHIVED", "Plan requires an active published resource"
                )
        selected_runtimes = []
        for runtime_id in plan.selection["runtimeIds"]:
            runtime = (
                await self.actor.runtime(self.session, workspace_id, plan_id, runtime_id)
                if isinstance(self.actor, ServicePrincipal)
                else await RuntimeService(self.session).require_dispatch(
                    self.actor, workspace_id, runtime_id
                )
            )
            selected_runtimes.append(runtime)
        if plan.next_sequence >= 2147483646:
            raise Problem(409, "PLAN_SEQUENCE_EXHAUSTED", "Create a new execution plan")
        overlap = await earlier_plan_work(self.session, plan_id)
        policy = plan.selection["overlapPolicy"]
        if overlap and policy == "REJECT":
            raise Problem(409, "PLAN_OVERLAP", "Earlier plan execution is unfinished")
        data = {
            k: v for k, v in plan.selection.items() if k not in {"overlapPolicy", "maxCaseRetries"}
        }
        data["maxRetries"] = plan.selection["maxCaseRetries"]
        data["triggerInput"] = input
        if overlap and policy == "SKIP":
            repo = ResourceRepository(self.session, scope)
            run = Run(
                id=str(uuid4()),
                workspace_id=workspace_id,
                created_by=service.attribution,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                trigger_kind="HTTP_TRIGGER",
                source=selected_runtimes[0].location,
                state="FINISHED",
                outcome="SKIPPED",
                reason_code="OVERLAP_SKIPPED",
                snapshot_hash=await repo.store(
                    canonical_bytes({"request": data, "planRevision": plan.revision})
                ),
                created_at=now(),
            )
            self.session.add(run)
        else:
            result = await service.create(workspace_id, idempotency_key, data)
            created_run = await self.session.get(Run, result["id"])
            assert created_run
            run = created_run
            run.request_hash, run.trigger_kind = request_hash, "HTTP_TRIGGER"
        plan.next_sequence += 1
        run.plan_id, run.plan_revision, run.plan_sequence = (
            plan.id,
            plan.revision,
            plan.next_sequence,
        )
        run.requester_service_token_id = (
            self.actor.token_id if isinstance(self.actor, ServicePrincipal) else None
        )
        audit(
            self.session,
            "execution_plan.triggered",
            service.attribution,
            run.id,
            workspace_id=workspace_id,
        )
        return self.receipt(run, "SKIPPED" if run.outcome == "SKIPPED" else "ENQUEUED")

    @staticmethod
    def receipt(run: Run, decision: Literal["ENQUEUED", "REUSED", "SKIPPED"]) -> TriggerReceipt:
        """回执只暴露决策、运行标识和同源轮询地址，不把 HTTP 接受等同业务通过；跳过状态由运行详情保留独立原因，CI 必须继续按最终结果与门禁事实决定退出码而不能仅检查请求成功。"""
        return {
            "decision": decision,
            "runId": run.id,
            "statusUrl": f"/api/v1/workspaces/{run.workspace_id}/runs/{run.id}",
        }
