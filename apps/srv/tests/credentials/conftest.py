# 凭据测试借用认证站点夹具，管理与解析用例沿用同一专用测试库的库名检查、表清理和 HTTP 入口。
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
