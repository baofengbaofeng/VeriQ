"""为模型协议测试复用认证套件中带数据库清理守卫的站点夹具，并注册准备工作区及执行计划所需的测试辅助模块。"""

import runpy
import sys
from pathlib import Path

root = Path(__file__).parents[1]
for directory in ["auth", "resources", "execution"]:
    sys.path.insert(0, str(root / directory))
site = runpy.run_path(str(root / "auth" / "conftest.py"))["site"]
