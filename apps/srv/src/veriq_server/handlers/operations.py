"""运维读取入口沿用员工会话及当前工作区管理员授权，指标查询不能因为用户拥有系统管理员身份而跨过工作区成员边界，也不从查询参数接受其他工作区编号。"""

import asyncio
from ..auth.authorization import Permission, WorkspaceScope
from ..service import Problem
from ..services.operations import workspace_metrics
from ..services.workspace import WorkspaceRepository
from .base import API


class OperationsAPI(API):
    """此处理器仅暴露工作区聚合观测，不接受任意 SQL、文件路径或命令；每次请求重新校验员工会话及成员角色，避免依赖过期页面状态泄露历史或实时数据。"""

    async def get(self, workspace_id: str) -> None:
        """在十秒查询预算内完成管理员授权和实际聚合读取，超时返回稳定不可用错误，响应继续沿用请求编号和禁止缓存头，不把数据库异常文本发送给调用方。"""
        try:
            async with asyncio.timeout(10):
                async with self.db.sessions() as session:
                    user, _ = await self.identity(session)
                    await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(
                        user, Permission.MANAGE_WORKSPACE
                    )
                    result = await workspace_metrics(session, workspace_id)
        except TimeoutError:
            raise Problem(503, "METRICS_UNAVAILABLE", "Metrics query timed out") from None
        self.respond(result)
