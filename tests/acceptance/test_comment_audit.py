"""注释审计验收通过微型 Git 仓库调用真实 Python 审计和固定 TypeScript 桥接，验证补充字符与原始换行不会改变计数、
违规行或发行退出码，并保留既有范围和严格比例门槛。

夹具仅复制四个轻量脚本并只读链接既有解析器，不安装或复制依赖树。所有被审计片段都是受控输入，短注释专门验证失败规则而非项
目说明。
"""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tokenize

import pytest

from tests.acceptance import comment_audit_support

LONG = (
    "注释审计以真实语法区间保留源码行号并检查首行文字长度确保补充字符和原始换行"
    "不会污染代码计数同时通过独立夹具验证报告及退出状态"
)
repository_fixture = comment_audit_support.repository_fixture
_write = comment_audit_support.write_source
_audit = comment_audit_support.audit


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("'汉';/*中文*/", (4, 10, 4, 10, 1, 1, "/*中文*/")),
        ("'😀';/*中😀文*/", (5, 13, 4, 11, 1, 1, "/*中😀文*/")),
        ("/*中😀文*/'😀';", (0, 8, 0, 7, 1, 1, "/*中😀文*/")),
        ("'😀';\r\n//中😀文", (7, 13, 6, 11, 2, 2, "//中😀文")),
    ],
    ids=["bmp", "nonbmp-before-and-inside", "nonbmp-after", "raw-crlf"],
)
def test_bridge_keeps_utf16_and_adds_codepoint_coordinates(
    repository: Path, text: str, expected: tuple[int, int, int, int, int, int, str]
) -> None:
    """桥接必须同时保留原有 UTF16 坐标与新增码点边界，并在 BMP、补充字符和原始 CRLF 输入中指向同一段真实注释；
    字面预期值独立列出，防止测试复制实现中的映射算法而掩盖偏移错误。

    EOF 不追加换行，原字段的文本与行号也作为兼容性契约一并检查。

    """
    _write(repository, "sample.ts", text)
    result = comment_audit_support.run_typescript_bridge(repository, ["sample.ts"])
    offset, limit, point_offset, point_limit, start, end, content = expected
    ranges = json.loads(result.stdout)["sample.ts"]
    assert ranges == [
        {
            "offset": offset,
            "limit": limit,
            "offsetCodePoint": point_offset,
            "limitCodePoint": point_limit,
            "start": start,
            "end": end,
            "text": content,
        }
    ]
    assert text[point_offset:point_limit] == content
    assert text.encode("utf-16-le")[offset * 2 : limit * 2].decode("utf-16-le") == content


@pytest.mark.parametrize(
    "text",
    [
        f"const face = '汉'; /*{LONG}*/",
        f"const face = '😀'; /*{LONG}*/",
        f"/*{LONG}😀*/ const face = '汉';",
        f"/*{LONG}*/ const face = '😀';",
        f"const face = '汉'; //{LONG}😀",
    ],
    ids=[
        "bmp",
        "nonbmp-before-eof",
        "nonbmp-inside",
        "nonbmp-after",
        "nonbmp-inside-eof",
    ],
)
def test_eof_and_mixed_code_count_each_line_once(repository: Path, text: str) -> None:
    """没有尾换行的混合代码和注释行必须各计一次，即使补充字符位于注释之前或内部也不能越界或残留伪代码；
    这些片段直接复现旧版按 UTF16 索引 Python 字符列表时的文件尾异常。

    单行双计保持既有分母语义，因此比例应为二分之一且没有首行违规。

    """
    _write(repository, "sample.ts", text)
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 1, "codeLines": 1}]
    assert report["ratio"] == 0.5
    assert report["violations"] == []
    assert report["passed"] is True


@pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
def test_multiline_masks_preserve_raw_line_breaks(repository: Path, newline: str) -> None:
    """多行注释中的补充字符与原始换行必须在 Node 和 Python 两侧保持相同位置，遮罩只移除注释文字而保留跨行结构；
    块首同行的说明和代码分别计数，并保留随后行注释和末行代码的位置。

    关闭分隔符旁只有代码，该行只进入代码分母。

    """
    text = newline.join(
        [
            f"const face = '😀'; /*{LONG}",
            " * 😀续行",
            " */ const tail = 1;",
            f"//{LONG}",
            "const done = 2;",
            "",
        ]
    )
    _write(repository, "sample.ts", text)
    assert (repository / "sample.ts").read_bytes() == text.encode("utf-8")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 3, "codeLines": 3}]
    assert report["ratio"] == 1 / 2
    assert report["violations"] == []
    assert report["passed"] is True


def test_crlf_without_supplementary_characters_preserves_following_code(
    repository: Path,
) -> None:
    """即使没有补充字符，Python 默认换行归一化也会让 Node 原始偏移遮罩到后续代码，因此该反例单独固定 CRLF 与纯 BMP
    文本，证明修复同时保留原始换行并正确统计块外两条语句。

    独立的关闭分隔符不制造注释计数，比例仍按两行有效说明和两行代码计算。

    """
    _write(
        repository,
        "sample.ts",
        f"const x = 1;\r\n/*{LONG}\r\n续行\r\n*/\r\nconst y = 2;\r\n",
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 2, "codeLines": 2}]
    assert report["ratio"] == 0.5
    assert report["violations"] == []
    assert report["passed"] is True


def test_adjacent_comments_and_slashes_in_literals_keep_exact_violation_line(
    repository: Path,
) -> None:
    """字符串、模板和正则中的斜杠必须留作代码，真实相邻行注释只用块首行校验长度；另一个混合代码短注释应准确报告第七行，
    避免坐标修复意外扩大注释识别范围或改变连续块合并规则。

    补充字符放在三种字面量中，使后续真实注释也覆盖累计偏移差的场景。

    """
    _write(
        repository,
        "sample.ts",
        'const text = "//字符串😀";\n'
        "const template = `/*模板😀*/`;\n"
        r"const regex = /\/\/|\/\*/;" + "\n"
        f"//{LONG}\n//续行\n\nconst x = 1; //短\n",
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 3, "codeLines": 4}]
    assert report["ratio"] == 3 / 7
    assert report["violations"] == [
        {
            "path": "sample.ts",
            "line": 7,
            "reason": "Chinese comment first line must contain at least 40 characters",
        }
    ]
    assert report["passed"] is False


@pytest.mark.parametrize(
    ("first", "passed"),
    [("中" * 38 + "😀", False), ("中" * 39 + "😀", True)],
    ids=["39", "40"],
)
def test_first_line_threshold_counts_unicode_characters(
    repository: Path, first: str, passed: bool
) -> None:
    """首行长度必须按 Unicode 字符判定三十九与四十的边界，补充字符只能贡献一个字符而不能因 UTF16 双单元提前通过；
    片段没有代码干扰比例，因此失败只能来自真实的首行长度违规。

    两种输入均以中文开头且位于无尾换行的文件末尾，覆盖字符计数和遮罩边界的结合。

    """
    _write(repository, "sample.ts", f"//{first}")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 1, "codeLines": 0}]
    assert report["ratio"] == 1
    assert report["passed"] is passed
    assert report["violations"] == (
        []
        if passed
        else [
            {
                "path": "sample.ts",
                "line": 1,
                "reason": "Chinese comment first line must contain at least 40 characters",
            }
        ]
    )


@pytest.mark.parametrize(
    ("code", "ratio", "passed"),
    [("const z = 3;\n", 0.4, False), ("", 0.5, True)],
    ids=["exact-40", "above-40"],
)
def test_ratio_remains_strict_with_no_quality_violations(
    repository: Path, code: str, ratio: float, passed: bool
) -> None:
    """覆盖率恰好百分之四十必须拒绝而超过该值才通过，连续两行有效注释的首行已满足中文长度要求，确保边界结果真实来自严格
    比例比较而不是另一个违规条件或分母变化。

    额外代码行只改变代码计数，注释内容和合并规则在两个场景中保持一致。

    """
    _write(repository, "sample.ts", f"//{LONG}\n//续行\nconst x = 1;\nconst y = 2;\n{code}")
    report = _audit(repository)
    assert report["files"] == [
        {"path": "sample.ts", "commentLines": 2, "codeLines": 3 if code else 2}
    ]
    assert report["violations"] == []
    assert report["ratio"] == ratio
    assert report["passed"] is passed


def test_owned_git_scope_keeps_tests_old_files_and_only_explicit_exclusions(
    repository: Path,
) -> None:
    """真实 Git 枚举必须同时纳入已跟踪旧源码和尚未忽略的测试文件，只排除既有三个生成文件与私有证据；普通名称带
    generated 的源码仍被审计，防止修复通过扩大排除或丢弃旧文件改变门禁范围。

    被排除片段故意使用无效说明，若范围意外扩大将使实际报告出现额外文件和违规。

    """
    for name in ("old.ts", "tests/new.ts", "other.generated.ts"):
        _write(repository, name, f"//{LONG}\n")
    subprocess.run(["git", "add", "old.ts"], cwd=repository, check=True)
    generated = [
        "apps/desktop/src/shared/operations.generated.ts",
        "packages/contracts/src/api.generated.ts",
        "packages/contracts/src/types.generated.ts",
    ]
    for name in [*generated, ".superpowers/private.ts", "ignored.txt"]:
        _write(repository, name, "//短\n")
    subprocess.run(["git", "add", "--force", "--", *generated], cwd=repository, check=True)
    report = _audit(repository)
    assert report == {
        "method": "syntax-comments-v1",
        "generatedExclusions": sorted(generated),
        "requiresHumanQualityReview": True,
        "ratio": 1,
        "observedRatio": 1,
        "coverageComplete": True,
        "unsupportedPaths": [],
        "passed": True,
        "files": [
            {"path": name, "commentLines": 1, "codeLines": 0}
            for name in ["old.ts", "other.generated.ts", "tests/new.ts"]
        ],
        "violations": [],
    }


@pytest.mark.parametrize(
    ("comment", "exit_code"),
    [(LONG + "😀", 0), ("短😀", 1)],
    ids=["success", "rule-failure"],
)
def test_cli_writes_report_and_returns_rule_exit_from_another_cwd(
    repository: Path, tmp_path: Path, comment: str, exit_code: int
) -> None:
    """公开命令从仓库外执行时仍必须读取脚本所在仓库，生成可消费的报告并按真实中文首行规则返回成功或失败；
    输入含补充字符且没有尾换行，使 CLI 同时证明修复路径和发行退出码保持一致。

    报告写到嵌套的新目录，真实验证输出父目录创建而不借用审计函数返回值作预期。

    """
    _write(repository, "sample.ts", f"//{comment}")
    output = tmp_path / "reports/result.json"
    result = subprocess.run(
        [
            sys.executable,
            str(repository / "scripts/comment_audit.py"),
            "--output",
            str(output),
        ],
        cwd=tmp_path,
        capture_output=True,
        check=False,
        text=True,
    )
    assert result.returncode == exit_code, result.stderr
    assert result.stderr == ""
    assert result.stdout == f"Comment ratio: 100.0000%; violations: {exit_code}\n"
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["method"] == "syntax-comments-v1"
    assert report["requiresHumanQualityReview"] is True
    assert report["files"] == [{"path": "sample.ts", "commentLines": 1, "codeLines": 0}]
    assert report["ratio"] == 1
    assert report["passed"] is (exit_code == 0)
    assert report["violations"] == (
        []
        if exit_code == 0
        else [
            {
                "path": "sample.ts",
                "line": 1,
                "reason": "Chinese comment first line must contain at least 40 characters",
            }
        ]
    )


def test_missing_node_fails_instead_of_returning_an_empty_pass(
    repository: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """解析工具不存在时审计必须传播真实工具缺失异常，不能以空范围或空报告假装通过；测试只在专属 PATH 中保留实际 Git
    可执行文件，不替换解析器、子进程或审计函数的行为。

    环境变量由 pytest 在本例结束时恢复，不影响其他夹具或项目依赖。

    """
    _write(repository, "sample.ts", f"//{LONG}\n")
    executable = shutil.which("git")
    assert executable
    tools = tmp_path / "git-only"
    tools.mkdir()
    (tools / "git").symlink_to(executable)
    monkeypatch.setenv("PATH", str(tools))
    with pytest.raises(FileNotFoundError) as caught:
        _audit(repository)
    assert caught.value.filename == "node"


def test_missing_typescript_fails_through_real_node(repository: Path) -> None:
    """固定解析器链接缺失时真实 Node 必须失败并使 Python 审计抛出子进程错误，不能仅验证 Node 可执行文件存在便把没有解析
    结果的源码视为合规；删除操作只作用于本例拥有的临时链接。

    现有依赖目标始终只读且保留，异常输出用于确认失败确实来自解析器装载。

    """
    _write(repository, "sample.ts", f"//{LONG}\n")
    (repository / "packages/compiler/node_modules/typescript").unlink()
    with pytest.raises(subprocess.CalledProcessError) as caught:
        _audit(repository)
    assert caught.value.returncode != 0
    assert caught.value.cmd == ["node", "scripts/comment_ranges.mjs"]


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "bare-cr"])
def test_python_physical_newlines_preserve_the_code_denominator(
    repository: Path, newline: str
) -> None:
    """Python 合法的三种物理换行必须产生相同的注释与代码行数，尤其裸回车不能让分词器把两行语句折叠到一行而将不足百分之四
    十的输入误判通过；真实审计报告同时固定分母、比例和门禁结果。

    文件按原始字节写入并使用恰好六十个中文字的首行，排除质量违规对比例结果的干扰。

    """
    text = newline.join(["#" + "中" * 60, "x=1", "y=2", ""])
    _write(repository, "sample.py", text)
    assert (repository / "sample.py").read_bytes() == text.encode("utf-8")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.py", "commentLines": 1, "codeLines": 2}]
    assert report["ratio"] == 1 / 3
    assert report["violations"] == []
    assert report["passed"] is False


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "bare-cr"])
def test_python_docstring_and_inline_comment_keep_physical_line_positions(
    repository: Path, newline: str
) -> None:
    """文档串由 AST 确认而同行注释由分词器定位，两者必须在所有合法物理换行下指向相同行号，防止裸回车让文档串的代码扣除误
    伤后续语句或让同行注释污染另一行的计数与首行判定。

    第一行仅为有效文档串，第二行同时计入代码和注释，第三行只贡献代码，因此比例固定为二分之一。

    """
    _write(
        repository,
        "sample.py",
        newline.join([f'"""{LONG}"""', f"x=1 #{LONG}", "y=2", ""]),
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.py", "commentLines": 2, "codeLines": 2}]
    assert report["ratio"] == 0.5
    assert report["violations"] == []
    assert report["passed"] is True


@pytest.mark.parametrize("suffix", [".ts", ".cjs", ".mts", ".cts", ".js", ".mjs", ".jsx", ".tsx"])
def test_bridge_rejects_syntax_before_emitting_any_file(repository: Path, suffix: str) -> None:
    """混合批次先提交合法文件再提交带受控敏感标记的坏语法，必须整体拒绝且不输出部分计数，诊断仅含路径位置与编号。"""
    _write(repository, "valid.ts", f"//{LONG}\n")
    name = "broken" + suffix
    marker = "private_syntax_fixture"
    _write(repository, name, f"const {marker} = ;\n")
    result = subprocess.run(
        ["node", "scripts/comment_ranges.mjs"],
        cwd=repository,
        input=json.dumps(["valid.ts", name]),
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert result.stdout == ""
    assert name in result.stderr
    assert "TS1109" in result.stderr
    assert marker not in result.stderr


def test_cjs_is_counted_and_native_and_shell_fail_coverage_closed(repository: Path) -> None:
    """即使已支持文件的观察比例达到百分之百，原生源码与可能包含文档正文的脚本仍须显式阻断全仓结论，
    不能以局部计数通过。
    """
    _write(repository, "sample.cjs", f"//{LONG}\n")
    _write(repository, "native.c", "int value;\n")
    _write(repository, "native.cc", "int value;\n")
    _write(repository, "sample.sh", f"cat <<'EOF'\n#{LONG}\nEOF\n")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.cjs", "commentLines": 1, "codeLines": 0}]
    assert report["observedRatio"] == 1
    assert report["ratio"] is None
    assert report["coverageComplete"] is False
    assert report["passed"] is False
    assert [item["path"] for item in report["unsupportedPaths"]] == [
        "native.c",
        "native.cc",
        "sample.sh",
    ]
    assert all(item["reason"] for item in report["unsupportedPaths"])


def test_cli_reports_ratio_unavailable_with_unsupported_source(
    repository: Path, tmp_path: Path
) -> None:
    """命令行必须落盘完整的不支持路径并返回失败，日志不得将已支持文件的满分观察值标成全仓比例以误导发行门禁。"""
    _write(repository, "sample.ts", f"//{LONG}\n")
    _write(repository, "style.scss", "body {}\n")
    output = tmp_path / "report.json"
    result = comment_audit_support.run_audit_cli(repository, output, tmp_path)
    assert result.returncode == 1
    assert "Comment ratio unavailable" in result.stdout
    assert "100.0000%" not in result.stdout
    report = json.loads(output.read_text())
    assert report["ratio"] is None
    assert report["passed"] is False
    assert [item["path"] for item in report["unsupportedPaths"]] == ["style.scss"]


@pytest.mark.parametrize(("length", "passed"), [(120, True), (121, False)])
def test_first_line_upper_bound_counts_unicode_body(
    repository: Path, length: int, passed: bool
) -> None:
    """正文上限按实际码点而非显示列或代理单元计算，最后一个补充字符只占一个字符，长度一百二十一时须真实阻断通过。"""
    _write(repository, "sample.ts", "//" + "中" * (length - 1) + "😀")
    report = _audit(repository)
    assert report["ratio"] == 1
    assert report["passed"] is passed
    assert bool(report["violations"]) is not passed


@pytest.mark.parametrize("suffix", [".jsx", ".tsx", ".cts", ".cjs", ".pyi"])
def test_new_supported_suffixes_preserve_real_language_boundaries(
    repository: Path, suffix: str
) -> None:
    """新纳入后缀必须通过真正语言适配计数，显式 JSX 方言保留标签文字中的伪注释，声明文件则由 Python 语法处理。"""
    if suffix == ".pyi":
        text = f"#{LONG}\nvalue: int\n"
    elif suffix in {".jsx", ".tsx"}:
        text = f"//{LONG}\nconst element = <div>/* literal 😀 */</div>;\r\n"
    else:
        text = f"//{LONG}\nconst value = 1;\n"
    _write(repository, "sample" + suffix, text)
    report = _audit(repository)
    assert report["files"] == [{"path": "sample" + suffix, "commentLines": 1, "codeLines": 1}]
    assert report["ratio"] == 0.5
    assert report["passed"] is True


def test_typescript_without_jsx_extension_reports_native_parse_diagnostics(
    repository: Path,
) -> None:
    """类型脚本的普通后缀必须保留官方解析诊断而不升级为 JSX，审计只检查真实语法错误，类型与编译选项交由所属构建检查。"""
    _write(repository, "sample.ts", "const element = <div />;\n")
    with pytest.raises(subprocess.CalledProcessError):
        _audit(repository)


@pytest.mark.parametrize("suffix", [".js", ".mjs", ".cjs"])
def test_javascript_keeps_native_scriptkind_jsx_acceptance(repository: Path, suffix: str) -> None:
    """普通脚本使用官方原生方言解析，保留解析器自身接受的 JSX 行为且不自行制造语法诊断，
    标签正文中的伪注释不能抬高比例。
    """
    _write(repository, "sample" + suffix, f"//{LONG}\nconst element = <div>/* text */</div>;\n")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample" + suffix, "commentLines": 1, "codeLines": 1}]
    assert report["ratio"] == 0.5
    assert report["passed"] is True


def test_python_strings_separators_and_empty_lines_do_not_inflate_comments(
    repository: Path,
) -> None:
    """普通三引号常量必须保留在代码分母，只有 AST 确认的文档串算说明，纯分隔符和空行不能增加有效注释行数。"""
    _write(repository, "sample.py", f'"""{LONG}"""\nvalue = """ordinary\ntext"""\n#\n\n')
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.py", "commentLines": 1, "codeLines": 2}]
    assert report["ratio"] == 1 / 3


@pytest.mark.parametrize("text", ['value = "unterminated', "def invalid(:\n    pass\n"])
def test_python_invalid_source_cannot_return_a_ratio(repository: Path, text: str) -> None:
    """未终止的字符串和畸形函数定义必须通过真实分词或语法检查拒绝，不能把错误输入当成没有注释的可统计代码。"""
    _write(repository, "sample.py", text)
    with pytest.raises((SyntaxError, tokenize.TokenError)):
        _audit(repository)


def test_supported_unicode_newline_path_survives_inventory_and_bridge(repository: Path) -> None:
    """带空格换行和中文的合法源码路径必须原样经过 Git 库存与 Node 桥接，完整计数证明没有逐行拆分或路径引号污染。"""
    name = "空 格/换\n行.cjs"
    _write(repository, name, f"//{LONG}\nconst value = '😀';\r\n")
    subprocess.run(["git", "add", "--", name], cwd=repository, check=True)
    report = _audit(repository)
    assert report["files"] == [{"path": name, "commentLines": 1, "codeLines": 1}]
    assert report["coverageComplete"] is True
    assert report["ratio"] == 0.5
    assert report["passed"] is True


def test_bridge_does_not_interpret_c_as_javascript(repository: Path) -> None:
    """即使原生文件内容恰好可被脚本语法接受，桥接也须按语言拒绝而不返回空注释成功，防止未来调用方绕过库存支持状态。"""
    _write(repository, "native.c", "value;\n")
    result = subprocess.run(
        ["node", "scripts/comment_ranges.mjs"],
        cwd=repository,
        input='["native.c"]',
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert result.stdout == ""
    assert "Unsupported source language" in result.stderr


def test_bridge_bounds_and_escapes_diagnostic_paths(repository: Path) -> None:
    """多个畸形输入只能输出有界数量的诊断，路径中的换行须被转义且长路径不能撑大日志，源码正文标记始终不能泄露。"""
    name = "/".join(["segment" * 10] * 4) + "/换\n行.ts"
    _write(repository, name, "const hidden_diagnostic_marker = ;\n" * 30)
    short_name = "换\n行.ts"
    _write(repository, short_name, "const hidden_diagnostic_marker = ;\n")
    result = subprocess.run(
        ["node", "scripts/comment_ranges.mjs"],
        cwd=repository,
        input=json.dumps([short_name, name]),
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert result.stdout == ""
    diagnostics = result.stderr.splitlines()
    assert diagnostics[0].startswith(json.dumps(short_name, ensure_ascii=False) + ":")
    assert len(diagnostics) == 20
    assert all(len(line) < 240 for line in diagnostics)
    assert "hidden_diagnostic_marker" not in result.stderr


def test_empty_block_delimiters_cannot_raise_observed_ratio(repository: Path) -> None:
    """纯块注释分隔符和空正文不得增加注释分子，保留真实代码行后比例仍为零，避免仅插入空白外壳使全仓门禁通过。"""
    _write(repository, "sample.ts", "/**\n *\n\n */\nconst value = 1;\n")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 0, "codeLines": 1}]
    assert report["ratio"] == 0
    assert report["passed"] is False


def test_python_ast_docstrings_cover_class_sync_and_async_bodies(repository: Path) -> None:
    """模块类及同步异步函数的首语句说明都须由 AST 确认并从代码分母扣除，函数体的普通字符串仍作为代码参与全局计数。"""
    _write(
        repository,
        "sample.py",
        f'"""{LONG}"""\nclass Example:\n    """{LONG}"""\n'
        f'    def method(self):\n        """{LONG}"""\n        return 1\n'
        f'async def task():\n    """{LONG}"""\n    value = "ordinary"\n',
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.py", "commentLines": 4, "codeLines": 5}]
    assert report["ratio"] == 4 / 9
    assert report["violations"] == []
    assert report["passed"] is True


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_shell_shebang_is_code_and_heredoc_hashes_are_data(repository: Path, newline: str) -> None:
    """解释器首行保留代码分母，正文里的井号由真实 heredoc 边界排除，行内真实说明则与同一行代码分别计数。"""
    _write(
        repository,
        "sample.sh",
        newline.join(
            ["#!/bin/sh", "cat <<'EOF'", "#" + LONG, "中😀", "EOF", "printf '#数据' #" + LONG, ""]
        ),
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.sh", "commentLines": 1, "codeLines": 6}]
    assert report["violations"] == []
    assert report["ratio"] == 1 / 7
    assert report["coverageComplete"] is True
    assert report["passed"] is False


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_css_literals_empty_separators_and_mixed_lines(repository: Path, newline: str) -> None:
    """样式地址和字符串中的伪注释留在代码分母，独占空分隔符不能抬分，含真实说明的混合代码行仍保持双计语义。"""
    _write(
        repository,
        "sample.css",
        newline.join(
            [
                'a { content: "/*数据😀*/"; x: url(https://a/中//path); }',
                "/**/",
                "/*",
                " *",
                " */",
                "a {} /*" + LONG + "*/",
            ]
        ),
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.css", "commentLines": 1, "codeLines": 2}]
    assert report["ratio"] == 1 / 3
    assert len(report["violations"]) == 1
    assert report["violations"][0]["line"] == 2


@pytest.mark.parametrize(
    "syntax", [(".css", "/*", "*/"), (".sh", "#!/bin/sh\n#", ""), (".java", "/*", "*/")]
)
@pytest.mark.parametrize(("length", "valid"), [(39, False), (40, True), (120, True), (121, False)])
def test_new_comment_bodies_use_unicode_limits_independent_of_width(
    repository: Path, syntax: tuple[str, str, str], length: int, valid: bool
) -> None:
    """新增语言正文剥离实际分隔符后按码点检查上下限，超宽与正文长度属于不同门禁，不能把字符数量误当显示列数。"""
    suffix, prefix, postfix = syntax
    _write(repository, "sample" + suffix, prefix + "中" * (length - 1) + "😀" + postfix)
    report = _audit(repository)
    assert bool(report["violations"]) is not valid
    assert report["files"][0]["commentLines"] == 1
    assert report["files"][0]["codeLines"] == (1 if suffix == ".sh" else 0)


@pytest.mark.parametrize(
    ("name", "text"),
    [
        ("broken.css", '/*合法*/ a {x:"hidden_secret}'),
        ("broken.sh", "#!/bin/sh\n#合法\ncat <<'EOF'\nhidden_secret"),
    ],
)
def test_new_parser_cli_rejects_entire_report_without_source_leaks(
    repository: Path, tmp_path: Path, name: str, text: str
) -> None:
    """真实命令遇到先有合法注释的坏语法也必须拒绝整份报告，错误日志只保留路径类别与行号，禁止复制源码敏感标记。"""
    _write(repository, name, text)
    output = tmp_path / "rejected.json"
    result = subprocess.run(
        [sys.executable, str(repository / "scripts/comment_audit.py"), "--output", str(output)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert not output.exists()
    assert "hidden_secret" not in result.stderr
    assert name in result.stderr
    assert "line" in result.stderr


@pytest.mark.parametrize(
    ("name", "source", "comments", "code"),
    [
        ("empty.css", "a {} /**/", 0, 1),
        ("empty.sh", "#!/bin/sh\nprintf value # ***", 0, 2),
        ("mixed.css", "a {} /*中\n * 续行\n */ a {}", 2, 2),
    ],
)
def test_new_families_count_only_effective_comment_body_lines(
    repository: Path, name: str, source: str, comments: int, code: int
) -> None:
    """新增语言只按真实注释正文计数，空分隔符和关闭行旁的代码不能制造说明行，非空正文与代码同处一行仍各贡献一次。"""
    _write(repository, name, source)
    report = _audit(repository)
    assert report["files"] == [{"path": name, "commentLines": comments, "codeLines": code}]


def test_css_ambiguous_url_cannot_return_partial_audit(repository: Path) -> None:
    """未引号地址中的伪注释即使被成熟语法标记也必须明确阻断整份审计，不能跳过该路径或把已识别的顶层注释计为部分成功。"""
    _write(repository, "ambiguous.css", "/*" + LONG + "*/ a{x:url(foo/*数据*/bar)}")
    with pytest.raises(ValueError, match="Unsupported CSS comment context"):
        _audit(repository)


@pytest.mark.parametrize(
    ("name", "opening", "closing"), [("sample.ts", "//", ""), ("sample.css", "/*", "*/")]
)
def test_typescript_hash_in_body_preserves_existing_first_line_length(
    repository: Path, name: str, opening: str, closing: str
) -> None:
    """脚本行注释正文中的井号属于有效文字，新增 Shell 分隔符剥离不能改变既有类型脚本恰好四十字符的通过边界。"""
    _write(repository, name, opening + "#" + "中" * 39 + closing)
    report = _audit(repository)
    assert report["violations"] == []
    assert report["files"] == [{"path": name, "commentLines": 1, "codeLines": 0}]
    assert report["ratio"] == 1
    assert report["passed"] is True


@pytest.mark.parametrize(
    "body",
    ["/*" + "中" * 38, "中" * 38 + "*/", "*" + "中" * 39, "//" + "中" * 38, "#" + "中" * 39],
    ids=["opening-literal", "closing-literal", "star-literal", "slash-literal", "hash-literal"],
)
def test_shell_body_keeps_literal_c_style_delimiters(repository: Path, body: str) -> None:
    """脚本井号之后的斜杠星号只是普通正文，不能继续按样式块分隔符剥离并改变恰好四十字符的真实首行边界。"""
    _write(repository, "sample.sh", "#!/bin/sh\n#" + body)
    report = _audit(repository)
    assert report["violations"] == []
    assert report["files"] == [{"path": "sample.sh", "commentLines": 1, "codeLines": 1}]
    assert report["passed"] is True


@pytest.mark.parametrize(
    "newline",
    ["\n", "\r\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"],
    ids=["lf", "crlf", "vt", "ff", "fs", "gs", "rs", "nel", "ls", "ps"],
)
@pytest.mark.parametrize("language", ["css", "shell"])
def test_new_family_masks_preserve_physical_breaks_and_trailing_code(
    repository: Path, newline: str, language: str
) -> None:
    """注释内的标准物理分行符必须留在遮罩结果中，否则空正文行会错移并吞掉后续代码，导致观察比例被虚假抬高。"""
    if language == "css":
        name = "sample.css"
        source = "/*" + LONG + newline * 2 + "*/\na{}\n"
        code_lines = 1
    else:
        name = "sample.sh"
        source = "#!/bin/sh\n#" + LONG + newline * 2 + "\nprintf value\n"
        code_lines = 2
    _write(repository, name, source)
    report = _audit(repository)
    assert report["files"] == [{"path": name, "commentLines": 1, "codeLines": code_lines}]
    assert report["violations"] == []
    assert report["observedRatio"] == 1 / (1 + code_lines)
    assert report["passed"] is (language == "css")


@pytest.mark.parametrize("prefix,suffix", [("//", ""), ("///*", "*/"), ("//#", ""), ("//*", "")])
def test_java_line_body_preserves_nonformal_markers(
    repository: Path, prefix: str, suffix: str
) -> None:
    """行注释只剥离正式双斜杠，正文中的井号星号和块标记都参与四十字符边界，不能沿用类型脚本的多次剥离顺序。"""
    body = prefix[2:] + "中" * (40 - len(prefix[2:]) - len(suffix)) + suffix
    _write(repository, "sample.java", "//" + body + "\nclass X {}\n")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.java", "commentLines": 1, "codeLines": 1}]
    assert report["violations"] == []


@pytest.mark.parametrize(
    "boundary", ["\n", "\r\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]
)
def test_java_effective_body_and_masks_keep_all_physical_breaks(
    repository: Path, boundary: str
) -> None:
    """已接纳 Java 块范围保留源码物理分行，空分隔符不制造注释分子且末尾同线代码不能在遮罩后丢失或错位。"""
    _write(repository, "sample.java", "/*中" + boundary + boundary + "*/ class X {}")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.java", "commentLines": 1, "codeLines": 1}]


@pytest.mark.parametrize(
    "boundary",
    ["\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"],
    ids=["vt", "ff", "fs", "gs", "rs", "nel", "ls", "ps"],
)
def test_java_line_comment_rows_stay_distinct(repository: Path, boundary: str) -> None:
    """真实行注释内的起始物理分行必须保留，正文才能计在下一行且不会与前一条块说明合并或掩盖后续类声明。"""
    body = "中" * 40
    _write(repository, "sample.java", f"/*{body}*/ // {boundary}{body}\nclass X {{}}")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.java", "commentLines": 2, "codeLines": 1}]
    assert report["violations"] == []
    assert report["observedRatio"] == 2 / 3


@pytest.mark.parametrize("source", ["/**/ class X {}", "/*\n *\n */ class X {}", "//\nclass X {}"])
def test_java_empty_formal_delimiters_do_not_inflate_ratio(repository: Path, source: str) -> None:
    """只有正式分隔符和装饰星号的空注释不能制造有效说明行，同线代码仍完整进入分母并使机械门禁保持失败。"""
    _write(repository, "sample.java", source)
    assert _audit(repository)["files"] == [
        {"path": "sample.java", "commentLines": 0, "codeLines": 1}
    ]


@pytest.mark.parametrize(
    "source",
    [
        "//hidden_secret\\u000a class X {}",
        "/*safe*/ /*hidden_secret",
        'class X { String s = """\nhidden_secret',
    ],
)
def test_java_audit_cli_fails_without_partial_json(repository: Path, source: str) -> None:
    """原始转义守卫和成熟语法错误都必须从公开命令失败退出，不能泄露正文或创建含部分文件计数的 JSON 审计报告。"""
    _write(repository, "sample.java", source)
    output = repository / "report.json"
    result = subprocess.run(
        [sys.executable, str(repository / "scripts/comment_audit.py"), "--output", str(output)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert not output.exists()
    assert "hidden_secret" not in result.stderr
    assert result.stdout == ""


def test_java_bare_cr_audit_cli_rejects_without_output(repository: Path) -> None:
    """裸回车后的合法类声明不能被吞进行注释并从代码分母消失，命令即使已有有效输入也必须在写报告前失败。"""
    _write(repository, "a.java", "class A {}\n")
    _write(repository, "z.java", "// hidden_secret\rclass X {}")
    output = repository / "report.json"
    result = subprocess.run(
        [sys.executable, str(repository / "scripts/comment_audit.py"), "--output", str(output)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert not output.exists()
    assert result.stdout == ""
    assert result.stderr == '"z.java": Unsupported Java bare carriage return; line 1\n'


def test_java_same_line_code_and_effective_comment_are_both_counted(repository: Path) -> None:
    """真实说明与类声明共享物理行时分别进入分子和代码分母，空分隔符不增加比例且块首行跳过正式独占的装饰行。"""
    _write(repository, "sample.java", "class X {} /*" + LONG + "*/\n/*\n * " + LONG + "\n */")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.java", "commentLines": 2, "codeLines": 1}]
    assert report["violations"] == []


def test_html_body_preserves_literal_markers_and_physical_code_positions(repository: Path) -> None:
    """
    只移除 HTML 开闭边界并保留正文中的星号、井号和斜杠，物理分行及真实代码注释同行都必须进入各自的计数。
    """
    text = "<p>😀</p><!--\r\n/*#" + LONG + "\u2028*\r\n*/\r\n--><p>尾</p>\r\n<!---->"
    _write(repository, "mixed.html", text)
    report = _audit(repository)
    assert report["files"] == [{"path": "mixed.html", "commentLines": 3, "codeLines": 2}]
    assert report["ratio"] == 0.6
    assert report["violations"] == [
        {
            "path": "mixed.html",
            "line": 6,
            "reason": "Chinese comment first line must contain at least 40 characters",
        }
    ]


@pytest.mark.parametrize(("length", "issues"), [(39, 1), (40, 0), (120, 0), (121, 1)])
def test_html_literal_body_punctuation_contributes_to_unicode_length(
    repository: Path, length: int, issues: int
) -> None:
    """
    首行长度以 HTML 边界以内的 Unicode 码点计算，前置星号属于正文，闭合标签与原文列宽不能替代正文校验。
    """
    text = "<!--*" + "中" * (length - 1) + "--><p>代码</p>"
    _write(repository, "length.html", text)
    report = _audit(repository)
    assert report["files"] == [{"path": "length.html", "commentLines": 1, "codeLines": 1}]
    assert len(report["violations"]) == issues


@pytest.mark.parametrize(
    ("markup", "category"),
    [
        ('<div title="<!--hidden_secret-->"></div>', "Unsupported HTML comment context"),
        ('<script src="/x.js">hidden_secret</script>', "Unsupported inline script"),
    ],
)
def test_html_audit_cli_fails_before_writing_partial_rows(
    repository: Path, markup: str, category: str
) -> None:
    """
    页面已含真实说明也不能放宽后续属性或脚本的资格，公开审计命令必须保留具名路径并在写入任意文件计数之前失败。
    """
    _write(repository, "a.html", "<p>代码</p>")
    _write(repository, "z.html", "<!--" + LONG + "-->" + markup)
    output = repository / "report.json"
    result = subprocess.run(
        [sys.executable, str(repository / "scripts/comment_audit.py"), "--output", str(output)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert not output.exists()
    assert result.stdout == ""
    assert '"z.html": ' + category in result.stderr
    assert "hidden_secret" not in result.stderr
