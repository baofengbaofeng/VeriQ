"""Local browser fixture against the operator-provided, dedicated test database."""

import asyncio
import json
import os
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import make_url
from tornado.httpserver import HTTPServer

from veriq_server.app import make_app
from veriq_server.db import Database
from veriq_server.migrate import migrate
from veriq_server.service import provision_setup_secret
from veriq_server.settings import Settings


async def main():
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    assert make_url(env["mysql_dsn"]).database == "veriq_test"
    settings = Settings(
        database_url=env["mysql_dsn"],
        public_url="http://127.0.0.1:5173",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        approved_engine_inventory_path=os.environ.get("VERIQ_TEST_ENGINE_INVENTORY"),
    )
    db = Database(settings)
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
        "veriq_secret_refs",
        "veriq_secret_versions",
        "veriq_auth_adapter_versions",
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
        "veriq_jobs",
        "veriq_validation_receipts",
    }
    async with db.engine.begin() as conn:
        tables = set((await conn.execute(text("SHOW TABLES"))).scalars().all())
        assert tables <= owned
        await conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for table in sorted(tables):
            await conn.execute(text(f"DROP TABLE `{table}`"))
        await conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
    await migrate(settings)
    await provision_setup_secret(db, "browser-operator-secret")
    server = HTTPServer(make_app(settings, db), max_body_size=3 * 1024 * 1024)
    server.listen(8888, "127.0.0.1")
    try:
        await asyncio.Event().wait()
    finally:
        server.stop()
        await server.close_all_connections()
        await db.close()


asyncio.run(main())
