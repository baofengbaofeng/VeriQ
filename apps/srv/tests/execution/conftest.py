# 执行测试复用认证站点夹具，任务领取和租约用例共享受表清理检查保护的专用 MySQL 库及 HTTP 初始化。
import sys
import shutil
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
sys.path.insert(0, str(Path(__file__).parents[1] / "resources"))


@pytest.fixture(autouse=True)
def clean_task_archives(tmp_path):
    yield
    shutil.rmtree(tmp_path)
