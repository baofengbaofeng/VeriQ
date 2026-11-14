"""发行验收在隔离的源码副本中调用真实 Hatchling 构建后端，明确区分无需前端的开发安装与必须携带完整管理台的正式 wheel，避免仓库中的旧暂存资源掩盖缺失输入。

构建副本不携带 Git 元数据，覆盖源码归档安装的路径解析。
现有合同资源仍从相同的工作区相对目录提供。
测试只读取当前解释器中已锁定的构建工具，不访问包索引。
"""

from pathlib import Path
import shutil
import subprocess
import sys
import os
import json
import zipfile

import pytest


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def checkout(tmp_path: Path) -> Path:
    """复制服务源码和合同输入到没有 Git 信息的临时目录，刻意排除现有静态产物与虚拟环境，使每个构建断言只依赖该测试明确准备的文件而非开发机器缓存。

    源码使用普通复制，不修改与人工维护工作区共享的依赖 inode。
    构建依赖由执行 pytest 的已锁定 Python 环境提供。
    正式产物写入本次测试目录，避免污染正常发行输出。
    """
    target = tmp_path / "checkout"
    shutil.copytree(ROOT / "apps/srv/src", target / "apps/srv/src")
    shutil.rmtree(target / "apps/srv/src/veriq_server/static", ignore_errors=True)
    shutil.copytree(ROOT / "packages/contracts/schemas", target / "packages/contracts/schemas")
    shutil.copytree(ROOT / "packages/contracts/openapi", target / "packages/contracts/openapi")
    for filename in ("pyproject.toml", "hatch_build.py", "release_support.py"):
        source = ROOT / "apps/srv" / filename
        if source.exists():
            shutil.copy2(source, target / "apps/srv" / filename)
    shutil.copy2(ROOT / "LICENSE", target / "LICENSE")
    shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", target / "THIRD_PARTY_NOTICES.md")
    (target / "deploy").mkdir()
    shutil.copy2(ROOT / "deploy/server.example.json", target / "deploy/server.example.json")
    metadata = target / "apps/srv/src/veriq_server/release"
    metadata.mkdir(exist_ok=True)
    (metadata / "engine-inventory.json").write_text('{"schemaVersion":"1.0","engines":[]}')
    return target


def test_standard_wheel_refuses_missing_frontend(checkout: Path) -> None:
    """正式 wheel 必须在缺少管理台时明确失败，而不能生成仅含 Python 的可安装空壳；此断言检查真实构建退出码及可操作诊断，并确认失败没有留下可误发的 wheel。

    当前解释器来自 apps/srv 的冻结开发环境。
    不使用隔离环境下载来掩盖缺失的构建依赖。
    英文错误必须指出前端输入，便于流水线定位失败阶段。
    """
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "apps/srv",
            "--outdir",
            "wheels",
        ],
        cwd=checkout,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, "Standard wheel incorrectly accepted missing frontend"
    assert "frontend" in (result.stdout + result.stderr).lower()
    assert not list((checkout / "wheels").glob("*.whl"))


def test_editable_install_does_not_require_frontend(checkout: Path) -> None:
    """干净源码的 editable 构建必须允许首次安装开发依赖，不要求先运行 Vite；这里直接调用真实 PEP660 后端，防止正式资源钩子意外破坏开发者启动顺序。

    editable 输出仅用于开发，不应伪装成可部署 wheel。
    与正式构建使用同一个项目配置，区别来自后端的版本参数。
    不引入 uv 网络解析，从而将失败限定在本地构建契约。
    """
    environment = checkout / "editable"
    subprocess.run(["uv", "venv", "--python", sys.executable, str(environment)], check=True)
    result = subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(environment / "bin/python"),
            "--no-deps",
            "--editable",
            "apps/srv",
        ],
        cwd=checkout,
        capture_output=True,
        text=True,
        env={**os.environ, "UV_CACHE_DIR": "/tmp/veriq-uv", "UV_LINK_MODE": "copy"},
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_wheel_verifier_checks_real_resources_and_rejects_tampering(
    checkout: Path,
) -> None:
    """真实构建的 wheel 必须携带入口、图外资源和迁移，并由独立验证器检查 ZIP 内字节；随后改写一个资源而保留旧库存，验证器必须拒绝该可解压但不一致的候选。

    测试输入小而完整，不依赖前端构建缓存。
    迁移与合同必须同时存在，静态成功不能遮住资源遗漏。
    篡改后的 wheel 不安装，避免污染任何 Python 环境。
    """
    source = checkout / "apps/web/dist"
    (source / ".vite").mkdir(parents=True)
    (checkout / "package.json").write_text('{"version":"0.1.0"}')
    (source / "index.html").write_text("<h1>VeriQ</h1>")
    (source / "app.js").write_text("export const ready = true;")
    (source / "worker.js").write_text("self.close();")
    (source / ".vite/manifest.json").write_text(
        json.dumps({"index.html": {"file": "app.js", "isEntry": True}})
    )
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/stage_web.py"),
            "--root",
            str(checkout),
            "--commit",
            "a" * 40,
            "--build-id",
            "acceptance",
        ],
        check=True,
    )
    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "apps/srv",
            "--outdir",
            "wheels",
        ],
        cwd=checkout,
        check=True,
    )
    wheel = next((checkout / "wheels").glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        assert "veriq_server/static/dist/index.html" in archive.namelist()
        assert "veriq_server/static/dist/worker.js" in archive.namelist()
        assert any(
            name.startswith("veriq_server/migrations/versions/") for name in archive.namelist()
        )
        assert "veriq_server/_openapi.json" in archive.namelist()
        assert len(archive.namelist()) == len(set(archive.namelist()))
        records = {name: archive.read(name) for name in archive.namelist()}
    command = [sys.executable, str(ROOT / "scripts/verify_wheel.py"), str(wheel)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    records["veriq_server/static/dist/worker.js"] = b"changed"
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, content in records.items():
            archive.writestr(name, content)
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode != 0
    assert "mismatch" in result.stderr.lower()
