"""统一管理控制面请求的会话身份、请求关联与错误响应，在具体业务处理前验证请求来源及大小。"""

import json
from datetime import datetime
from logging import ERROR
from typing import Any, cast
from uuid import uuid4
from jsonschema import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from tornado.web import HTTPError, OutputTransform, RequestHandler
from ..db import SESSION_ACTIVITY_INTERVAL, Database, User, UserSession
from ..log import log
from ..logging_context import TraceContext, inbound_trace, trace_headers, use_trace
from ..service import Problem, digest, now
from ..settings import Settings
from ..validation import validate_api

MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024


class API(RequestHandler):
    """Tornado 控制面请求基类：统一会话 Cookie 校验、操作级正文上限、同源 Origin 门禁与 JSON Problem 映射；
    所有浏览器态处理器应继承本基类以获得统一错误信封。
    API 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """

    config: Settings
    db: Database
    action: str
    request_id: str
    trace: TraceContext
    _session_activity: tuple[str, datetime] | None

    body_limit = 65536

    def initialize(
        self,
        config: Settings,
        db: Database,
        action: str = "",
        methods: tuple[str, ...] | None = None,
    ) -> None:
        """注入 Settings、数据库句柄与路由 action，生成请求编号并验证入站链路标识。
        initialize 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.config, self.db, self.action = (config, db, action)
        if methods is not None:
            self.SUPPORTED_METHODS = methods
        self.request_id = str(uuid4())
        self.trace = inbound_trace(self.request.headers, self.request_id)
        self._session_activity = None

    async def _execute(
        self, transforms: list[OutputTransform], *args: bytes, **kwargs: bytes
    ) -> None:
        # 在 Tornado 的方法、正文和 CSRF 检查之前绑定上下文，失败路径沿用同一份标识。
        with use_trace(self.trace):
            self._set_correlation_headers()
            method = self.request.method
            log(
                "_com_request_in",
                "request.started",
                uri=self.action or "unknown",
                method=method if method in RequestHandler.SUPPORTED_METHODS else "UNKNOWN",
            )
            await super()._execute(transforms, *args, **kwargs)

    def _set_correlation_headers(self) -> None:
        self.set_header("X-Request-Id", self.request_id)
        for name, value in trace_headers(self.trace).items():
            self.set_header(name, value)

    def on_finish(self) -> None:
        """成功完成请求后才投递已认证观察值，失败响应与单纯会话探测不形成活动，当前事务无需等待活动写入。"""
        if self._session_activity and 200 <= self.get_status() < 300:
            self.db.record_session_activity(*self._session_activity)

    def set_default_headers(self) -> None:
        """默认响应头强制 JSON、禁止缓存并收紧 MIME 嗅探与 Referrer 泄露面；这些头在子类 finish 前仍可按需覆盖
        Content-Type。
        set_default_headers 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.set_header("Content-Type", "application/json; charset=UTF-8")
        self.set_header("Cache-Control", "no-store")
        self.set_header("X-Content-Type-Options", "nosniff")
        self.set_header("Referrer-Policy", "no-referrer")

    def prepare(self) -> None:
        """在业务逻辑前检查正文字节上限，并对非安全方法强制 Origin 等于 public_url；GET/HEAD/OPTIONS 跳过 Origin
        门禁以支持探测。
        prepare 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        if self.request.method not in {"GET", "HEAD", "OPTIONS"}:
            # 浏览器态写请求必须同源；原生设备入口会覆写 prepare 以放宽 Origin 规则。
            if self.request.headers.get("Origin") != self.config.public_url:
                raise Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed")

    def check_xsrf_cookie(self) -> None:
        """兼容 X-CSRF-Token 头并转写为 Tornado 期望的 X-Xsrftoken，再执行 Cookie CSRF 校验。
        check_xsrf_cookie 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if token := self.request.headers.get("X-CSRF-Token"):
            self.request.headers["X-Xsrftoken"] = token
        super().check_xsrf_cookie()

    def body(self, schema: str) -> dict[str, Any]:
        """要求 application/json，按 OpenAPI 契约 schema 名校验正文，失败统一映射 INVALID_REQUEST。
        body 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        if self.request.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise Problem(415, "JSON_REQUIRED", "Content-Type must be application/json")
        try:
            value = json.loads(self.request.body)
            validate_api(schema, value)
            return cast(dict[str, Any], value)
        except (ValueError, ValidationError, RecursionError):
            raise Problem(400, "INVALID_REQUEST", "Request body is invalid") from None

    def respond(self, data: Any, status: int = 200) -> None:
        """以 {data, requestId} 信封写出成功响应，状态码由调用方按创建/接受语义指定；requestId 与错误路径 write_error
        使用同一字段名。
        respond 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.set_status(status)
        self.write({"data": data, "requestId": self.request_id})

    def write_error(self, status_code: int, **kwargs: Any) -> None:
        """错误响应恢复被请求框架清除的请求编号头，使其与错误信封使用相同标识，同时保持稳定错误码与脱敏消息。
        Tornado 在发送错误前清空响应头，因此不能仅依赖准备阶段设置的关联标识。
        """
        exc = kwargs.get("exc_info", (None, None, None))[1]
        if isinstance(exc, Problem):
            status_code, code, message = (exc.status, exc.code, exc.message)
        elif isinstance(exc, IntegrityError):
            status_code, code, message = (409, "CONFLICT", "Account already exists")
        else:
            code = {
                400: "INVALID_REQUEST",
                403: "CSRF_FORBIDDEN",
                404: "NOT_FOUND",
                405: "METHOD_NOT_ALLOWED",
                413: "BODY_TOO_LARGE",
            }.get(status_code, "INTERNAL_ERROR")
            message = {
                400: "Request is invalid",
                403: "CSRF validation failed",
                404: "API endpoint not found",
                405: "Method not allowed",
                413: "Request body exceeds limit",
            }.get(status_code, "An unexpected error occurred")
        self.set_status(status_code)
        self._set_correlation_headers()
        self.finish({"code": code, "message": message, "details": {}, "requestId": self.request_id})

    def _handle_request_exception(self, e: BaseException) -> None:
        if isinstance(e, Problem):
            self.send_error(e.status, exc_info=(type(e), e, e.__traceback__))
        elif isinstance(e, IntegrityError):
            self.send_error(409, exc_info=(type(e), e, e.__traceback__))
        else:
            super()._handle_request_exception(e)

    def log_exception(self, typ: Any, value: Any, tb: Any) -> None:
        """只记录意外错误的类型，避免将正文、SQL 或凭据带入日志。"""
        if not isinstance(value, HTTPError) or value.status_code >= 500:
            log("_undef", "request.error", level=ERROR, error_type=typ.__name__)

    async def identity(self, s: AsyncSession, admin: bool = False) -> tuple[User, UserSession]:
        """从 veriq_session Cookie 解析未过期会话；admin=True 时额外要求 system_admin。
        identity 实现于 apps/srv/src/veriq_server/handlers/base.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        token = self.get_cookie("veriq_session")
        observed = now()
        row = None
        if token:
            row = (
                await s.execute(
                    select(User, UserSession)
                    .join(UserSession, UserSession.user_id == User.id)
                    .where(
                        UserSession.token_hash == digest(token),
                        UserSession.expires_at > observed,
                        User.disabled.is_(False),
                    )
                )
            ).first()
        if not row:
            raise Problem(401, "AUTHENTICATION_REQUIRED", "Please sign in")
        user, session = row
        # 系统管理入口在会话有效后再次核对 system_admin，避免仅靠路由层门禁。
        if admin and (not user.system_admin):
            raise Problem(403, "ADMIN_REQUIRED", "System administrator permission required")
        # 列表与认证探测不刷新活动；已知当前时间尚未达到登记间隔时，跳过队列以避免重复申请数据库连接。
        if self.action not in {"session", "sessions"} and (
            session.last_active_at is None
            or session.last_active_at <= observed - SESSION_ACTIVITY_INTERVAL
        ):
            self._session_activity = (session.id, observed)
        return (user, session)
