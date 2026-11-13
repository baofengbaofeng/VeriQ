"""计划管理保留浏览器同源和 CSRF，触发与单运行 CI 入口显式区分 Bearer 主体；任何 Authorization 头都会进入令牌校验且失败不回退 Cookie，安全摘要不返回原始证据或断言值。"""

from typing import Any
from xml.etree.ElementTree import Element, SubElement, tostring
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..db import ExecutionPlan, User
from ..pagination import Page
from ..service import Problem, lock_installation
from ..services.execution_plan import ExecutionPlanService, TriggerService, plan_dto
from ..services.execution_principal import ServicePrincipal, authenticate_execution
from ..services.report import ReportService
from ..services.workspace import WorkspaceRepository
from .base import API


class ExecutionPlanAPI(API):
    """计划管理支持分页、修订更新和保留历史的归档，所有操作保持员工 Cookie 身份；浏览器不能凭外部执行令牌编辑计划以扩大授权，也不能通过隐藏表单字段绕过服务器的空间和设备校验。"""

    def prepare(self) -> None:
        """计划管理只接受员工浏览器身份，显式 Authorization 不能被忽略后回退到同时携带的 Cookie；外部令牌必须走限定触发入口，防止调用方误以为计划编辑已经受到自动化范围约束。"""
        super().prepare()
        if "Authorization" in self.request.headers:
            raise Problem(
                401, "EMPLOYEE_SESSION_REQUIRED", "Plan management requires an employee session"
            )

    async def get(self, workspace_id: str, plan_id: str | None = None) -> None:
        """列表绑定当前用户和空间生成有界游标，单条查询复用计划服务的嵌套归属检查；返回归档标记供界面明确展示，不把归档计划从历史关联中删除或重新开放触发权限。"""
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            service = ExecutionPlanService(session, user)
            if plan_id:
                result = plan_dto(await service.get(workspace_id, plan_id))
            else:
                await WorkspaceRepository(session, WorkspaceScope(workspace_id)).authorize(user)
                page = Page.read(
                    self,
                    {"list": "execution-plans", "workspaceId": workspace_id, "actor": user.id},
                    self.config.signing_key.get_secret_value(),
                )
                query = select(ExecutionPlan).where(ExecutionPlan.workspace_id == workspace_id)
                if page.last:
                    query = query.where(ExecutionPlan.id > page.last[1])
                rows = list(
                    (
                        await session.scalars(
                            query.order_by(ExecutionPlan.id).limit(page.limit + 1)
                        )
                    ).all()
                )
                shown = rows[: page.limit]
                result = {
                    "items": [plan_dto(p) for p in shown],
                    "nextCursor": page.next((shown[-1].id, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
        self.respond(result)

    async def post(self, workspace_id: str) -> None:
        """创建计划只接受契约允许的资源、角色、浏览器与设备选择，安装锁内验证权限和持久化后返回当前修订；服务端不保存 Cron 表达式，也不在创建时偷偷派生后台扫描或执行任务。"""
        data = self.body("ExecutionPlanWrite")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            result = plan_dto(await ExecutionPlanService(session, user).write(workspace_id, data))
        self.respond(result, 201)

    async def put(self, workspace_id: str, plan_id: str) -> None:
        """计划更新必须携带当前修订，服务重新验证每个嵌套引用和设备权限再替换配置；已接受运行保存自己的选择和序号，修改当前计划不会改变旧运行的资产哈希或幂等回执。"""
        data = self.body("ExecutionPlanWrite")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            result = plan_dto(
                await ExecutionPlanService(session, user).write(workspace_id, data, plan_id)
            )
        self.respond(result)

    async def delete(self, workspace_id: str, plan_id: str) -> None:
        """删除语义采用带修订的归档而不物理删除计划，保留所有已触发运行和服务授权的可审计关联；请求与其他浏览器写操作一样要求同源和 CSRF，并由安装锁串行处理并发修改。"""
        data = self.body("ExecutionPlanArchive")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            await ExecutionPlanService(session, user).archive(
                workspace_id, plan_id, data["revision"]
            )
        self.respond({})


class ScopedExecutionAPI(API):
    """仅在显式 Authorization 分支跳过浏览器 CSRF，实际业务前仍须完成受限 Bearer 校验；令牌格式错误、过期或用途不匹配直接失败，不能利用同时存在的 Cookie 继承员工权限。"""

    def check_xsrf_cookie(self) -> None:
        """自动化客户端没有浏览器 Cookie 时使用独立 Bearer 认证，故仅此分支免除 CSRF；出现任意 Authorization 内容也不得回退浏览器身份，未携带该头的普通网页仍执行原有 CSRF 验证。"""
        if "Authorization" not in self.request.headers:
            super().check_xsrf_cookie()

    def prepare(self) -> None:
        """Bearer 路径保留正文上限与请求标识并交由异步主体校验决定是否可执行，普通网页路径继续使用原有 Origin 检查；此处仅选择认证协议，绝不把存在某个头当作已经授权成功。"""
        if "Authorization" not in self.request.headers:
            super().prepare()
        else:
            self.set_header("X-Request-Id", self.request_id)
            if len(self.request.body) > self.body_limit:
                raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")

    async def principal(self, session: AsyncSession) -> User | ServicePrincipal:
        """请求只能产生一种主体，Bearer 失败立即传播而不会调用员工身份解析；普通浏览器通过现有会话函数校验当前用户状态，后续计划和运行服务仍各自校验所需资源与操作权限。"""
        if "Authorization" in self.request.headers:
            return await authenticate_execution(session, self.request.headers["Authorization"])
        return (await self.identity(session))[0]


class TriggerAPI(ScopedExecutionAPI):
    """外部触发与网页手动触发共享同一个计划准入事务及回执协议，调用输入仅含有界构建标识和说明，不能覆盖计划之外的环境、身份或代码，也不能另建一套执行队列规避容量限制。"""

    async def post(self, workspace_id: str, plan_id: str) -> None:
        """在安装锁内完成当前主体、计划范围、幂等冲突和重叠策略判定，然后复用运行服务冻结选择；返回明确 HTTP 接受或跳过状态，客户端自行通过状态地址轮询而无需保持长连接。"""
        data = self.body("TriggerRequest")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            actor = await self.principal(session)
            result = await TriggerService(session, actor).trigger(
                WorkspaceScope(workspace_id),
                plan_id,
                data,
                self.request.headers.get("Idempotency-Key", ""),
            )
        self.respond(result, 202 if result["decision"] == "ENQUEUED" else 200)


class CIReportAPI(ScopedExecutionAPI):
    """CI 摘要只复用权威报告中的状态、计数和门禁，不返回断言实际值、环境内容或原始制品；JUnit 是这些安全事实的薄投影，原始 Playwright JUnit 继续受现有管理员证据下载权限约束。"""

    async def get(self, workspace_id: str, run_id: str) -> None:
        """当前主体先按计划读取报告，输出仅含内部标识和服务端状态枚举，避免通过业务标题、失败文本或日志泄露凭证；非通过结果始终保留为失败门禁，零用例也不产生虚假通过测试。"""
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            actor = await self.principal(session)
            report = await ReportService(session, actor, self.config).get(
                WorkspaceScope(workspace_id), run_id
            )
            result = {
                "run": report["run"],
                "gatePassed": report["gateAtExecution"]["passed"] and report["gateNow"]["passed"],
                "cases": [
                    {"id": c["id"], "state": c["state"], "outcome": c["outcome"]}
                    for c in report["cases"]
                ],
                "statistics": report["statistics"],
            }
        if self.action == "ci-report":
            self.respond(result)
            return
        if result["run"]["state"] != "FINISHED":
            raise Problem(409, "RUN_UNFINISHED", "JUnit requires a terminal Run")
        payload = sanitized_junit(result)
        self.set_header("Content-Type", "application/xml; charset=utf-8")
        self.set_header("Content-Disposition", 'attachment; filename="veriq-junit.xml"')
        self.finish(payload)


def sanitized_junit(report: dict[str, Any]) -> bytes:
    """使用标准 XML 库转义安全标识并把每个真实用例输出为一个测试，跳过和缺失结果不视为成功；额外门禁测试只在运行整体未满足通过条件时出现，确保主流 CI 不会因为零失败而误判成功。"""
    suite = Element("testsuite", name="VeriQ", id=report["run"]["id"])
    failures = 0
    for case in report["cases"]:
        node = SubElement(suite, "testcase", name=case["id"], classname="VeriQ")
        if case["outcome"] != "PASSED":
            failures += 1
            SubElement(
                node,
                "failure",
                type=case["outcome"] or "INCOMPLETE",
                message="Execution did not pass",
            )
    gate_failed = (
        not report["gatePassed"] or report["run"].get("outcome") != "PASSED" or not report["cases"]
    )
    if gate_failed:
        failures += 1
        gate = SubElement(suite, "testcase", name="veriq-run-gate", classname="VeriQ.Gate")
        SubElement(
            gate,
            "failure",
            type=report["run"].get("outcome") or "INCOMPLETE",
            message="Run gate did not pass",
        )
    suite.set("tests", str(len(report["cases"]) + int(gate_failed)))
    suite.set("failures", str(failures))
    result: bytes = tostring(suite, encoding="utf-8", xml_declaration=True)
    return result
