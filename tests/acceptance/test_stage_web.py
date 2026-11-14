"""静态暂存测试通过独立进程传入真实目录与文件，验证完整物理闭包、旧资源替换和符号链接拒绝；复制的公开文件故意不出现在 Vite 图中，防止把模块图误当成发行库存。

所有输入限定在临时工作区，不改动开发者已经构建的管理台。
非法目标必须在任何写入之前被拒绝。
失败断言检查原目录字节，确保坏输入不能破坏上一次有效暂存。
"""

from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def site(tmp_path: Path) -> tuple[Path, Path, Path]:
    """准备合法入口、真实模块图以及图外 worker 字节，并保留一个旧指纹资源作为清理探针；只有清单来自所有普通文件时才能同时覆盖这两类相反的发布要求。

    source 与 target 使用生产规定的唯一相对路径。
    临时根携带最小项目标识，不能因此允许任意目标目录。
    目标的旧文件用于证明成功发布不会留下旧资源。
    """
    source = tmp_path / "apps/web/dist"
    target = tmp_path / "apps/srv/src/veriq_server/static/dist"
    for path in (source / "assets", source / ".vite", target):
        path.mkdir(parents=True)
    (tmp_path / "package.json").write_text('{"name":"veriq","version":"0.1.0"}')
    (source / "index.html").write_text('<script src="/assets/app.js"></script>')
    (source / "assets/app.js").write_text("export const ready = true;")
    (source / "worker.js").write_text("self.onmessage = () => {};")
    (source / ".vite/manifest.json").write_text(
        '{"index.html":{"file":"assets/app.js","isEntry":true}}'
    )
    (target / "stale.js").write_text("old bytes")
    return tmp_path, source, target


def _stage(root: Path, target: Path | None = None) -> subprocess.CompletedProcess[str]:
    """使用公开暂存命令传递明确的构建身份及测试根，诊断由子进程保留给调用断言；该帮助方法不替换文件复制或清单生成，因此能观察真实路径保护和发布结果。

    目标覆盖参数只用于验证严格白名单的拒绝行为。
    commit 使用完整十六进制身份，避免身份校验先遮住文件测试。
    """
    command = [
        sys.executable,
        str(ROOT / "scripts/stage_web.py"),
        "--root",
        str(root),
        "--commit",
        "a" * 40,
        "--build-id",
        "acceptance",
    ]
    if target is not None:
        command += ["--target", str(target)]
    return subprocess.run(command, capture_output=True, text=True)


def test_stage_inventories_graph_externals_and_removes_old_files(site) -> None:
    """成功暂存必须列出入口、Vite 图与未被图引用的 worker，并将清单原始字节哈希写入四字段构建身份；旧资源不得成为本次产物的一部分，即使其名字看似合法。

    哈希计算读取落盘字节，不重新序列化库存。
    每一项同时验证长度与摘要，避免只检查文件名。
    """
    root, source, target = site
    result = _stage(root)
    assert result.returncode == 0, result.stderr
    raw = (target / "static-manifest.json").read_bytes()
    inventory = json.loads(raw)
    assert {entry["path"] for entry in inventory["files"]} == {
        "index.html",
        ".vite/manifest.json",
        "assets/app.js",
        "worker.js",
    }
    for entry in inventory["files"]:
        content = (source / entry["path"]).read_bytes()
        assert entry["sha256"] == sha256(content).hexdigest()
        assert entry["sizeBytes"] == len(content)
    assert not (target / "stale.js").exists()
    assert json.loads((target / "build-info.json").read_bytes()) == {
        "version": "0.1.0",
        "commit": "a" * 40,
        "buildId": "acceptance",
        "staticManifestHash": sha256(raw).hexdigest(),
    }


@pytest.mark.parametrize("attack", ["source-link", "directory-link", "target-link", "wrong-target"])
def test_stage_rejects_unsafe_paths_before_replacing_previous_site(site, attack) -> None:
    """源文件、源目录或目标路径中的符号链接必须拒绝，调用者也不能把清理目标改为任意目录；失败后旧站点仍保留原字节，证明检查发生在破坏性替换之前。

    外部文件作为链接探针，禁止将其复制到公开站点。
    目标链接指向另一个有价值目录，禁止沿链接清理。
    """
    root, source, target = site
    outside = root / "outside"
    outside.mkdir()
    (outside / "kept.txt").write_text("private")
    selected = None
    if attack == "source-link":
        (source / "secret.txt").symlink_to(outside / "kept.txt")
    elif attack == "directory-link":
        (source / "linked").symlink_to(outside, target_is_directory=True)
    elif attack == "target-link":
        target.rename(target.with_name("previous"))
        target.symlink_to(outside, target_is_directory=True)
    else:
        selected = outside
    result = _stage(root, selected)
    assert result.returncode != 0
    assert "Unsafe" in result.stderr
    assert (outside / "kept.txt").read_text() == "private"
    previous = target.with_name("previous") if attack == "target-link" else target
    assert (previous / "stale.js").read_text() == "old bytes"
