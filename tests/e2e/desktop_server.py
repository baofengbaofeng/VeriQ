"""桌面验收服务持有全仓专用测试库锁，使用隔离签发者显式晋升真实生产器候选，并允许测试停止控制平面后保持业务站点在线；不插入伪造回执、资源版本或离线报告来替代实际 Agent 执行。"""

import asyncio
import json
import signal
import sys
from tornado.web import Application, RequestHandler
from veriq_server.promote_engine import promote_engine
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
    """建立专用测试平台及独立业务站点，初次运行仅重建允许清单中的 veriq_test 表；恢复模式保留原安装、签发者和回执，由外层驱动持有全仓数据库锁，真实候选仍通过正式晋升函数检查。"""
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    assert make_url(env["mysql_dsn"]).database == "veriq_test"
    evidence = Path(sys.argv[1])
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    from veriq_server.bundles.issuer import Issuer

    issuer_path = evidence / "issuer.json"
    issuer = (
        Issuer(issuer_path) if issuer_path.exists() else Issuer.initialize(issuer_path)
    )
    (evidence / "issuer-public.json").write_text(json.dumps(issuer.public()))
    inventory = evidence / "approved-inventory.json"
    resume = "--resume" in sys.argv
    if not resume:
        inventory.write_text(json.dumps({"schemaVersion": "1.0", "engines": []}))
    settings = Settings(
        database_url=env["mysql_dsn"],
        public_url="http://127.0.0.1:8888",
        master_key="a" * 64,
        signing_key="b" * 64,
        environment="development",
        ai_allowed_base_urls=[
            "http://127.0.0.1:18890/v1",
            "https://api.openai.com/v1",
            "https://api.anthropic.com/v1",
        ],
        bundle_issuer_path=str(issuer_path),
        approved_engine_inventory_path=str(inventory),
        validation_engine_version="1.0.0",
    )
    identity = await promote_engine(settings, Path("work/t18-engine-verified"))
    assert (
        identity == "4ac7053892d4dbeb957fbda59d9b70dd13a1b5b4ea3ea7acce310b9bfc431bcd"
    )
    print("Production candidate promoted", identity, flush=True)
    db = Database(settings)
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
        "veriq_artifact_deletions",
        "veriq_artifact_publications",
        "veriq_jobs",
        "veriq_validation_receipts",
    }
    if not resume:
        async with db.engine.begin() as conn:
            tables = set((await conn.execute(text("SHOW TABLES"))).scalars().all())
            assert tables <= owned
            await conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
            for table in sorted(tables):
                await conn.execute(text(f"DROP TABLE `{table}`"))
            await conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
        await migrate(settings)
        await provision_setup_secret(db, "browser-operator-secret")
    app = make_app(settings, db)
    server = HTTPServer(app, max_body_size=3 * 1024 * 1024)
    server.listen(8888, "127.0.0.1")
    business_release = asyncio.Event()
    business_release.set()
    business_waiting = 0

    class Business(RequestHandler):
        """业务夹具只提供真实浏览器可访问的本机页面和受固定合成凭证保护的身份端点，测试可显式暂停页面响应以观察活动 Run；该控制不改变平台状态，也不直接写入用例结果或停止回执。"""

        async def post(self):
            """暂停和释放只作用于业务页面的 asyncio Event，允许验收准确观察 Run 跨窗口退出期间仍在等待；未知控制路径返回错误，事件恢复后页面继续由真实浏览器访问并执行断言。"""
            if self.request.path == "/__hold":
                business_release.clear()
            elif self.request.path == "/__release":
                business_release.set()
            else:
                self.set_status(404)
            self.finish({"held": not business_release.is_set()})

        async def get(self):
            """身份端点严格检查合成 Bearer 凭证，其余页面在释放事件后返回可见业务内容；等待计数在 finally 中回收，用于判断浏览器实际到达请求边界，而不是以任意睡眠猜测执行进度。"""
            nonlocal business_waiting
            if self.request.path == "/__state":
                self.finish({"waiting": business_waiting})
                return
            if self.request.path == "/me":
                if (
                    self.request.headers.get("Authorization")
                    != "Bearer synthetic-desktop-secret"
                ):
                    self.set_status(401)
                    self.finish({"error": "unauthorized"})
                    return
                self.finish({"id": "reader"})
            else:
                business_waiting += 1
                try:
                    await business_release.wait()
                finally:
                    business_waiting -= 1
                self.set_header("Content-Type", "text/html")
                self.finish(
                    '<html><h1 data-testid="ready">Desktop business ready</h1></html>'
                )

    business = HTTPServer(Application([(r"/.*", Business)]))
    business.listen(18891, "127.0.0.1")
    ended = asyncio.Event()
    loop = asyncio.get_running_loop()

    async def offline():
        """断网阶段只停止控制平台监听并关闭它已建立的连接，独立业务站点继续保持可达；这样离线执行需要真实签名缓存和业务访问，不能因所有网络都关闭而把环境错误当作业务结果。"""
        server.stop()
        await server.close_all_connections()
        print("Control platform stopped", flush=True)

    def online():
        """恢复阶段重新监听相同控制 Origin 并复用原应用与数据库连接，保留设备身份、导入回执和安装加密材料；这个操作不重新初始化数据库，因此回传幂等验证仍针对同一次原始执行。"""
        server.listen(8888, "127.0.0.1")
        print("Control platform restored", flush=True)

    loop.add_signal_handler(signal.SIGUSR1, lambda: asyncio.create_task(offline()))
    loop.add_signal_handler(signal.SIGUSR2, online)
    loop.add_signal_handler(signal.SIGTERM, ended.set)
    print("Desktop acceptance services ready", flush=True)
    try:
        await ended.wait()
    finally:
        server.stop()
        business.stop()
        await server.close_all_connections()
        await business.close_all_connections()
        await db.close()


asyncio.run(main())
