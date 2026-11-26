"""
通过真实审计入口验证 Python 固定类型注释的计量资格，另以 mypy 静态检查证明两种精确标记的实际消费。

合成表达式提供明确的词元和宿主边界，合成模块只被审计或类型检查。
"""

import ast
from collections.abc import Mapping
from importlib import metadata
import json
import os
import pathlib
import re
import subprocess
import sys

import pytest

from tests.acceptance import comment_audit_support

repository_fixture = comment_audit_support.repository_fixture

_MARKERS = ("# type: ignore[no-any-return]", "# type: ignore[arg-type]")
_BODY = "调用方在解析前保留输入的原始路径，加载时再依据当前工作目录定位资源并向调用方报告实际读取失败的原因。"
_BODY_ISSUE = "Chinese comment first line must contain at least 40 characters"


def _assert_counts(
    report: Mapping[str, object], comments: int, code: int, issue_lines: tuple[int, ...] = ()
) -> None:
    """
    使用逐物理行推导的预期核对文件计数与首正文诊断，并确认完整报告按严格比例和独立正文问题共同判定。
    """
    ratio = comments / (comments + code)
    assert report["method"] == "syntax-comments-v1"
    assert report["coverageComplete"] is True
    assert report["unsupportedPaths"] == []
    assert report["files"] == [{"path": "sample.py", "commentLines": comments, "codeLines": code}]
    assert report["ratio"] == report["observedRatio"] == ratio
    assert report["violations"] == [
        {"path": "sample.py", "line": line, "reason": _BODY_ISSUE} for line in issue_lines
    ]
    assert report["passed"] is (ratio > 0.4 and not issue_lines)


@pytest.mark.parametrize("marker", _MARKERS)
def test_inline_tool_marker_keeps_code(
    repository: pathlib.Path, tmp_path: pathlib.Path, marker: str
) -> None:
    """
    一条赋值上的精确标记不贡献说明也不叠加代码行，只有该行的仓库仍因零注释比例被真实命令行拒绝。
    """
    comment_audit_support.write_source(repository, "sample.py", f"value = call(1)  {marker}\n")
    output = tmp_path / "audit.json"
    result = comment_audit_support.run_audit_cli(repository, output, tmp_path)
    assert result.returncode == 1
    assert result.stderr == ""
    report = json.loads(output.read_text(encoding="utf-8"))
    assert set(report) == {
        "method",
        "generatedExclusions",
        "requiresHumanQualityReview",
        "ratio",
        "observedRatio",
        "coverageComplete",
        "unsupportedPaths",
        "passed",
        "files",
        "violations",
    }
    assert report["requiresHumanQualityReview"] is True
    _assert_counts(report, 0, 1)


@pytest.mark.parametrize("marker", _MARKERS)
@pytest.mark.parametrize("argument", ["1", "名称", '"中😀"'], ids=["number", "name", "string"])
def test_known_marker_on_argument_line(
    repository: pathlib.Path, marker: str, argument: str
) -> None:
    """
    数字、名称和字符串词元分别独占多行调用的实参行，标记识别与该行代码保留同时适用于三种实际宿主。
    """
    source = f"value = call(\n    {argument},  {marker}\n)\n"
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 0, 3)


@pytest.mark.parametrize("marker", _MARKERS)
@pytest.mark.parametrize("newline", ["\r\n", "\r", "\n"], ids=["crlf", "cr", "lf"])
def test_marker_preserves_physical_lines_after_unicode(
    repository: pathlib.Path, marker: str, newline: str
) -> None:
    """
    先写一条独立代码，再在含中文和补充字符的第二条代码后放标记，三种换行均应让后续短说明归属第三行。
    """
    source = newline.join(["first = 1", f'名称 = "中😀"  {marker}', "# 短说明", ""])
    sample = repository / "sample.py"
    comment_audit_support.write_source(repository, "sample.py", source)
    assert sample.read_bytes() == source.encode("utf-8")
    _assert_counts(comment_audit_support.audit(repository), 1, 2, (3,))


@pytest.mark.parametrize("marker", _MARKERS)
def test_closing_delimiter_is_not_tool_host(repository: pathlib.Path, marker: str) -> None:
    """
    多行调用的闭括号仍是一条非空代码行，但该行只有分隔符，末尾完整工具拼写必须继续作为普通说明验收。
    """
    source = f"value = call(\n    1,\n)  {marker}\n"
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 1, 3, (3,))


@pytest.mark.parametrize("marker", _MARKERS)
def test_multiline_string_end_is_not_tool_host(repository: pathlib.Path, marker: str) -> None:
    """
    普通三引号字符串的首尾都占代码行，收尾行上的标记不能借用上一行开始的字符串词元获取同行工具资格。
    """
    source = f'value = """开头\n收尾"""  {marker}\n'
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 1, 2, (2,))


@pytest.mark.parametrize("marker", _MARKERS)
def test_standalone_marker_stays_ordinary(repository: pathlib.Path, marker: str) -> None:
    """
    上一行有可用代码时也不能把工具资格传给下一行的独立说明，逐行计数并在标记实际所在行报告正文问题。
    """
    comment_audit_support.write_source(repository, "sample.py", f"value = call(1)\n{marker}")
    _assert_counts(comment_audit_support.audit(repository), 1, 1, (2,))


@pytest.mark.parametrize(
    ("spelling", "issue_lines"),
    [
        pytest.param("# type: ignore[other-code]", (1,), id="unknown-code"),
        pytest.param("# type: ignore[arg-type,no-any-return]", (1,), id="multiple-codes"),
        pytest.param("# type: ignore", (1,), id="bare-ignore"),
        pytest.param("# type: ignroe[arg-type]", (1,), id="misspelling"),
        pytest.param("# type: Ignore[arg-type]", (1,), id="wrong-case"),
        pytest.param("# 前缀 type: ignore[arg-type]", (1,), id="body-prefix"),
        pytest.param("#type:ignore[arg-type]", (1,), id="changed-spacing"),
        pytest.param(f"{_MARKERS[1]} ", (1,), id="trailing-space"),
        pytest.param(f"{_MARKERS[1]}  # note", (1,), id="extra-short-body"),
        pytest.param(f"{_MARKERS[1]}  # {_BODY}", (), id="extra-valid-chinese-body"),
        pytest.param(
            f"{_MARKERS[1]}  # " + "ordinary prose without any Chinese characters",
            (1,),
            id="long-without-chinese",
        ),
    ],
)
def test_unknown_or_augmented_marker_stays_ordinary(
    repository: pathlib.Path, spelling: str, issue_lines: tuple[int, ...]
) -> None:
    """
    拼写变化和附加正文均保留整个普通注释的计量，足长的有效中文无正文问题，短说明或非中文确实被拒绝。
    """
    source = f"value = call(1)  {spelling}\n"
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 1, 1, issue_lines)


@pytest.mark.parametrize("marker", _MARKERS)
def test_literal_tool_spelling_has_no_comment_role(repository: pathlib.Path, marker: str) -> None:
    """
    字符串字面量内的井号及工具拼写仍是普通代码字符，赋值贡献一个代码行且没有独立注释或正文诊断。
    """
    comment_audit_support.write_source(repository, "sample.py", f'value = "{marker}"\n')
    _assert_counts(comment_audit_support.audit(repository), 0, 1)


@pytest.mark.parametrize("marker", _MARKERS)
def test_docstring_tool_spelling_keeps_documentation(repository: pathlib.Path, marker: str) -> None:
    """
    文档串中的工具拼写属于文档原文，首行说明和工具拼写所在行均计入正文，文档之后一条赋值独立计入代码。
    """
    source = f'"""{_BODY}\n{marker}\n"""\nvalue = 1\n'
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 2, 1)


@pytest.mark.parametrize("marker", _MARKERS)
@pytest.mark.parametrize(
    ("template", "counts", "issue_lines"),
    [
        pytest.param('"""{body}"""; value = 1  {marker}\n', (1, 1), (), id="code-after-docstring"),
        pytest.param('"""{body}""";  {marker}\n', (1, 0), (1,), id="docstring-and-semicolon"),
        pytest.param('(\n    "{body}"  {marker}\n)\n', (1, 0), (2,), id="inside-docstring-range"),
    ],
)
def test_docstring_boundary_keeps_only_real_code_hosts(
    repository: pathlib.Path,
    marker: str,
    template: str,
    counts: tuple[int, int],
    issue_lines: tuple[int, ...],
) -> None:
    """
    同行文档仍独立计数，只有文档区间以外的实际语句让工具标记获资格，分号和区间中的字符串都不够。
    """
    source = template.format(body=_BODY, marker=marker)
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), *counts, issue_lines)


@pytest.mark.parametrize("marker", _MARKERS)
def test_auxiliary_type_comment_failure_keeps_default_parser(
    repository: pathlib.Path, marker: str
) -> None:
    """
    普通 AST 接受的调用附有助手语法拒绝的类型说明，空行隔开下一处标记以验证两个正文块仍分别被报告。
    """
    source = f"print(1)  # type: int\n\nvalue = call(1)  {marker}\n"
    ast.parse(source)
    with pytest.raises(SyntaxError):
        ast.parse(source, type_comments=True)
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 2, 2, (1, 3))


def test_invalid_default_python_syntax_writes_no_partial_report(
    repository: pathlib.Path, tmp_path: pathlib.Path
) -> None:
    """
    在可计数文件之后安排真实的 Python 语法错误，函数仍传播解析失败，命令行则拒绝写出任何部分报告。
    """
    comment_audit_support.write_source(repository, "earlier.py", f"# {_BODY}\nvalue = 1\n")
    comment_audit_support.write_source(repository, "sample.py", "if True print(1)\n")
    with pytest.raises(SyntaxError, match="invalid syntax"):
        comment_audit_support.audit(repository)
    output = tmp_path / "audit.json"
    result = comment_audit_support.run_audit_cli(repository, output, tmp_path)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "SyntaxError: invalid syntax" in result.stderr
    assert not output.exists()


@pytest.mark.parametrize("marker", _MARKERS)
@pytest.mark.parametrize(
    ("body", "issue_lines"), [("短说明", (2,)), (_BODY, ())], ids=["short", "valid"]
)
def test_adjacent_ordinary_comment_keeps_own_first_body(
    repository: pathlib.Path, marker: str, body: str, issue_lines: tuple[int, ...]
) -> None:
    """
    合格行尾工具词元后紧接普通中文说明，第二行须独立成为正文首行，短文报错而完整正文能独立通过门禁。
    """
    source = f"value = call(1)  {marker}\n# {body}\n"
    comment_audit_support.write_source(repository, "sample.py", source)
    _assert_counts(comment_audit_support.audit(repository), 1, 1, issue_lines)


_MYPY_EXACT = (
    "from typing import Any\n\n"
    "def load() -> Any:\n"
    "    return 1\n\n"
    "def typed_return() -> int:\n"
    f"    return load()  {_MARKERS[0]}\n\n"
    "def typed_arg(value: str) -> None:\n"
    "    pass\n\n"
    f"typed_arg(1)  {_MARKERS[1]}\n"
)
_MYPY_CASES = (
    ("exact", _MYPY_EXACT, 0, ()),
    (
        "missing",
        _MYPY_EXACT.replace(f"  {_MARKERS[0]}", "").replace(f"  {_MARKERS[1]}", ""),
        1,
        ("no-any-return", "arg-type"),
    ),
    (
        "unused",
        _MYPY_EXACT.replace("return load()", "return 1").replace(
            "typed_arg(1)", 'typed_arg("valid")'
        ),
        1,
        ("unused-ignore", "unused-ignore"),
    ),
    ("typo", _MYPY_EXACT.replace("type: ignore", "type: ignroe"), 2, ("syntax",)),
)


def _mypy_environment(directory: pathlib.Path) -> dict[str, str]:
    """
    给静态检查进程保留可执行搜索路径和系统目录，把临时路径限制在夹具，避免继承项目插件或凭据变量。
    """
    return {
        "PATH": os.environ.get("PATH", os.defpath),
        **{name: os.environ[name] for name in ("SYSTEMROOT", "WINDIR") if name in os.environ},
        "TMPDIR": str(directory),
        "TEMP": str(directory),
        "TMP": str(directory),
    }


def _mypy_command(config: pathlib.Path, sample: pathlib.Path) -> list[str]:
    """
    所有合成变体使用相同的严格配置和目标版本，隔离已安装的类型包及增量缓存以便比较实际消费产生的诊断。
    """
    return [
        sys.executable,
        "-I",
        "-B",
        "-m",
        "mypy",
        "--config-file",
        str(config),
        "--strict",
        "--no-incremental",
        f"--cache-dir={os.devnull}",
        "--no-site-packages",
        "--python-version",
        "3.12",
        "--show-error-codes",
        "--no-color-output",
        str(sample),
    ]


@pytest.mark.parametrize(
    ("source", "exit_code", "codes"),
    [
        pytest.param(source, exit_code, codes, id=label)
        for label, source, exit_code, codes in _MYPY_CASES
    ],
)
def test_real_mypy_consumes_exact_markers(
    tmp_path: pathlib.Path, source: str, exit_code: int, codes: tuple[str, ...]
) -> None:
    """
    真实 mypy 对精确标记、移除标记、未使用标记与关键字错拼产生不同诊断，始终只静态读取合成源码。
    """
    assert metadata.version("mypy") == "1.19.1"
    config = tmp_path / "mypy.ini"
    sample = tmp_path / "sample.py"
    config.write_text("[mypy]\n", encoding="utf-8")
    sample.write_text(source, encoding="utf-8")
    result = subprocess.run(
        _mypy_command(config, sample),
        cwd=tmp_path,
        env=_mypy_environment(tmp_path),
        capture_output=True,
        check=False,
        timeout=30,
        encoding="utf-8",
    )
    assert result.returncode == exit_code, (result.stdout, result.stderr)
    assert result.stderr == ""
    assert tuple(re.findall(r"\[([a-z-]+)\]$", result.stdout, flags=re.MULTILINE)) == codes
