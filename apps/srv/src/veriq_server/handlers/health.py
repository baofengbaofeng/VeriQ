from sqlalchemy import text
from ..service import Problem
from .base import API


class HealthAPI(API):
    """存活与就绪探针处理器：live 不触库，health 执行 SELECT 1 以确认数据库连接可用；该处理器不要求会话，供编排与负载均衡探活使用。"""

    async def get(self, user_id: str | None = None) -> None:
        """按 action 分发 liveness/readiness；未知 action 映射 404，避免误报健康；未知 action 返回 NOT_FOUND，避免误把其它路径当健康。"""
        if self.action == "live":
            self.respond({"alive": True})
            return
        async with self.db.sessions() as s:
            if self.action == "health":
                await s.execute(text("SELECT 1"))
                self.respond({"ready": True})
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")
