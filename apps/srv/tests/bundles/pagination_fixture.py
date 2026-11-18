"""为浏览器分页用例把真实 Agent 发布版本移至第 31 号，并填充前 30 条列表记录以验证历史选择。

脚本按参数接收版本 ID，保留原发布的 ID、源码、回执和 TypeScript 制品，只调整显示版本号。
浏览器随后真实发布更新的修订，使第 31 号版本成为可在分页列表中选择的历史版本。
"""

import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid4
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.engine import make_url
from veriq_server.db import ResourceVersion


async def main() -> None:
    dsn = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())["mysql_dsn"]
    assert make_url(dsn).database == "veriq_test"
    engine = create_async_engine(dsn)
    try:
        async with async_sessionmaker(engine).begin() as session:
            for version_id in sys.argv[1:]:
                row = await session.get(ResourceVersion, version_id)
                assert row is not None and row.version_no == 1
                values = {
                    column.name: getattr(row, column.name)
                    for column in ResourceVersion.__table__.columns
                }
                row.version_no = 31
                await session.flush()
                for index in range(1, 31):
                    session.add(
                        ResourceVersion(
                            **{
                                **values,
                                "id": str(uuid4()),
                                "version_no": index,
                                "draft_revision": 1000 + index,
                            }
                        )
                    )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
