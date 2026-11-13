"""健康处理器复用同一数据库探测并适配两组已发布协议：公开别名返回标准状态与检查项，历史 API 保留原有 alive 或 ready 字段，存活检测始终不访问数据库。

此处 readiness 只验证数据库连接，不代表制品存储或全部运维检查完成。
HTTP 存活与数据库可用性分开，不因数据库停机错误报告进程死亡。
公开与历史路由共享同一个处理器，不另外建立健康状态缓存。
生产静态包完整性由应用启动预检负责，后续运维任务补充其它依赖。
数据库异常仅在公开 readiness 转换成降级状态，不输出连接信息。
"""

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from ..service import Problem
from .base import API


class HealthAPI(API):
    """存活与就绪探针共用现有 API 信封和数据库句柄，通过服务器登记的 action 选择公开状态协议或历史兼容响应；匿名探测不会获得部署配置、异常文本或数据库连接串。

    public-live 与 public-ready 对应已有顶层健康契约。
    live 与 health 继续满足已使用的 API 客户端。
    其它 action 显式返回结构化 404，不以默认成功掩盖装配错误。
    """

    async def get(self, user_id: str | None = None) -> None:
        """按登记动作执行最小进程或数据库检查，公开 readiness 的已知数据库错误转换为标准 503 降级信封；历史接口的数据与异常语义保持不变，不能因新增别名改变旧客户端行为。

        live 两个入口都先返回，绝不申请数据库会话。
        readiness 复用 SELECT 1，不创建另一组探测服务。
        只捕获 SQLAlchemy 数据库错误，程序错误仍交给既有错误边界。
        降级响应不附带 exception、DSN 或驱动错误细节。
        正常响应由 API.respond 统一加入 requestId 与 no-store。
        """
        if self.action == "public-live":
            self.respond({"status": "ok", "checks": {"process": True}})
            return
        if self.action == "live":
            self.respond({"alive": True})
            return
        if self.action not in {"health", "public-ready"}:
            raise Problem(404, "NOT_FOUND", "API endpoint not found")
        try:
            async with self.db.sessions() as session:
                await session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            if self.action != "public-ready":
                raise
            self.respond({"status": "degraded", "checks": {"database": False}}, status=503)
            return
        if self.action == "public-ready":
            self.respond({"status": "ok", "checks": {"database": True}})
        else:
            self.respond({"ready": True})
