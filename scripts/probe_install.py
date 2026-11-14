"""此独立探测程序通过干净虚拟环境的隔离解释器执行，启动安装后的真实生产 CLI 并核对 HTTP 路由；代码不导入仓库模块，能够发现开发 checkout 隐式补齐资源的包装缺陷。

进程环境没有 Node、pnpm 或 Chrome 的可执行搜索路径。
包文件改成只读，制品与状态目录使用独立临时数据根。
探测成功只代表当前操作系统上的安装与启动，不冒充其他 ABI 验证。
"""

import importlib.metadata
from importlib.resources import files
import json
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

assert all(shutil.which(name) is None for name in ("node", "pnpm", "chromium", "google-chrome"))
package = Path(str(files("veriq_server")))
assert "site-packages" in str(package)
for path in package.rglob("*"):
    path.chmod(0o555 if path.is_dir() else 0o444)
package.chmod(0o555)
data = Path.cwd() / "data"
data.mkdir()
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
config = Path.cwd() / "veriq.json"
config.write_text(
    json.dumps(
        {
            "database_url": "mysql+asyncmy://unused:unused@127.0.0.1:1/veriq_unused",
            "public_url": "https://veriq.example.com",
            "master_key": "a" * 64,
            "signing_key": "b" * 64,
            "host": "127.0.0.1",
            "port": port,
            "environment": "production",
            "artifact_directory": str(data),
        }
    )
)
config.chmod(0o600)
log = Path.cwd() / "server.log"
with log.open("w") as stream:
    process = subprocess.Popen(
        [
            sys.executable,
            "-I",
            "-B",
            "-m",
            "veriq_server",
            "--config",
            str(config),
            "serve",
        ],
        stdout=stream,
        stderr=stream,
        env={"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                raise RuntimeError("Installed production server exited before readiness")
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/health/live", timeout=1
                ) as response:
                    assert response.status == 200
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("Installed production server did not start") from None
                time.sleep(0.05)
        for route, expected in [
            ("/reports", 200),
            ("/api/v1/build-info", 200),
            ("/api/v1/missing", 404),
            ("/assets/missing.js", 404),
            ("/.vite/manifest.json", 404),
        ]:
            try:
                response = urllib.request.urlopen(f"http://127.0.0.1:{port}{route}", timeout=2)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                assert response.status == expected, (route, response.status)
                if expected == 404:
                    assert response.headers["Content-Type"].startswith("application/json")
        print(
            json.dumps(
                {
                    "productionStartsWithoutNodeOrChrome": True,
                    "readOnlyPackage": True,
                    "outsideCheckout": True,
                    "version": importlib.metadata.version("veriq-server"),
                    "os": platform.freedesktop_os_release(),
                    "python": platform.python_version(),
                    "architecture": platform.machine(),
                }
            )
        )
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        for path in package.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        package.chmod(0o755)
