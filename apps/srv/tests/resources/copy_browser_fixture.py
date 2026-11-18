"""给浏览器复制用例准备一个历史发布回执，只在专用测试数据库中复用发布测试已有的作业完成夹具。"""

import asyncio
import json
import sys
from pathlib import Path
from uuid import UUID

from sqlalchemy.engine import make_url

from veriq_server.db import Database
from veriq_server.settings import Settings

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "auth"))
from test_publish import completed


async def main(job_id: str) -> None:
    """浏览器已通过正式接口提交来源校验，测试仅补齐历史回执，发布和后续复制均经真实服务端授权。"""
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    dsn = config["mysql_dsn"]
    if make_url(dsn).database != "veriq_test":
        raise RuntimeError("A dedicated test database is required")
    db = Database(
        Settings(
            database_url=dsn,
            public_url="http://127.0.0.1:5173",
            master_key="a" * 64,
            signing_key="b" * 64,
            environment="development",
        )
    )
    try:
        await completed(db, str(UUID(job_id)))
    finally:
        await db.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
