"""对话 HTTP 接口复用员工 Cookie、同源写入和分页信封，将工作区及会话归属校验委托给短事务中的服务。"""

import json
from typing import Any

from tornado.iostream import StreamClosedError

from ..auth.authorization import Permission, WorkspaceScope
from ..pagination import Page, boolean_filter
from ..service import Problem
from ..services.agent_sessions import session_dto
from ..services.conversational_agent import ConversationalAgent
from .base import API


class AgentAPI(API):
    """设置、会话和轮次入口仅识别员工会话，设置写入要求管理权限，轮次处理始终在当前员工的私有会话下寻找目标。"""

    # 多个动作复用处理器时，Tornado 会看到类上全部方法；在业务调度之前用动作白名单阻止错误的动词进入其它分支。
    _methods = {
        "agent-settings": {"GET", "PUT"},
        "agent-sessions": {"GET", "POST"},
        "agent-session": {"GET", "PATCH", "DELETE"},
        "agent-turns": {"GET", "POST"},
        "agent-turn-stream": {"POST"},
        "agent-confirm": {"POST"},
    }

    def prepare(self) -> None:
        """拒绝未声明的动词和显式 Bearer 认证，浏览器写入继续遵循统一 CSRF 校验及操作正文长度限制。"""
        super().prepare()
        if "Authorization" in self.request.headers:
            raise Problem(
                401, "EMPLOYEE_SESSION_REQUIRED", "Conversation requires an employee session"
            )
        if self.request.method not in self._methods[self.action]:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    def _sessions(self) -> ConversationalAgent:
        """将当前请求的员工身份解析器传给存储服务，使更新和模型调用后的处理可重新查询有效登录状态。"""
        return ConversationalAgent(self.db, self.config, self.identity)

    def _page(self, scope: WorkspaceScope, user_id: str, **filters: Any) -> Page:
        """分页签名统一绑定员工、工作区和列表类别，有归档筛选或具体会话的列表还要绑定各自的参数。"""
        return Page.read(
            self,
            {"list": self.action, "workspaceId": scope.workspace_id, "actor": user_id, **filters},
            self.config.signing_key.get_secret_value(),
        )

    def on_connection_close(self) -> None:
        """SSE 流断开时置位 disconnected，让 emit 停止向已关闭套接字写入；模型调用仍继续到结算落库，避免半份回复。"""
        self.disconnected = True

    async def _stream_turn(self, scope: WorkspaceScope, session_id: str) -> None:
        """SSE 流式提交：先解析正文并在 submit_stream 的短事务内完成授权、重放/确认分支与轮次创建，再设置 SSE 头并逐段
        下发 start/delta，最终以 done 事件返回权威轮次；事务内的业务错误统一写成 error 事件，客户端断开后停止写但保留
        模型调用到结算落库。
        """
        self.disconnected = False
        service = self._sessions()
        req = self.body("AgentTurnSubmit")

        async def emit(event: str, data: dict[str, Any]) -> None:
            if self.disconnected:
                return
            try:
                self.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n")
                await self.flush()
            except StreamClosedError:
                self.disconnected = True

        self.set_header("Content-Type", "text/event-stream")
        self.set_header("X-Accel-Buffering", "no")
        self.set_header("Cache-Control", "no-cache")
        try:
            turn = await service.submit_stream(scope, session_id, req, emit)
        except StreamClosedError:
            return
        except Problem as problem:
            if not self.disconnected:
                try:
                    self.write(f"event: error\ndata: {json.dumps({'code': problem.code})}\n\n")
                    await self.flush()
                except StreamClosedError:
                    pass
            return
        if not self.disconnected:
            try:
                self.write(f"event: done\ndata: {json.dumps(turn, ensure_ascii=False)}\n\n")
                await self.flush()
            except StreamClosedError:
                return

    async def get(self, workspace_id: str, session_id: str | None = None) -> None:
        """设置仅返回选择和解析状态，列表仅返回本人会话，读取单个会话或其轮次都必须先校验当前成员与归属。

        列表游标在此时才解析，避免通过一个游标的错误区分无权读取的会话。默认归档筛选与显式传入 false 共用游标；
        存储服务只接收已经验证的布尔值。
        """
        scope = WorkspaceScope(workspace_id)
        service = self._sessions()
        async with service.transaction(scope, lock=self.action == "agent-turns") as (session, user):
            if self.action == "agent-settings":
                data = await service.read_settings(session, scope)
            elif session_id is None:
                archived = bool(boolean_filter(self, "archived"))
                page = self._page(scope, user.id, archived=archived)
                data = await service.list_sessions(session, scope, user, page, archived=archived)
            else:
                owned = await service.require_owned_session(session, scope, user, session_id)
                if self.action == "agent-session":
                    data = session_dto(owned)
                else:
                    await service.expire(session, owned)
                    page = self._page(scope, user.id, sessionId=owned.id)
                    data = await service.list_turns(session, owned, page)
        self.respond(data)

    async def put(self, workspace_id: str) -> None:
        """设置更新使用显式可空引用作为整体替换，检查管理员权限后在与供应商变更相同的锁内校验并持久化。"""
        scope = WorkspaceScope(workspace_id)
        service = self._sessions()
        data = self.body("AgentSettingsWrite")
        async with service.transaction(scope, Permission.MANAGE_WORKSPACE, write=True) as (
            session,
            user,
        ):
            result = await service.write_settings(session, scope, user, data)
        self.respond(result)

    async def patch(self, workspace_id: str, session_id: str) -> None:
        """重命名个人会话标题；正文只接受新的标题字段，归属校验沿用现有服务并返回更新后的会话 DTO。"""
        scope = WorkspaceScope(workspace_id)
        service = self._sessions()
        data = self.body("AgentSessionRename")
        async with service.transaction(scope, write=True) as (session, user):
            row = await service.rename_session(session, scope, user, session_id, data["title"].strip())
        self.respond(session_dto(row))

    async def post(
        self, workspace_id: str, session_id: str | None = None, turn_id: str | None = None
    ) -> None:
        """创建会话只写入个人元数据；提交和确认基于同一员工身份，委托编排服务验证归属及当前业务操作权限。"""
        scope = WorkspaceScope(workspace_id)
        service = self._sessions()
        if self.action == "agent-turn-stream":
            await self._stream_turn(scope, session_id)
            return
        if session_id is None:
            data = self.body("AgentSessionCreate")
            async with service.transaction(scope, write=True) as (session, user):
                created = service.create_session(
                    session, scope, user, data.get("title", "New conversation").strip()
                )
                result = session_dto(created)
            self.respond(result, 201)
            return

        # 提交输入不携带服务端标识以外的操作参数；确认只定位已存提议，不能从确认请求注入新的模型正文或操作。
        if self.action == "agent-turns":
            result = await service.submit(scope, session_id, self.body("AgentTurnSubmit"))
        else:
            if self.request.body:
                raise Problem(
                    400, "INVALID_REQUEST", "Turn confirmation does not take a request body"
                )
            result = await service.confirm(scope, session_id, turn_id)
        self.respond(result)

    async def delete(self, workspace_id: str, session_id: str) -> None:
        """归档是可安全重试的状态更新，只隐藏默认列表中的会话，保留已经产生的轮次和执行回执供本人继续查看。"""
        scope = WorkspaceScope(workspace_id)
        service = self._sessions()
        async with service.transaction(scope, write=True) as (session, user):
            owned = await service.require_owned_session(session, scope, user, session_id)
            owned.archived = True
        self.respond({})
