import json
import re
from veriq_server.validation import api_document, validate_api
from pathlib import Path
import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from veriq_server.app import make_app
from veriq_server.db import Database
from veriq_server.settings import Settings
from veriq_server.service import provision_setup_secret
from veriq_server.migrate import migrate


@pytest.fixture
async def site(request, monkeypatch):
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    assert make_url(env["mysql_dsn"]).database == "veriq_test"
    # The operator provisioned this database exclusively for isolated task tests.
    storage = {}
    moto = None
    if getattr(request, "param", "FILE") == "S3":
        from moto.server import ThreadedMotoServer
        import boto3

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
        approved_engine_inventory_path=env.get("approved_engine_inventory_path"),
    )
    db = Database(settings)
    async with db.engine.begin() as conn:
        tables = (await conn.execute(text("SHOW TABLES"))).scalars().all()
        owned = {
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
    await migrate(settings)
    await provision_setup_secret(db, "operator-secret")
    sockets = bind_sockets(18889, "127.0.0.1")
    server = HTTPServer(make_app(settings, db), max_body_size=3 * 1024 * 1024)
    server.add_sockets(sockets)

    async def validate_response(response):
        await response.aread()
        document = api_document()
        for path, operations in document["paths"].items():
            pattern = re.sub(r"\{[^}]+\}", "[^/]+", path)
            if re.fullmatch(pattern, response.request.url.path):
                operation = operations.get(response.request.method.lower())
                if operation:
                    descriptor = operation["responses"].get(str(response.status_code))
                    if descriptor and "application/json" in descriptor.get("content", {}):
                        name = descriptor["content"]["application/json"]["schema"]["$ref"].split(
                            "/"
                        )[-1]
                        validate_api(name, response.json())
                break

    async with httpx.AsyncClient(
        base_url=settings.public_url,
        headers={"Origin": settings.public_url},
        event_hooks={"response": [validate_response]},
    ) as c:
        state = await c.get("/api/v1/setup")
        c.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        yield c, db
    server.stop()
    await server.close_all_connections()
    await db.close()
    if moto:
        moto.stop()
