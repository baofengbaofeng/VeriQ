# 设备注册和授权用例复用认证套件的站点夹具，在同一个专用 MySQL 测试库中沿用表归属检查和清理流程。
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
