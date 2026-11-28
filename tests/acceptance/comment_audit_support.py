"""
共享验收夹具创建只含受控输入的临时 Git 仓库，保留原始字节并复用仓库冻结的解析器与真实审计入口。
"""

import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
from typing import Any, cast

import pytest

_ROOT = pathlib.Path(__file__).resolve().parents[2]


@pytest.fixture(name="repository")
def repository_fixture(tmp_path: pathlib.Path) -> pathlib.Path:
    """
    创建只枚举预期输入的微型仓库，发布脚本保持只读且解析器仅链接已有锁定版本，测试结束后可整体清理。

    CLI 需要脚本副本位于原相对路径，才能真实验证由脚本位置确定仓库根目录的行为。
    """
    root = tmp_path / "checkout"
    root.mkdir()
    subprocess.run(["git", "init", "-q", "--template=", str(root)], check=True)
    (root / ".gitignore").write_text("scripts/\npackages/\n", encoding="utf-8")
    scripts = root / "scripts"
    scripts.mkdir()
    for name in (
        "comment_ranges.mjs",
        "comment_audit.py",
        "source_inventory.py",
        "comment_syntax.py",
        "comment_powershell.py",
        "comment_powershell_process.py",
    ):
        target = scripts / name
        shutil.copyfile(_ROOT / "scripts" / name, target)
        target.chmod(0o444)
    dependencies = root / "packages/compiler/node_modules"
    dependencies.mkdir(parents=True)
    (dependencies / "typescript").symlink_to(
        (_ROOT / "packages/compiler/node_modules/typescript").resolve(),
        target_is_directory=True,
    )
    return root


def write_source(root: pathlib.Path, name: str, text: str) -> None:
    """
    以明确的 UTF8 字节写入选定源码，确保当前临时仓库保留真实换行和字符边界，并按需创建夹具父目录。

    输入里的短说明和非中文文字属于审计规则的反例，不是本测试的源码注释。
    """
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode("utf-8"))


def audit(root: pathlib.Path) -> dict[str, Any]:
    """
    将临时仓库交给发行构建器使用的审计函数，使解析错误、工具缺失和区间偏移均由真实调用传播给测试。

    CLI 测试另行运行只读脚本副本，验证公开报告文件和进程退出状态。
    """
    spec = importlib.util.spec_from_file_location(
        "veriq_comment_audit", _ROOT / "scripts/comment_audit.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast(dict[str, Any], module.audit(root))


def run_typescript_bridge(root: pathlib.Path, paths: list[str]) -> subprocess.CompletedProcess[str]:
    """
    将文件名按发布桥接的 JSON 文本协议送入真实编译器进程，捕获桥接输出和诊断供区间验收逐项验证。
    """
    return subprocess.run(
        ["node", "scripts/comment_ranges.mjs"],
        cwd=root,
        input=json.dumps(paths),
        capture_output=True,
        text=True,
        check=True,
    )


def run_audit_cli(
    root: pathlib.Path, output: pathlib.Path, cwd: pathlib.Path
) -> subprocess.CompletedProcess[str]:
    """
    调用临时仓库里的发布审计脚本并保留实际退出码及文本输出，让测试独立指定工作目录和报告文件路径。
    """
    return subprocess.run(
        [sys.executable, str(root / "scripts/comment_audit.py"), "--output", str(output)],
        cwd=cwd,
        capture_output=True,
        check=False,
        text=True,
    )
