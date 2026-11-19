# 资源测试加载认证套件的真实 HTTP 站点夹具，复用其重建专用 MySQL 库中表之前的归属检查。
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
