
"""Tornado 应用装配：将 /api 与 /internal 路由映射到处理器，注入重置投递、身份注册表、导出槽与尝试证明校验器。

公开 API 与内部维护/领取端点共用 handler_for 分发；未知路径落入 UnknownAPI 返回稳定 404。
生产环境开启 Secure+Strict XSRF Cookie；bundle 导出并发由 Semaphore(2) 限制。
控制面运行时不需要 Node 或 Chrome，执行与离线能力走独立 Runtime/Agent。
"""

import asyncio
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
from .handlers.service_account import ServiceAccountAPI
from .handlers.execution import ExecutionAPI
from .handlers.run import RunAPI, AttemptAuditAPI
from .handlers.report import ReportAPI
from .handlers.ai import AiAPI
from .handlers.bundle import BundleAPI, NativeBundleAPI
from .handlers.import_result import (
    ImportAPI,
    ImportUploadAPI,
    NativeImportAPI,
    NativeImportUploadAPI,
)
from .services.lease import DatabaseAttemptProofVerifier
from .handlers.enrollment import DeviceAPI, EnrollmentAPI, RuntimeAPI
from .service import Problem
from .credentials.registry import IdentityRegistry

log = logging.getLogger("veriq.http")


class UnknownAPI(API):
    """兜底处理器：对未登记路径的任意 HTTP 动词统一抛出 NOT_FOUND，避免静默 200 或方法泄露，UnknownAPI 的失败路径返回稳定错误。"""

    async def get(self, *args: str) -> None:
        """拒绝未知路径上的 GET（以及其他动词别名），返回 404 问题对象给客户端，UnknownAPI.get 的失败路径返回稳定错误。"""
        raise Problem(404, "NOT_FOUND", "API endpoint not found")

    post = get
    patch = get
    delete = get
    put = get


def handler_for(action: str) -> type[API]:
    """按路由动作名选择具体 API 处理器类；当动作未匹配时回退到 UnknownAPI，handler_for 的失败路径返回稳定错误。"""
    if action == "native-result-imports":
        return NativeImportAPI
    if action == "native-result-import-uploads":
        return NativeImportUploadAPI
    if action == "result-import-uploads":
        return ImportUploadAPI
    if action == "result-imports":
        return ImportAPI
    if action in {"issuer-trust", "native-bundle-download"}:
        return NativeBundleAPI
    if action in {"bundles", "bundle", "bundle-manifest", "bundle-download"}:
        return BundleAPI
    if action.startswith("ai-"):
        return AiAPI
    if action in {
        "report",
        "report-artifacts",
        "report-artifact",
        "report-history",
        "report-stream",
        "report-audit",
        "report-display",
    }:
        return ReportAPI
    if action == "attempt-audit":
        return AttemptAuditAPI
    if action in {"runs", "run", "run-cancel"}:
        return RunAPI
    if action in {
        "finish",
        "events",
        "upload-create",
        "upload-chunk",
        "content",
        "claim",
        "activate",
        "heartbeat",
        "reconcile",
        "expired-leases/reap",
        "fixture-cleanups/reconcile",
        "capacity/reconcile",
        "artifacts/expire",
    }:
        return ExecutionAPI
    if action in {
        "service-accounts",
        "service-token-issue",
        "service-account-disable",
        "service-token-revoke",
    }:
        return ServiceAccountAPI
    if action in {
        "service-enroll",
        "enrollment-request",
        "enrollment-poll",
        "device-info",
        "device-rotate",
        "device-logout",
    }:
        return DeviceAPI
    if action in {"enrollment-inspect", "enrollment-approve"}:
        return EnrollmentAPI
    if action in {
        "runtimes",
        "runtime",
        "runtime-grants",
        "runtime-trust",
        "runtime-delivery",
        "runtime-revoke",
    }:
        return RuntimeAPI
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
        "compiled-source",
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
    """构建 Tornado Application：注册全部公开与内部路由，并注入投递、身份与围栏校验依赖，make_app 的失败路径返回稳定错误。"""
    delivery = delivery or (SMTPDelivery(settings) if settings.smtp_host else None)
    reset_dispatcher = ResetDispatcher(db, settings, delivery)
    routes = [
        ("/internal/v1/issuer", "issuer-trust"),
        (
            "/internal/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})/download",
            "native-bundle-download",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/result-imports", "result-imports"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads", "result-import-uploads"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads/([0-9a-fA-F-]{36})",
            "result-import-uploads",
        ),
        ("/internal/v1/workspaces/([0-9a-fA-F-]{36})/result-imports", "native-result-imports"),
        (
            "/internal/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads",
            "native-result-import-uploads",
        ),
        (
            "/internal/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads/([0-9a-fA-F-]{36})",
            "native-result-import-uploads",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles", "bundles"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})", "bundle"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})/manifest",
            "bundle-manifest",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})/download",
            "bundle-download",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/providers", "ai-providers"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/providers/([0-9a-fA-F-]{36})", "ai-provider"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/providers/([0-9a-fA-F-]{36})/connection-tests",
            "ai-connection",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/context", "ai-context"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/generations", "ai-generations"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/generations/([0-9a-fA-F-]{36})",
            "ai-generation",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/generations/([0-9a-fA-F-]{36})/review",
            "ai-review",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/ai/generations/([0-9a-fA-F-]{36})/cancel",
            "ai-cancel",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/attempts/([0-9a-fA-F-]{36})/reconcile",
            "attempt-audit",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})/report", "report"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})/attempts/([0-9a-fA-F-]{36})/display",
            "report-display",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})/events/stream",
            "report-stream",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/attempts/([0-9a-fA-F-]{36})/history",
            "report-history",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/attempts/([0-9a-fA-F-]{36})/artifacts",
            "report-artifacts",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/attempts/([0-9a-fA-F-]{36})/artifacts/([0-9a-fA-F-]{36})",
            "report-artifact",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/audit", "report-audit"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runs", "runs"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})", "run"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})/cancel", "run-cancel"),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/finish", "finish"),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/events", "events"),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/artifact-uploads", "upload-create"),
        (
            "/internal/v1/attempts/([0-9a-fA-F-]{36})/artifact-uploads/([0-9a-fA-F-]{36})",
            "upload-chunk",
        ),
        (
            "/internal/v1/workspaces/([0-9a-fA-F-]{36})/attempts/([0-9a-fA-F-]{36})/content/([0-9a-f]{64})",
            "content",
        ),
        ("/internal/v1/maintenance/expired-leases/reap", "expired-leases/reap"),
        ("/internal/v1/maintenance/fixture-cleanups/reconcile", "fixture-cleanups/reconcile"),
        ("/internal/v1/maintenance/capacity/reconcile", "capacity/reconcile"),
        ("/internal/v1/maintenance/artifacts/expire", "artifacts/expire"),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/reconcile", "reconcile"),
        ("/internal/v1/jobs/claim", "claim"),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/activate", "activate"),
        ("/internal/v1/attempts/([0-9a-fA-F-]{36})/heartbeat", "heartbeat"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/runtimes/([0-9a-fA-F-]{36})/credential-delivery",
            "runtime-delivery",
        ),
        ("/internal/v1/runtime-enrollments/service", "service-enroll"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/service-accounts", "service-accounts"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/service-accounts/([0-9a-fA-F-]{36})/tokens",
            "service-token-issue",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/service-accounts/([0-9a-fA-F-]{36})/disable",
            "service-account-disable",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/service-accounts/([0-9a-fA-F-]{36})/tokens/([0-9a-fA-F-]{36})/revoke",
            "service-token-revoke",
        ),
        ("/api/v1/runtime-enrollments", "enrollment-request"),
        ("/api/v1/runtime-enrollments/poll", "enrollment-poll"),
        ("/api/v1/runtime-enrollments/inspect", "enrollment-inspect"),
        ("/api/v1/runtime-enrollments/([0-9a-fA-F-]{36})/approve", "enrollment-approve"),
        ("/internal/v1/runtime", "device-info"),
        ("/internal/v1/runtime/token/rotate", "device-rotate"),
        ("/internal/v1/runtime/logout", "device-logout"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runtimes", "runtimes"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runtimes/([0-9a-fA-F-]{36})", "runtime"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/runtimes/([0-9a-fA-F-]{36})/grants",
            "runtime-grants",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/runtimes/([0-9a-fA-F-]{36})/trust",
            "runtime-trust",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/runtimes/([0-9a-fA-F-]{36})/revoke",
            "runtime-revoke",
        ),
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
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/resources/([0-9a-fA-F-]{36})/versions/([0-9a-fA-F-]{36})/compiled-source",
            "compiled-source",
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
        """结构化访问日志：仅记录请求 ID、方法、状态与耗时，不含路径参数与载荷。"""
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
        bundle_export_slots=asyncio.Semaphore(2),
        attempt_proof_verifier=DatabaseAttemptProofVerifier(settings),
    )
