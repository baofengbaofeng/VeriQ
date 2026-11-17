"""共享源码库存验收通过真实微型 Git 索引验证两个消费者的路径边界，保留生成源码的列宽检查并明确不支持语言会阻断比例。

文件名含换行的反例直接写入文件系统与索引，不以模拟列表替代 Git 的零字节分隔契约。
"""

import importlib.util
from pathlib import Path
import shutil
import subprocess
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _tool(name: str) -> Any:
    """从实际生产路径导入库存消费者以保持既有发行调用方式，测试不重复扩展名集合也不模拟 Git 返回的路径清单。"""
    spec = importlib.util.spec_from_file_location(
        "veriq_" + name, ROOT / "scripts" / (name + ".py")
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(name="repository")
def repository_fixture(tmp_path: Path) -> Path:
    """每例创建独立索引并只在临时目录中写入源码及忽略规则，保证已跟踪和新增路径的选择行为来自真实 Git 枚举。"""
    subprocess.run(["git", "init", "-q", "--template=", str(tmp_path)], check=True)
    (tmp_path / "scripts").mkdir()
    shutil.copyfile(ROOT / "scripts/comment_ranges.mjs", tmp_path / "scripts/comment_ranges.mjs")
    (tmp_path / ".gitignore").write_text(
        "/scripts/\n/packages/compiler/node_modules/\n", encoding="utf-8"
    )
    dependencies = tmp_path / "packages/compiler/node_modules"
    dependencies.mkdir(parents=True)
    (dependencies / "typescript").symlink_to(
        (ROOT / "packages/compiler/node_modules/typescript").resolve(),
        target_is_directory=True,
    )
    return tmp_path


def _write(root: Path, name: str, text: str = "int value;\n") -> None:
    """精确创建受控文件与所需父目录，保留文件名中的空格换行和 Unicode 字符，使路径选择不能依赖逐行拆分结果。"""
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_both_consumers_keep_git_nul_paths_and_tracked_ignored_sources(repository: Path) -> None:
    """换行及中文路径必须完整进入两个消费者，已跟踪文件后来被忽略也继续受检查，而未跟踪的依赖和普通文档均不被纳入。"""
    names = ["tracked.cc", "空 格/换\n行.cc", "tests/new.cxx"]
    for name in names:
        _write(repository, name)
    subprocess.run(["git", "add", "--", "tracked.cc"], cwd=repository, check=True)
    _write(
        repository,
        ".gitignore",
        "/scripts/\n/packages/compiler/node_modules/\ntracked.cc\nignored.cc\nnode_modules/\n",
    )
    for name in ["ignored.cc", "node_modules/dependency.cc", "README.md", "schema.json"]:
        _write(repository, name)
    assert [p.as_posix() for p in _tool("line_width").source_paths(repository)] == sorted(names)
    report = _tool("comment_audit").audit(repository)
    assert [item["path"] for item in report["unsupportedPaths"]] == sorted(names)
    assert report["files"] == []
    assert report["coverageComplete"] is False
    assert report["ratio"] is None


def test_source_boundary_keeps_all_existing_suffixes_names_and_explicit_path(
    repository: Path,
) -> None:
    """现有语言扩展与构建文件名都须保持列宽范围，暂不可信的语言仍完整出现在比例阻塞列表，不能因语法适配缺失隐藏路径。"""
    names = [
        "native/a.c",
        "native/a.h",
        "native/a.cc",
        "native/a.hh",
        "native/a.cxx",
        "native/a.hxx",
        "native/a.cpp",
        "native/a.hpp",
        "native/a.m",
        "native/a.mm",
        "app.java",
        "setup.sh",
        "setup.bash",
        "setup.zsh",
        "setup.ps1",
        "query.sql",
        "style.css",
        "style.scss",
        "style.less",
        "index.html",
        "app.swift",
        "app.go",
        "app.rs",
        "install.nsh",
        "install.nsi",
        "profile.tpl",
        "build.cmake",
        "Makefile",
        "CMakeLists.txt",
        "Dockerfile",
        "Dockerfile.dev",
        "deploy/desktop/macos/scripts/preinstall",
    ]
    for name in names:
        _write(repository, name, "中" * 61 + "\n")
    for name in [
        "not-preinstall",
        "nested/preinstall",
        "Dockerfilex",
        "config.gyp",
        "workflow.yml",
    ]:
        _write(repository, name)
    width = _tool("line_width")
    assert [p.as_posix() for p in width.source_paths(repository)] == sorted(names)
    assert width.check_sources(repository) == [(name, 1, 122) for name in sorted(names)]
    report = _tool("comment_audit").audit(repository)
    assert [item["path"] for item in report["unsupportedPaths"]] == sorted(names)
    assert all(item["reason"] for item in report["unsupportedPaths"])


def test_exact_generated_contracts_remain_width_inputs_but_not_ratio_inputs(
    repository: Path,
) -> None:
    """三条现有生成合同仅获比例排除而仍受列宽硬限制，名称近似的其他生成文件继续参与比例，防止共享库存扩大豁免范围。"""
    generated = [
        "apps/desktop/src/shared/operations.generated.ts",
        "packages/contracts/src/api.generated.ts",
        "packages/contracts/src/types.generated.ts",
    ]
    for name in generated:
        _write(repository, name, "中" * 61 + "\n")
    _write(repository, "other.generated.cc", "中" * 61 + "\n")
    width = _tool("line_width")
    assert [p.as_posix() for p in width.source_paths(repository)] == sorted(
        [*generated, "other.generated.cc"]
    )
    assert len(width.check_sources(repository)) == 4
    report = _tool("comment_audit").audit(repository)
    assert report["generatedExclusions"] == sorted(generated)
    assert [item["path"] for item in report["unsupportedPaths"]] == ["other.generated.cc"]
    assert report["ratio"] is None
