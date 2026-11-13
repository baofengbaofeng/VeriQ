"""Tornado 唯一应用工厂统一装配健康、构建信息、现有 API 与包内前端资源，并保留密码重置调度、身份注册表、导出并发槽和尝试证明校验器等既有运行依赖。

production 先验证静态包库存与身份，缺失时不能绑定可服务的应用。
development 不读取 dist，前端仍由独立 Vite 代理访问后端。
未知 API 和内部路径先返回结构化错误，不能落入前端入口。
公开文件与精确登记 SPA 路由之后才使用最终 JSON 404。
控制面运行时仍不需要 Node 或 Chrome，执行能力继续由独立 Runtime 承担。
"""

import asyncio
import json
import logging
import re
from tornado.web import Application, RequestHandler
from .db import Database
from .delivery import Delivery, ResetDispatcher, SMTPDelivery
from .settings import Settings
from .handlers.base import API
from .handlers.static import BuildInfoAPI, PublishedFileHandler, SPA_PATHS, load_published_site
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
from .handlers.trigger import ExecutionPlanAPI, TriggerAPI, CIReportAPI
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
    """兜底处理器：对未登记路径的任意 HTTP 动词统一抛出 NOT_FOUND，避免静默 200 或方法泄露，UnknownAPI 的失败路径返回稳定错误。
    UnknownAPI 实现于 apps/srv/src/veriq_server/app.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    async def get(self, *args: str) -> None:
        """拒绝未知路径上的 GET（以及其他动词别名），返回 404 问题对象给客户端，UnknownAPI.get 的失败路径返回稳定错误。
        get 实现于 apps/srv/src/veriq_server/app.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        raise Problem(404, "NOT_FOUND", "API endpoint not found")

    head = get
    post = get
    patch = get
    delete = get
    put = get


def handler_for(action: str) -> type[API]:
    """按路由动作名选择具体 API 处理器类；当动作未匹配时回退到 UnknownAPI，handler_for 的失败路径返回稳定错误。
    handler_for 实现于 apps/srv/src/veriq_server/app.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    if action in {"execution-plans", "execution-plan"}:
        return ExecutionPlanAPI
    if action == "plan-trigger":
        return TriggerAPI
    if action in {"ci-report", "ci-junit"}:
        return CIReportAPI
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
    """构建唯一 Tornado Application 并在接受请求前校验正式静态发布输入，按既有动作表注入全部 API 依赖；新增文件与页面路由不创建第二工厂，也不替换原有身份、投递或调度控制插槽。

    静态预检先于路由与应用创建，生产缺包必须立即失败。
    delivery 的显式注入优先级仍高于 SMTP 配置默认值。
    既有 action 与 handler_for 映射保留，避免接口在装配中丢失。
    健康与构建信息匿名端点位于普通业务路由之前。
    未知 api/internal 路径在静态处理之前封闭。
    公开文件路径来自已验证的库存集合，不来自磁盘扫描扩权。
    SPA 路径精确登记，不能通过客户端星号路由无限 fallback。
    应用仍启用原有 CSRF Cookie 和正式 Secure+Strict 属性。
    日志只记录既有请求关联与耗时，不增加配置或路径载荷。
    export Semaphore、ResetDispatcher 与证明校验器继续使用原有实例职责。
    """
    published_site = load_published_site(settings)
    delivery = delivery or (SMTPDelivery(settings) if settings.smtp_host else None)
    reset_dispatcher = ResetDispatcher(db, settings, delivery)
    routes = [
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/execution-plans", "execution-plans"),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/execution-plans/([0-9a-fA-F-]{36})",
            "execution-plan",
        ),
        (
            "/api/v1/workspaces/([0-9a-fA-F-]{36})/execution-plans/([0-9a-fA-F-]{36})/trigger",
            "plan-trigger",
        ),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})/ci-report", "ci-report"),
        ("/api/v1/workspaces/([0-9a-fA-F-]{36})/runs/([0-9a-fA-F-]{36})/junit", "ci-junit"),
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
    ]

    def request_log(handler: RequestHandler) -> None:
        """结构化访问日志：仅记录请求 ID、方法、状态与耗时，不含路径参数与载荷；该符号的输入校验、错误返回与调用方契约以本文件实现为准。
        request_log 实现于 apps/srv/src/veriq_server/app.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
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

    handlers = [
        ("/health/live", HealthAPI, {"config": settings, "db": db, "action": "public-live"}),
        ("/health/ready", HealthAPI, {"config": settings, "db": db, "action": "public-ready"}),
        ("/api/v1/build-info", BuildInfoAPI, {"config": settings, "db": db}),
    ] + [
        (path, handler_for(action), {"config": settings, "db": db, "action": action})
        for path, action in routes
    ]
    # API 与内部命名空间先封闭未知路径，再登记清单文件和精确 SPA 路由，最终结构化兜底保持所有旧错误语义；生产入口绝不接管未经登记的页面或证据下载。
    # 静态描述只在生产模式存在，因此开发 API 启动不读取 dist，也不依赖 Node 或浏览器。
    # 原有投递调度、导出并发和身份校验插槽继续由下方唯一 Application 实例保存。
    handlers.append((r"/(?:api|internal)(?:/.*)?", UnknownAPI, {"config": settings, "db": db}))
    if published_site is not None:
        static_options = {"config": settings, "db": db, "site": published_site}
        public_paths = "|".join(re.escape(path) for path in sorted(published_site.public_files))
        handlers.append((r"/(" + public_paths + r")", PublishedFileHandler, static_options))
        handlers.extend(
            (re.escape(path), PublishedFileHandler, {**static_options, "spa": True})
            for path in SPA_PATHS
        )
    handlers.append((r"/.*", UnknownAPI, {"config": settings, "db": db}))
    return Application(
        handlers,
        published_site=published_site,
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
