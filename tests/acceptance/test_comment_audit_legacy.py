"""
Python 与 TypeScript 验收用原始字节固定物理换行和真实正文边界，并通过共享临时仓库调用发布审计入口。
"""

from collections.abc import Mapping
import json
import pathlib

import pytest

from tests.acceptance import comment_audit_support

repository_fixture = comment_audit_support.repository_fixture
LEGACY_BODY = (
    "这段夹具说明用于验证文档串结束之后的赋值仍进入代码分母以及统计门禁据实拒绝缺少说明的输入"
)


def _assert_legacy_report(
    report: Mapping[str, object],
    name: str,
    counts: tuple[int, int],
    violation_lines: tuple[int, ...],
) -> None:
    """
    用逐行手算的计数和违规位置锁定报告合同，同时确认同一份完整报告参与严格比例门禁及首行规则的综合判定。
    """
    comments, code = counts
    ratio = comments / (comments + code)
    assert report["files"] == [{"path": name, "commentLines": comments, "codeLines": code}]
    assert report["ratio"] == report["observedRatio"] == ratio
    assert report["coverageComplete"] is True
    assert report["unsupportedPaths"] == []
    assert report["violations"] == [
        {
            "path": name,
            "line": line,
            "reason": "Chinese comment first line must contain at least 40 characters",
        }
        for line in violation_lines
    ]
    assert report["passed"] is (ratio > 0.4 and not violation_lines)


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "cr"])
def test_legacy_python_docstring_closer_retains_neighboring_code(
    repository: pathlib.Path, newline: str
) -> None:
    """
    结束行只有文档串引号和赋值时只计算代码，并以三种实际物理换行复现旧实现同时丢失代码和误加正文的情况。
    """
    name = "sample.py"
    source = newline.join([f'"""{LEGACY_BODY}', '"""; x = 1', "x = 2", ""])
    comment_audit_support.write_source(repository, name, source)
    assert (repository / name).read_bytes() == source.encode("utf-8")
    _assert_legacy_report(comment_audit_support.audit(repository), name, (1, 2), ())


@pytest.mark.parametrize(
    ("source", "counts", "violation_lines"),
    [
        pytest.param(f'"""{LEGACY_BODY}"""; x=1\n', (1, 1), (), id="same-line"),
        pytest.param(f'class 示例: """{LEGACY_BODY}😀"""; x=1\n', (1, 1), (), id="class"),
        pytest.param(f'def 示例(): """{LEGACY_BODY}😀"""; x=1\n', (1, 1), (), id="function"),
        pytest.param(
            f'async def 异步(): (u"{LEGACY_BODY}😀" "续"); x=1\r\n',
            (1, 1),
            (),
            id="async-function-concatenated",
        ),
        pytest.param(
            f'(\r    "{LEGACY_BODY[:22]}"\r    r"{LEGACY_BODY[22:]}😀"\r); x=1\r',
            (2, 1),
            (1,),
            id="parenthesized-short-first",
        ),
        pytest.param(
            f'("{LEGACY_BODY[:22]}" "{LEGACY_BODY[22:]}😀"); x=1 #短\n',
            (1, 1),
            (1,),
            id="same-line-concatenated-and-hash",
        ),
        pytest.param(
            f'(\n    #短\n    "{LEGACY_BODY}"\n); x=1\n',
            (2, 1),
            (2,),
            id="hash-inside-parentheses",
        ),
        pytest.param(f'"""短\\n{LEGACY_BODY}"""; x=1\n', (1, 1), (), id="escaped-newline"),
        pytest.param(f'"""{LEGACY_BODY}""";\n', (1, 0), (), id="optional-semicolon"),
        pytest.param(f'x = """{LEGACY_BODY}😀\n续"""\n', (0, 2), (), id="ordinary-string"),
    ],
)
def test_legacy_python_docstrings_use_physical_literal_text(
    repository: pathlib.Path, source: str, counts: tuple[int, int], violation_lines: tuple[int, ...]
) -> None:
    """
    样例分别固定真实文档串的宿主与语法坐标，原文拼接按物理行聚合，内部转义和括号不能掩盖短说明或同行代码。
    """
    name = "sample.py"
    comment_audit_support.write_source(repository, name, source)
    _assert_legacy_report(comment_audit_support.audit(repository), name, counts, violation_lines)


@pytest.mark.parametrize(
    "separator",
    ["\f", "\v", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"],
    ids=["ff", "vt", "fs", "gs", "rs", "nel", "ls", "ps"],
)
def test_legacy_python_separators_inside_literals_keep_token_line_numbers(
    repository: pathlib.Path, separator: str
) -> None:
    """
    字符串内的控制字符与 Unicode 分隔符都不移动 Python 分词行号，后续空物理行也不能遮住最后一条赋值。
    """
    name = "sample.py"
    comment_audit_support.write_source(
        repository, name, f'#{LEGACY_BODY}\nliteral="中{separator}😀"\n\nvalue=1\n'
    )
    _assert_legacy_report(comment_audit_support.audit(repository), name, (1, 2), ())


@pytest.mark.parametrize(
    "separator",
    ["\f", "\v", "\x1c", "\x1d", "\x1e", "\x85"],
    ids=["ff", "vt", "fs", "gs", "rs", "nel"],
)
def test_legacy_typescript_separators_inside_literals_do_not_add_rows(
    repository: pathlib.Path, separator: str
) -> None:
    """
    同时置入行注释和字符串的非换行字符必须留在各自原行，不能虚增代码行或把真实注释分裂成更多正文行。
    """
    name = "sample.ts"
    comment_audit_support.write_source(
        repository, name, f'//{LEGACY_BODY}{separator}续\nconst literal="中{separator}😀";\n\n'
    )
    _assert_legacy_report(comment_audit_support.audit(repository), name, (1, 1), ())


@pytest.mark.parametrize("newline", ["\u2028", "\u2029", "\r"], ids=["ls", "ps", "cr"])
def test_legacy_typescript_masks_keep_compiler_line_terminators(
    repository: pathlib.Path, newline: str
) -> None:
    """
    真实桥接返回的注释行数与原始码点切片先固定，再核对遮罩保留 ECMAScript 换行使后方两行代码仍进入分母。
    """
    name = "sample.ts"
    content = f"/*{LEGACY_BODY}{newline}{newline}*/"
    source = content + "\nconst a='😀';\nconst b=2;\n"
    comment_audit_support.write_source(repository, name, source)
    result = comment_audit_support.run_typescript_bridge(repository, [name])
    assert result.stderr == ""
    assert json.loads(result.stdout)[name] == [
        {
            "start": 1,
            "end": 3,
            "offset": 0,
            "limit": 50,
            "offsetCodePoint": 0,
            "limitCodePoint": 50,
            "text": content,
        }
    ]
    assert source[:50] == content
    assert source.encode("utf-16-le")[:100].decode("utf-16-le") == content
    _assert_legacy_report(comment_audit_support.audit(repository), name, (1, 2), ())


@pytest.mark.parametrize(
    ("name", "source", "counts", "violation_lines"),
    [
        pytest.param("sample.ts", "const x=1; /**/\n", (0, 1), (1,), id="empty-ts-block"),
        pytest.param("sample.ts", "const x=1; //\n", (0, 1), (1,), id="empty-ts-line"),
        pytest.param("sample.py", "x=1 #\n", (0, 1), (1,), id="empty-python-hash"),
        pytest.param(
            "sample.py",
            f"x=1 #{LEGACY_BODY}\n",
            (1, 1),
            (),
            id="python-hash-with-body",
        ),
        pytest.param(
            "sample.ts",
            f"const x=1; /*{LEGACY_BODY}*/\n",
            (1, 1),
            (),
            id="ts-block-with-body",
        ),
        pytest.param(
            "sample.ts",
            f"/*{LEGACY_BODY}😀\n * 真实续行 */ const x=1;\n",
            (2, 1),
            (),
            id="ts-closer-with-body-and-code",
        ),
        pytest.param(
            "sample.ts",
            "///*" + "中" * 36 + "*/\nconst x=1;\n",
            (1, 1),
            (),
            id="ts-line-literal-block-markers",
        ),
        pytest.param(
            "sample.py",
            "##" + "中" * 39 + "\nx=1\n",
            (1, 1),
            (),
            id="python-hash-literal-marker",
        ),
    ],
)
def test_legacy_effective_body_excludes_only_syntactic_delimiters(
    repository: pathlib.Path,
    name: str,
    source: str,
    counts: tuple[int, int],
    violation_lines: tuple[int, ...],
) -> None:
    """
    空分隔符同行不能借代码成为有效正文，正式行注释内部的字面标记和关闭行的真实正文则须参与长度及比例计算。
    """
    comment_audit_support.write_source(repository, name, source)
    _assert_legacy_report(comment_audit_support.audit(repository), name, counts, violation_lines)


@pytest.mark.parametrize(
    ("name", "source", "violation_line"),
    [
        pytest.param("sample.py", f'"""{LEGACY_BODY}"""\n#短\nx=1\n', 2, id="python-doc-then-hash"),
        pytest.param(
            "sample.ts",
            f"/*\n * {LEGACY_BODY}\n */\n//短\nconst x=1;\n",
            4,
            id="ts-multiline-block-then-line",
        ),
        pytest.param(
            "sample.ts",
            f"/*{LEGACY_BODY}*/\n//短\nconst x=1;\n",
            2,
            id="ts-single-line-block-then-line",
        ),
        pytest.param(
            "sample.ts",
            f"//{LEGACY_BODY}\n/*短*/\nconst x=1;\n",
            2,
            id="ts-line-then-block",
        ),
    ],
)
def test_legacy_different_comment_kinds_check_their_own_first_line(
    repository: pathlib.Path, name: str, source: str, violation_line: int
) -> None:
    """
    行注释只可接续同类型的相邻行注释，紧邻合法文档串或星号说明块的短正文必须独立记录自己的违规位置。
    """
    comment_audit_support.write_source(repository, name, source)
    _assert_legacy_report(comment_audit_support.audit(repository), name, (2, 1), (violation_line,))


@pytest.mark.parametrize(
    ("name", "marker", "code"), [("sample.py", "#", "x=1"), ("sample.ts", "//", "const x=1;")]
)
def test_legacy_adjacent_line_comments_keep_existing_group_boundaries(
    repository: pathlib.Path, name: str, marker: str, code: str
) -> None:
    """
    同类型说明继续按相邻物理行归组，代码前缀及缩进差异沿用原规则，真正空行或仅有代码的行从下一处开启新块。
    """
    comment_audit_support.write_source(
        repository,
        name,
        f"{code} {marker}{LEGACY_BODY}\n   {marker}续\n\n"
        f"{marker}{LEGACY_BODY}\n\n{marker}短\n{marker}{LEGACY_BODY}\n{code}\n{marker}短\n",
    )
    _assert_legacy_report(comment_audit_support.audit(repository), name, (6, 2), (6, 9))


def test_legacy_python_docstring_gate_cli_rejects_the_corrected_denominator(
    repository: pathlib.Path, tmp_path: pathlib.Path
) -> None:
    """
    从临时仓库执行发布入口，修正后的分母应使原先误通过的有效正文样本转为退出一并写出可核查的完整报告。
    """
    name = "sample.py"
    comment_audit_support.write_source(repository, name, f'"""{LEGACY_BODY}\n"""; x = 1\nx = 2\n')
    output = tmp_path / "result.json"
    result = comment_audit_support.run_audit_cli(repository, output, tmp_path)
    assert result.stderr == ""
    _assert_legacy_report(json.loads(output.read_text(encoding="utf-8")), name, (1, 2), ())
    assert result.returncode == 1
    assert result.stdout == "Comment ratio: 33.3333%; violations: 0\n"
