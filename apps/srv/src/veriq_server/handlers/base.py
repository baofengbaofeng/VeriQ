import json
import logging
import time
from typing import Any, cast
from uuid import uuid4
from jsonschema import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from tornado.web import RequestHandler
from ..db import Database, User, UserSession
from ..service import Problem, digest, now
from ..settings import Settings
from ..validation import validate_api

MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024

log = logging.getLogger("veriq.http")


class API(RequestHandler):
    """Tornado 控制面请求基类：统一会话 Cookie 校验、操作级正文上限、同源 Origin 门禁与 JSON Problem 映射；所有浏览器态处理器应继承本基类以获得统一错误信封。"""

    body_limit = 65536

    def initialize(self, config: Settings, db: Database, action: str = "") -> None:
        """注入 Settings、数据库句柄与路由 action，并生成贯穿日志的 request_id；started 单调时钟用于后续耗时度量，不写响应。"""
        self.config, self.db, self.action = (config, db, action)
        self.request_id = str(uuid4())
        self.started = time.monotonic()

    def set_default_headers(self) -> None:
        """默认响应头强制 JSON、禁止缓存并收紧 MIME 嗅探与 Referrer 泄露面；这些头在子类 finish 前仍可按需覆盖 Content-Type。"""
        self.set_header("Content-Type", "application/json; charset=UTF-8")
        self.set_header("Cache-Control", "no-store")
        self.set_header("X-Content-Type-Options", "nosniff")
        self.set_header("Referrer-Policy", "no-referrer")

    def prepare(self) -> None:
        """在业务逻辑前检查正文字节上限，并对非安全方法强制 Origin 等于 public_url；GET/HEAD/OPTIONS 跳过 Origin 门禁以支持探测。"""
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        if self.request.method not in {"GET", "HEAD", "OPTIONS"}:
            # 浏览器态写请求必须同源；原生设备入口会覆写 prepare 以放宽 Origin 规则。
            if self.request.headers.get("Origin") != self.config.public_url:
                raise Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed")

    def check_xsrf_cookie(self) -> None:
        """兼容 X-CSRF-Token 头并转写为 Tornado 期望的 X-Xsrftoken，再执行 Cookie CSRF 校验。"""
        if token := self.request.headers.get("X-CSRF-Token"):
            self.request.headers["X-Xsrftoken"] = token
        super().check_xsrf_cookie()

    def body(self, schema: str) -> dict[str, Any]:
        """要求 application/json，按 OpenAPI 契约 schema 名校验正文，失败统一映射 INVALID_REQUEST。"""
        if self.request.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise Problem(415, "JSON_REQUIRED", "Content-Type must be application/json")
        try:
            value = json.loads(self.request.body)
            validate_api(schema, value)
            return cast(dict[str, Any], value)
        except (ValueError, ValidationError, RecursionError):
            raise Problem(400, "INVALID_REQUEST", "Request body is invalid") from None

    def respond(self, data: Any, status: int = 200) -> None:
        """以 {data, requestId} 信封写出成功响应，状态码由调用方按创建/接受语义指定；requestId 与错误路径 write_error 使用同一字段名。"""
        self.set_status(status)
        self.write({"data": data, "requestId": self.request_id})

    def write_error(self, status_code: int, **kwargs: Any) -> None:
        """把 Problem、IntegrityError 与通用 HTTP 状态映射为稳定 code/message，不泄露堆栈。"""
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
        self.finish({"code": code, "message": message, "details": {}, "requestId": self.request_id})

    def _handle_request_exception(self, e: BaseException) -> None:
        if isinstance(e, Problem):
            self.send_error(e.status, exc_info=(type(e), e, e.__traceback__))
        elif isinstance(e, IntegrityError):
            self.send_error(409, exc_info=(type(e), e, e.__traceback__))
        else:
            super()._handle_request_exception(e)

    def log_exception(self, typ: Any, value: Any, tb: Any) -> None:
        """仅以 requestId 与异常类型结构化记录错误，避免把正文或令牌写入应用日志；日志为单行 JSON，便于集中检索 requestId。"""
        log.error(
            json.dumps(
                {"event": "request.error", "requestId": self.request_id, "errorType": typ.__name__}
            )
        )

    async def identity(self, s: AsyncSession, admin: bool = False) -> tuple[User, UserSession]:
        """从 veriq_session Cookie 解析未过期会话；admin=True 时额外要求 system_admin。"""
        token = self.get_cookie("veriq_session")
        row = None
        if token:
            row = (
                await s.execute(
                    select(User, UserSession)
                    .join(UserSession, UserSession.user_id == User.id)
                    .where(
                        UserSession.token_hash == digest(token),
                        UserSession.expires_at > now(),
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
        return (user, session)
