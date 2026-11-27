"""生产应用每个登记的 API 方法都必须有可生成的契约，离线写入只在历史夹具上注册。"""

import re

from tornado.web import RequestHandler
from veriq_server.app import UnknownAPI, make_app
from veriq_server.db import Database
from veriq_server.handlers.credential import CredentialResolveAPI
from veriq_server.handlers.enrollment import DeviceAPI
from veriq_server.settings import Settings
from veriq_server.validation import api_document


def expected_security(handler, action, method):
    """按登记的入口与身份协议核对文档，读请求无 CSRF，外部令牌仅适用于获准的计划操作。"""
    if action in {
        "public-live",
        "public-ready",
        "live",
        "health",
        "build-info",
        "enrollment-request",
        "enrollment-poll",
    } or (action, method) == ("setup", "GET"):
        return []
    if action in {
        "service-enroll",
        "expired-leases/reap",
        "fixture-cleanups/reconcile",
        "capacity/reconcile",
        "artifacts/expire",
        "lifecycle/expire",
    }:
        return [{"ServiceToken": []}]
    if issubclass(handler, (DeviceAPI, CredentialResolveAPI)):
        return [{"DeviceToken": []}]
    if action in {"setup", "login", "reset-request", "reset-confirm", "accept-invitation"}:
        return [{"CsrfToken": []}]
    session = {"WebSession": []}
    if method != "GET":
        session["CsrfToken"] = []
    options = [session]
    if action in {"plan-trigger", "ci-report", "ci-junit", "run", "run-cancel"}:
        options.append({"ServiceToken": []})
    return options


async def test_openapi_matches_registered_production_methods_and_authentication():
    """用可满足各路由约束的路径实例匹配真实 Tornado 注册表，双向核对所有操作并检查实际处理器提供对应动词。"""
    config = Settings(
        database_url="mysql+asyncmy://test:test@127.0.0.1/veriq_test",
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
    )
    db = Database(config)
    app = make_app(config, db)
    try:
        routes = [rule for rule in app.wildcard_router.rules if rule.target is not UnknownAPI]
        matched = set()
        for path, operations in api_document()["paths"].items():
            sample = re.sub(
                r"\{\w+\}",
                "00000000-0000-4000-8000-000000000001",
                path.replace("{sha256}", "a" * 64).replace("{secretRef}", "sample"),
            )
            rules = [rule for rule in routes if rule.matcher.regex.fullmatch(sample)]
            assert len(rules) == 1, path
            rule = rules[0]
            assert rule not in matched, path
            matched.add(rule)
            assert {method.upper() for method in operations} == set(
                rule.target_kwargs["methods"]
            ), path
            for name, operation in operations.items():
                assert getattr(rule.target, name) is not getattr(RequestHandler, name), (path, name)
                action = rule.target_kwargs["action"]
                assert operation["security"] == expected_security(
                    rule.target, action, name.upper()
                ), (path, name)
        assert matched == set(routes)
    finally:
        await app.settings["notification_watcher"].close()
        await db.close()
