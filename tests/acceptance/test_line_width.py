"""显示列宽验收使用独立临时 Git 仓库检查真实源码选择及命令退出状态，覆盖中文边界与不回显正文的诊断约束。

测试只创建受控文本与索引，不安装依赖、不连接网络，也不把文件扩展名或导入语句视为超限豁免依据。
"""

import importlib.util
from pathlib import Path
import subprocess
import sys
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/line_width.py"


def _checker() -> Any:
    """直接导入实际发布的行宽工具以检查可观察的计数结果，避免在验收中复制字符分类算法而掩盖同一实现错误。"""
    spec = importlib.util.spec_from_file_location("veriq_line_width", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("text", "columns"),
    [
        ("中" * 60, 120),
        ("中" * 61, 122),
        ("Ａ" * 60, 120),
        ("e\u0301" * 60, 60),
        ("a\u200db", 2),
        ("中文ascii", 9),
        ("    # " + "中" * 57, 120),
        ("\t中", 6),
        ("a\t中", 6),
        ("abcd\t中", 10),
    ],
)
def test_display_width_uses_editor_columns(text: str, columns: int) -> None:
    """独立列出中文、全角、组合字符及不同制表符起点的预期列数，验证缩进与注释前缀都会占用同一显示宽度预算。"""
    assert _checker().display_width(text) == columns


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    """每次验收创建独立临时仓库并通过真实 Git 命令枚举文件，确保忽略规则和已跟踪文件不会被模拟调用提前过滤。"""
    subprocess.run(["git", "init", "-q", "--template=", str(tmp_path)], check=True)
    return tmp_path


def _write(root: Path, name: str, text: str) -> None:
    """源码夹具仅写入本次临时仓库的指定相对路径并明确使用统一编码，父目录创建不改变检查器实际使用的枚举方式。"""
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def _run(root: Path) -> subprocess.CompletedProcess[str]:
    """以独立进程运行真实命令并收集输出和退出码，确保源码违规不能仅靠直接函数调用被误判为命令执行成功。"""
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root)],
        capture_output=True,
        text=True,
    )


def test_scope_includes_generated_and_native_sources(repository: Path) -> None:
    """多语言及生成源码均须进入真实文件枚举范围，文档、锁文件与被忽略依赖则不因存在较长正文而污染源码检查结果。"""
    sources = [
        "apps/source.py",
        "app.tsx",
        "generated/api.generated.ts",
        "native/source.cc",
        "native/source.mm",
        "native/source.hxx",
        "setup.ps1",
        "install.nsi",
        "style.scss",
        "Makefile",
        "CMakeLists.txt",
        "Dockerfile.OE",
        "deploy/desktop/macos/scripts/preinstall",
    ]
    for name in sources:
        _write(repository, name, "中" * 61 + "\n")
    _write(repository, ".gitignore", "node_modules/\nignored.py\n")
    for name in [
        "README.md",
        "schema.json",
        "pnpm-lock.yaml",
        "node_modules/dependency.ts",
        "ignored.py",
    ]:
        _write(repository, name, "中" * 61 + "\n")
    actual = {path.as_posix() for path in _checker().source_paths(repository)}
    assert actual == set(sources)
    assert {path for path, _, _ in _checker().check_sources(repository)} == set(sources)


def test_tracked_source_remains_selected_after_ignore_change(repository: Path) -> None:
    """已经纳入索引的项目源码即使后来匹配忽略规则也必须继续接受检查，避免新增忽略项掩盖仓库中现存的超限代码。"""
    _write(repository, "source.ts", "中" * 61 + "\n")
    subprocess.run(["git", "add", "source.ts"], cwd=repository, check=True)
    _write(repository, ".gitignore", "source.ts\n")
    assert _checker().check_sources(repository) == [("source.ts", 1, 122)]


def test_cli_reports_columns_without_source_body(repository: Path) -> None:
    """边界行必须通过而紧随其后的超限行必须产生非零退出码，诊断仅返回位置和列数并且绝不回显源码中的受控敏感标记。"""
    secret_marker = "sensitive_fixture_value"
    _write(repository, "source.py", "中" * 60 + "\n" + secret_marker + "中" * 61 + "\n")
    result = _run(repository)
    assert result.returncode == 1
    assert "source.py:2: display width 145 exceeds 120 columns" in result.stdout
    assert secret_marker not in result.stdout + result.stderr
    _write(repository, "source.py", "中" * 60 + "\n")
    assert _run(repository).returncode == 0


def test_imports_receive_no_width_exemption(repository: Path) -> None:
    """导入语句的物理显示宽度超过硬上限时仍然必须失败，检查器不允许通过行内容看似机器生成或模块路径较长来放宽预算。"""
    _write(repository, "source.ts", 'import value from "' + "a" * 121 + '";\n')
    assert _run(repository).returncode == 1


@pytest.mark.parametrize("separator", ["\u2028", "\u0085", "\f"])
def test_unicode_separators_do_not_split_physical_lines(repository: Path, separator: str) -> None:
    """源码字面量中的特殊分隔字符仍占用同一物理行预算，只有文件实际换行才可重置列数以防超限正文被错误拆开后漏检。"""
    _write(repository, "source.py", "a" * 60 + separator + "b" * 60 + "\n")
    result = _run(repository)
    assert result.returncode == 1
    assert "source.py:1: display width 121 exceeds 120 columns" in result.stdout


def test_cli_fails_closed_when_repository_is_missing(tmp_path: Path) -> None:
    """无法枚举仓库时工具必须明确返回读取失败而不能伪造零违规，诊断只记录固定状态并保留命令行调用者可辨认的退出码。"""
    result = _run(tmp_path / "missing")
    assert result.returncode == 2
    assert "could not read the repository" in result.stderr
