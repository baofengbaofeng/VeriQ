"""独立服务主体只携带令牌标识与审计归因，每次授权重新核验数据库当前状态；该模块不模拟员工会话，不凭创建者成员资格获取执行权，也不扩展原始证据的下载权限。"""

import json
from dataclasses import dataclass
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import ServiceToken, ServiceAccount, Workspace, ExecutionPlan, Runtime, Run, Artifact
from ..service import Problem, digest, now
from .runtime import RuntimeService


@dataclass(frozen=True)
class ServicePrincipal:
    """令牌主体与创建者归因明确分离，token_id 是执行权限的唯一入口而 attributed_user_id 仅用于既有审计外键；权限检查不能读取或要求该员工仍保持有效登录与空间成员身份。"""

    token_id: str
    attributed_user_id: str

    async def require(
        self, session: AsyncSession, workspace_id: str, plan_id: str, operation: str
    ) -> tuple[ServiceAccount, ExecutionPlan]:
        """每个执行阶段都重新读取当前账号、令牌、空间和计划，撤销、到期或归档立即失败关闭；计划范围必须显式列出且操作独立授予，知道资源编号不能代替对该资源的实际授权。"""
        token = await session.get(ServiceToken, self.token_id)
        account = await session.get(ServiceAccount, token.service_account_id) if token else None
        workspace = await session.get(Workspace, workspace_id)
        plan = await session.get(ExecutionPlan, plan_id)
        if (
            not token
            or token.purpose != "EXECUTION"
            or token.revoked_at
            or token.expires_at <= now()
        ):
            raise Problem(401, "SERVICE_TOKEN_INVALID", "Current execution token required")
        if (
            not account
            or account.disabled
            or account.workspace_id != workspace_id
            or not workspace
            or workspace.archived
            or not plan
            or plan.workspace_id != workspace_id
            or plan.archived
            or plan_id not in (token.plan_scopes or [])
            or operation not in (token.operation_scopes or [])
        ):
            raise Problem(
                403,
                "EXECUTION_SCOPE_FORBIDDEN",
                "Current explicit plan and operation scope required",
            )
        return account, plan

    async def runtime(
        self,
        session: AsyncSession,
        workspace_id: str,
        plan_id: str,
        runtime_id: str,
        operation: str = "trigger",
    ) -> Runtime:
        """服务主体仅能派发到当前计划明确选择且由其账号拥有或经所有者共享到整个空间的设备；现有设备所有者有效性和绑定检查继续生效，管理员的私人设备访问权不会传递给服务账号。"""
        account, plan = await self.require(session, workspace_id, plan_id, operation)
        service = RuntimeService(session)
        runtime, binding = await service.bound(workspace_id, runtime_id)
        await service.require_owner_current(runtime, binding)
        if runtime_id not in plan.selection["runtimeIds"] or not (
            runtime.owner_service_account_id == account.id or binding.shared_with_workspace
        ):
            raise Problem(
                403,
                "PRIVATE_RUNTIME_FORBIDDEN",
                "Explicit service ownership or Workspace sharing required",
            )
        return runtime

    async def run(
        self, session: AsyncSession, workspace_id: str, run_id: str, operation: str = "read"
    ) -> Run:
        """只读取当前授权计划产生的在线运行，离线导入和普通手动运行不会因为共享空间而变成服务令牌可见；授权针对当前令牌的计划范围而不要求它就是原始触发令牌，以支持安全轮换。"""
        run = await session.get(Run, run_id)
        if (
            not run
            or run.workspace_id != workspace_id
            or not run.plan_id
            or run.source == "OFFLINE_IMPORT"
        ):
            raise Problem(404, "RUN_NOT_FOUND", "Plan Run not found")
        await self.require(session, workspace_id, run.plan_id, operation)
        snapshot = await session.get(Artifact, (workspace_id, run.snapshot_hash))
        if not snapshot or snapshot.content is None:
            raise Problem(409, "RUN_SNAPSHOT_MISSING", "Frozen plan selection is unavailable")
        selection = json.loads(snapshot.content)["request"]
        for runtime_id in selection["runtimeIds"]:
            await self.runtime(session, workspace_id, run.plan_id, runtime_id, operation)
        return run


async def authenticate_execution(session: AsyncSession, authorization: str) -> ServicePrincipal:
    """执行入口只消费具有独立 EXECUTION 用途的 Bearer 哈希，错误或未知令牌直接拒绝而不回退浏览器 Cookie；返回主体之前不借用创建者会话，后续操作仍须核对具体空间和计划范围。"""
    if not authorization.startswith("Bearer ") or not 43 <= len(authorization[7:]) <= 128:
        raise Problem(401, "SERVICE_TOKEN_INVALID", "Execution Bearer token required")
    token = (
        await session.execute(
            select(ServiceToken).where(
                ServiceToken.token_hash == digest(authorization[7:]),
                ServiceToken.purpose == "EXECUTION",
                ServiceToken.revoked_at.is_(None),
                ServiceToken.expires_at > now(),
            )
        )
    ).scalar_one_or_none()
    account = await session.get(ServiceAccount, token.service_account_id) if token else None
    if not token or not account or account.disabled:
        raise Problem(401, "SERVICE_TOKEN_INVALID", "Current execution token required")
    return ServicePrincipal(token.id, account.created_by)
