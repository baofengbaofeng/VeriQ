"""Shared JSON errors, canonical schema validation and session authorization."""

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
    body_limit = 65536

    def initialize(self, config: Settings, db: Database, action: str = "") -> None:
        self.config, self.db, self.action = (config, db, action)
        self.request_id = str(uuid4())
        self.started = time.monotonic()

    def set_default_headers(self) -> None:
        self.set_header("Content-Type", "application/json; charset=UTF-8")
        self.set_header("Cache-Control", "no-store")
        self.set_header("X-Content-Type-Options", "nosniff")
        self.set_header("Referrer-Policy", "no-referrer")

    def prepare(self) -> None:
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")
        if self.request.method not in {"GET", "HEAD", "OPTIONS"}:
            if self.request.headers.get("Origin") != self.config.public_url:
                raise Problem(403, "ORIGIN_FORBIDDEN", "Request origin is not allowed")

    def check_xsrf_cookie(self) -> None:
        if token := self.request.headers.get("X-CSRF-Token"):
            self.request.headers["X-Xsrftoken"] = token
        super().check_xsrf_cookie()

    def body(self, schema: str) -> dict[str, Any]:
        if self.request.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise Problem(415, "JSON_REQUIRED", "Content-Type must be application/json")
        try:
            value = json.loads(self.request.body)
            validate_api(schema, value)
            return cast(dict[str, Any], value)
        except (ValueError, ValidationError, RecursionError):
            raise Problem(400, "INVALID_REQUEST", "Request body is invalid") from None

    def respond(self, data: Any, status: int = 200) -> None:
        self.set_status(status)
        self.write({"data": data, "requestId": self.request_id})

    def write_error(self, status_code: int, **kwargs: Any) -> None:
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
        log.error(
            json.dumps(
                {"event": "request.error", "requestId": self.request_id, "errorType": typ.__name__}
            )
        )

    async def identity(self, s: AsyncSession, admin: bool = False) -> tuple[User, UserSession]:
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
        if admin and (not user.system_admin):
            raise Problem(403, "ADMIN_REQUIRED", "System administrator permission required")
        return (user, session)
