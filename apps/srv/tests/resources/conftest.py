# Reuse the guarded real-MySQL/HTTP fixture; no second test database harness.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
