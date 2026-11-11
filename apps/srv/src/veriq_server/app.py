"""Application composition; schema migration is an explicit operator command."""

import json
import logging
from tornado.web import Application, RequestHandler
from .db import Database
from .delivery import Delivery, ResetDispatcher, SMTPDelivery
from .settings import Settings
from .handlers.base import API
from .handlers.auth import AuthAPI
from .handlers.account import AccountAPI
from .handlers.admin import AdminAPI
from .handlers.health import HealthAPI
from .handlers.workspace import WorkspaceAPI
from .handlers.resource import ResourceAPI
from .handlers.credential import CredentialAPI, CredentialResolveAPI, AuthAdapterAPI
from .service import Problem
from .credentials.registry import IdentityRegistry

log = logging.getLogger("veriq.http")


class UnknownAPI(API):
    async def get(self, *args: str) -> None:
        raise Problem(404, "NOT_FOUND", "API endpoint not found")

    post = get
    patch = get
    delete = get
    put = get


def handler_for(action: str) -> type[API]:
    if action in {"auth-adapters", "auth-adapter-revoke"}:
        return AuthAdapterAPI
    if action in {"credentials", "credential-versions", "credential-revoke"}:
        return CredentialAPI
    if action == "credential-resolve":
        return CredentialResolveAPI
    if action in {
        "resources",
        "resource",
        "draft",
        "validation-preview",
        "validate",
        "publish",
        "versions",
        "version",
        "dependents",
        "job",
        "validation-receipt",
    }:
        return ResourceAPI
    if action in {
        "workspaces",
        "workspace",
        "members",
        "member",
        "invitations",
        "invitation",
        "accept-invitation",
    }:
        return WorkspaceAPI
    if action in {"setup", "session", "login", "logout", "reset-request", "reset-confirm"}:
        return AuthAPI
    if action in {"account", "sessions", "password", "revoke-own"}:
        return AccountAPI
    if action in {"users", "user", "reset-link", "revoke-user"}:
        return AdminAPI
    if action in {"health", "live"}:
        return HealthAPI
    return UnknownAPI


def make_app(settings: Settings, db: Database, delivery: Delivery | None = None) -> Application:
    delivery = delivery or (SMTPDelivery(settings) if settings.smtp_host else None)
    reset_dispatcher = ResetDispatcher(db, settings, delivery)
    routes = [
        ("/api/v1/setup", "setup"),
        ("/api/v1/auth/login", "login"),
        ("/api/v1/auth/session", "session"),
        ("/api/v1/auth/logout", "logout"),
        ("/api/v1/auth/password-reset", "reset-request"),
        ("/api/v1/auth/password-reset/confirm", "reset-confirm"),
        ("/api/v1/account", "account"),
        ("/api/v1/account/password", "password"),
        ("/api/v1/account/sessions", "sessions"),
        ("/api/v1/account/sessions/revoke", "revoke-own"),
        ("/api/v1/admin/users", "users"),
        ("/api/v1/admin/users/([0-9a-fA-F-]{36})/reset-link", "reset-link"),
        ("/api/v1/admin/users/([0-9a-fA-F-]{36})/sessions/revoke", "revoke-user"),
        ("/api/v1/admin/users/([0-9a-fA-F-]{36})", "user"),
        ("/api/v1/health/ready", "health"),
        ("/api/v1/health/live", "live"),
        ("/api/v1/auth/invitations/accept", "accept-invitation"),
        ("/api/v1/workspaces", "workspaces"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/members", "members"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/members/([0-9a-fA-F-]{36})", "member"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/invitations", "invitations"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/invitations/([0-9a-fA-F-]{36})", "invitation"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})", "workspace"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/resources", "resources"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})", "resource"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/draft", "draft"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/validation-preview",
            "validation-preview",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/validate", "validate"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/publish", "publish"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/versions", "versions"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/dependents",
            "dependents",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/versions/([0-9a-fA-F-]{36})",
            "version",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/jobs/([0-9a-fA-F-]{36})", "job"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/jobs/([0-9a-fA-F-]{36})/validation-receipt",
            "validation-receipt",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/credentials", "credentials"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/credentials/([A-Za-z_][A-Za-z0-9_-]{0,159})/versions",
            "credential-versions",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/credentials/([A-Za-z_][A-Za-z0-9_-]{0,159})/versions/([0-9a-fA-F-]{36})/revoke",
            "credential-revoke",
        ),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/credentials/resolve", "credential-resolve"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/auth-adapters", "auth-adapters"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/auth-adapters/([0-9a-fA-F-]{36})/revoke",
            "auth-adapter-revoke",
        ),
        ("/.*", "unknown"),
    ]

    def request_log(handler: RequestHandler) -> None:
        log.info(
            json.dumps(
                {
                    "event": "request",
                    "requestId": getattr(handler, "request_id", None),
                    "method": handler.request.method,
                    "status": handler.get_status(),
                    "durationMs": round(handler.request.request_time() * 1000),
                }
            )
        )

    return Application(
        [
            (path, handler_for(action), {"config": settings, "db": db, "action": action})
            for path, action in routes
        ],
        xsrf_cookies=True,
        xsrf_cookie_kwargs={"secure": settings.environment == "production", "samesite": "Strict"},
        cookie_secret=settings.signing_key.get_secret_value(),
        log_function=request_log,
        compress_response=False,
        mail_delivery=delivery,
        reset_dispatcher=reset_dispatcher,
        identity_reference_registry=IdentityRegistry(),
    )
