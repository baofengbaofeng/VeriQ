"""为真实接口测试提供独占的回环服务、已迁移的专用数据库及响应契约校验，并在用例结束后释放连接。"""

import json
import os
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets

from veriq_server.app import make_app
from veriq_server.db import Database
from veriq_server.handlers.base import MAX_HTTP_BODY_BYTES
from veriq_server.migrate import migrate
from veriq_server.service import provision_setup_secret
from veriq_server.settings import Settings
from veriq_server.validation import api_document, validate_api


async def _clear_test_tables(db: Database) -> None:
    """在删除第一张表之前先比对实际表名和许可名单，遇到未知表时使整个清理流程直接失败。"""
    assert db.engine.url.database == "veriq_test"
    async with db.engine.begin() as conn:
        tables = (await conn.execute(text("SHOW TABLES"))).scalars().all()
        owned = {
            "veriq_execution_plans",
            "veriq_offline_imports",
            "veriq_offline_import_keys",
            "veriq_offline_attempts",
            "veriq_offline_import_uploads",
            "veriq_bundles",
            "veriq_bundle_exports",
            "veriq_ai_providers",
            "veriq_ai_generations",
            "veriq_agent_settings",
            "veriq_agent_sessions",
            "veriq_agent_form_receipts",
            "veriq_agent_turns",
            "veriq_agent_tasks",
            "veriq_notification_events",
            "veriq_notifications",
            "veriq_notification_inbox_states",
            "veriq_runs",
            "veriq_case_executions",
            "veriq_attempts",
            "veriq_capacity_pools",
            "veriq_resource_leases",
            "veriq_claim_receipts",
            "veriq_attempt_events",
            "veriq_attempt_uploads",
            "veriq_maintenance_receipts",
            "veriq_service_accounts",
            "veriq_service_tokens",
            "veriq_runtimes",
            "veriq_runtime_bindings",
            "veriq_runtime_grants",
            "veriq_runtime_enrollments",
            "veriq_runtime_tokens",
            "veriq_installation",
            "veriq_users",
            "veriq_user_sessions",
            "veriq_user_tokens",
            "veriq_audit_logs",
            "veriq_alembic_version",
            "veriq_workspaces",
            "veriq_workspace_members",
            "veriq_workspace_invites",
            "veriq_resources",
            "veriq_resource_drafts",
            "veriq_resource_versions",
            "veriq_resource_dependencies",
            "veriq_artifacts",
            "veriq_artifact_deletions",
            "veriq_artifact_publications",
            "veriq_jobs",
            "veriq_validation_receipts",
            "veriq_secret_refs",
            "veriq_auth_adapter_versions",
            "veriq_secret_versions",
        }
        assert set(tables) <= owned
        await conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for table in tables:
            await conn.execute(text(f"DROP TABLE `{table}`"))
        await conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))


async def _validate_response(response: httpx.Response) -> None:
    """读取完整响应并查找匹配的路径、方法和状态码，对声明了公开结构的响应校验其实际返回内容。"""
    await response.aread()
    document = api_document()
    for path, operations in document["paths"].items():
        pattern = re.sub(r"\{[^}]+\}", "[^/]+", path)
        if re.fullmatch(pattern, response.request.url.path):
            operation = operations.get(response.request.method.lower())
            if operation:
                descriptor = operation["responses"].get(str(response.status_code))
                if descriptor and "application/json" in descriptor.get("content", {}):
                    schema = descriptor["content"]["application/json"]["schema"]
                    name = schema["$ref"].rsplit("/", 1)[-1]
                    validate_api(name, response.json())
            break


def _response_hooks(
    request: pytest.FixtureRequest, validate: Callable[[httpx.Response], Awaitable[None]]
) -> list[Callable[[httpx.Response], Awaitable[None]]]:
    """在站点启动时接纳用例提供的可选守卫，并将同一契约校验器交给守卫以处理包含实例的失败诊断。"""
    if "veriq_response_guard" not in request.fixturenames:
        return [validate]
    guard = request.getfixturevalue("veriq_response_guard")

    async def guarded_response(response: httpx.Response) -> None:
        """在首次匿名安装请求及之后的响应中沿用同一个守卫，依次扫描响应并调用原有公开契约检查。"""
        await guard(response, validate)

    return [guarded_response]


@pytest.fixture
async def site(request, monkeypatch):
    """重建表前核对测试数据库名称及现有表名单，再运行真实迁移并启动带契约校验的回环站点供当前用例独占。"""
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text(encoding="utf-8"))
    model_port = int(os.environ.get("VERIQ_TEST_MODEL_PORT", "18890"))
    assert make_url(env["mysql_dsn"]).database == "veriq_test"
    storage = {}
    moto = None
    if getattr(request, "param", "FILE") == "S3":
        import boto3
        from moto.server import ThreadedMotoServer

        for key, value in {
            "AWS_ACCESS_KEY_ID": "synthetic-test",
            "AWS_SECRET_ACCESS_KEY": "synthetic-test",
            "AWS_EC2_METADATA_DISABLED": "true",
        }.items():
            monkeypatch.setenv(key, value)
        moto = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
        moto.start()
        host, port = moto.get_host_and_port()
        endpoint = f"http://{host}:{port}"
        boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1").create_bucket(
            Bucket="veriq-review"
        )
        storage = {
            "artifact_backend": "S3",
            "artifact_s3_endpoint": endpoint,
            "artifact_s3_bucket": "veriq-review",
        }
    settings = Settings(
        **storage,
        database_url=env["mysql_dsn"],
        public_url="http://127.0.0.1:18889",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        ai_allowed_base_urls=[
            f"http://127.0.0.1:{model_port}/v1",
            "https://api.openai.com/v1",
            "https://api.anthropic.com/v1",
        ],
        approved_engine_inventory_path=env.get("approved_engine_inventory_path"),
    )
    if "dataset_deployment" in request.fixturenames:
        settings.dataset_connections = request.getfixturevalue("dataset_deployment")
    db = Database(settings)
    await _clear_test_tables(db)
    await migrate(settings)
    await provision_setup_secret(db, "operator-secret")
    sockets = bind_sockets(18889, "127.0.0.1")
    application = make_app(settings, db)
    server = HTTPServer(application, max_body_size=MAX_HTTP_BODY_BYTES)
    server.add_sockets(sockets)

    async with httpx.AsyncClient(
        base_url=settings.public_url,
        headers={"Origin": settings.public_url},
        event_hooks={"response": _response_hooks(request, _validate_response)},
    ) as c:
        state = await c.get("/api/v1/setup")
        c.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        yield c, db
    server.stop()
    await server.close_all_connections()
    await application.settings["notification_watcher"].close()
    await db.close()
    if moto:
        moto.stop()
