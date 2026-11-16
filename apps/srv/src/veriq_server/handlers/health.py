"""健康处理器复用同一数据库探测并适配两组已发布协议：公开别名返回标准状态与检查项，历史 API 保留原有 alive 或 ready 字段，存活检测始终不访问数据库。

readiness 按需检查数据库版本、精确迁移头、生产静态库存与显式存储策略，不读取可选供应商或执行设备。
HTTP 存活与数据库可用性分开，不因数据库停机错误报告进程死亡。
公开与历史路由共享同一个按需监视器，只回用完成后一秒内的结果。
生产静态包启动先校验，后续就绪请求继续复验字节及启动时身份。
数据库异常仅在公开 readiness 转换成降级状态，不输出连接信息。
"""

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
        readiness 委派应用独占监视器，不在处理器中重复实现探针。
        监视器只降级已知依赖失败，程序错误仍交给既有错误边界。
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
        checks = await self.application.settings["readiness_monitor"].check()
        ready = all(checks.values())
        if self.action == "public-ready":
            self.respond({"status": "ok" if ready else "degraded", "checks": checks}, status=200 if ready else 503)
        elif ready:
            self.respond({"ready": True})
        else:
            raise Problem(500, "READINESS_UNAVAILABLE", "Readiness check failed")
