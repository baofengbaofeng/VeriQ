"""容器独立验收等待真实已启动的控制镜像响应并检查深链接和缺失资源边界，超时或任何错误状态都会让 CI 失败；此程序不启动替代服务，也不把宿主 Python 测试当作镜像验收。

重试仅用于有界启动就绪检查，不重跑失败的功能断言。
探测使用合成无数据库配置，因此不声称完成数据库迁移验收。
"""

import time
import urllib.error
import urllib.request

deadline = time.monotonic() + 30
while True:
    try:
        with urllib.request.urlopen("http://127.0.0.1:18888/health/live", timeout=2) as response:
            assert response.status == 200
        break
    except (OSError, urllib.error.URLError):
        if time.monotonic() >= deadline:
            raise SystemExit("Container did not become live") from None
        time.sleep(0.2)
for path, status in [("/reports", 200), ("/api/v1/missing", 404), ("/assets/missing.js", 404)]:
    try:
        result = urllib.request.urlopen("http://127.0.0.1:18888" + path, timeout=3)
    except urllib.error.HTTPError as error:
        result = error
    with result:
        assert result.status == status
print("Pinned control container HTTP checks passed")
