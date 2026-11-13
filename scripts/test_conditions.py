"""完整发行测试的先决条件检查读取私有测试配置但不回显内容，确认隔离 MySQL 和匹配 Playwright 浏览器真实可用；缺失条件直接失败，不能把依赖条件不足转换为跳过成功。

数据库只执行只读版本和当前数据库查询。
浏览器独立启动后关闭，不与正式 SDK 门禁并发运行。
验证不读取真实模型 Provider 凭证。
"""

import asyncio
import json
from pathlib import Path
import subprocess

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine


async def database() -> None:
    """私有配置必须指向专用 veriq_test 数据库并成功建立真实连接，服务版本必须为 MySQL8.4；失败对外只给固定英文诊断，避免驱动异常将连接串或口令带入构建日志。

    此步骤不迁移、不清空表，因此不会改变已有测试证据。
    后续会修改数据库的测试另持统一 flock。
    """
    config = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_bytes())
    url = make_url(config["mysql_dsn"])
    if url.database != "veriq_test":
        raise ValueError("Dedicated veriq_test database is required")
    engine = create_async_engine(url)
    try:
        async with engine.connect() as connection:
            version = str((await connection.execute(text("SELECT VERSION()"))).scalar())
            if not version.startswith("8.4."):
                raise ValueError("MySQL 8.4 is required")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(database())
    except Exception:
        raise SystemExit("Release test database is unavailable or unsafe") from None
    script = """const fs=require('node:fs'); const path=require('node:path'); const {chromium}=require('@playwright/test');
    const metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('playwright-core/package.json')),'browsers.json')));
    (async()=>{const browser=await chromium.launch({...(process.env.VERIQ_TEST_CHROMIUM?{executablePath:process.env.VERIQ_TEST_CHROMIUM}:{}),args:['--no-sandbox']});try{if(browser.version()!==metadata.browsers.find(x=>x.name==='chromium').browserVersion)throw new Error('Pinned test browser version mismatch');}finally{await browser.close();}})().catch(()=>process.exit(1));"""
    subprocess.run(["node", "-e", script], cwd="packages/runner-sdk", check=True)
    print("Release test conditions verified")
