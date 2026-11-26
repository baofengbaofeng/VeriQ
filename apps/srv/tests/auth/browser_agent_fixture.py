"""为正在运行的浏览器服务准备已发布测试资源，仅复用 MySQL 测试的编译回执夹具与真实发布接口。

该脚本不挂载 HTTP 路由。目标库和控制源固定到现有可销毁测试环境。只有已发布资源和排队设备充当预置条件，
计划创建、Agent 操作和运行状态均留待浏览器经过生产接口观察。
"""

import asyncio
import json
import sys
from pathlib import Path
from uuid import UUID

import httpx
from sqlalchemy.engine import make_url

from veriq_server.db import Database
from veriq_server.settings import Settings


async def seed(workspace_id: str):
    """单独登录测试工作区并生成准备所需的资产，输出严格限定为测试用例可以公开引用的标识，不包括令牌。"""
    # 复用 pytest 中按测试目录导入的准备函数，入口自身不启动第二组数据库迁移或创建另一套服务端。
    tests = Path(__file__).resolve().parents[1]
    for name in ("execution", "resources"):
        sys.path.insert(0, str(tests / name))
    from test_trigger import plan_assets

    origin = "http://127.0.0.1:5173"
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    assert make_url(env["mysql_dsn"]).database == "veriq_test"
    db = Database(
        Settings(
            database_url=env["mysql_dsn"],
            public_url=origin,
            master_key="a" * 64,
            signing_key="b" * 64,
            environment="development",
        )
    )
    try:
        async with httpx.AsyncClient(base_url=origin, headers={"Origin": origin}) as client:
            bootstrap = await client.get("/api/v1/setup")
            assert bootstrap.status_code == 200, bootstrap.text
            client.headers["X-CSRF-Token"] = bootstrap.json()["data"]["csrfToken"]
            authenticated = await client.post(
                "/api/v1/auth/login",
                json={
                    "email": "browser-admin@example.com",
                    "password": "Browser password 123!",
                },
            )
            assert authenticated.status_code == 200, authenticated.text
            client.headers["X-CSRF-Token"] = authenticated.json()["data"]["csrfToken"]
            runtime, environment, suite = await plan_assets(client, db, workspace_id)
            print(
                json.dumps(
                    {
                        "runtimeId": runtime["runnerId"],
                        "environmentVersionId": environment,
                        "suiteVersionId": suite,
                    }
                )
            )
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(seed(str(UUID(sys.argv[1]))))
