"""块注释排版验收覆盖分隔符独占行与原始字符串保护，真实临时仓库同时验证生成源码只能检查而不能被修复器改写。

注释正文长度和解释质量属于独立门禁；这里的短夹具只验证词法与排版行为，不代替仓库源码的有效说明。
"""

import importlib.util
from pathlib import Path
import subprocess
import sys
import types
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/comment_blocks.py"


@pytest.fixture(name="formatter")
def formatter_fixture(monkeypatch: pytest.MonkeyPatch) -> Any:
    """验收直接加载实际排版工具及其共享源码枚举器，保持输入处理与正式命令一致而不在测试中复制格式化算法。"""
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("veriq_comment_blocks", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("opening", ["/**", "/*", "/*!"])
def test_delimiters_and_body_have_separate_lines(formatter: Any, opening: str) -> None:
    """三种独立块注释均把分隔符与正文拆开而不替换注释种类，正文在首次换行后使用一致的星号前缀。"""
    original = opening + " first line\n * second line */"
    expected = opening + "\n * first line\n * second line\n */"
    assert formatter.normalize_block(original) == expected
    assert formatter.normalize_block(expected) == expected


def test_normalization_preserves_relative_code_indentation(formatter: Any) -> None:
    """文档中的段落空行和代码示例相对缩进必须保留，整理源码缩进时不能抹掉 Markdown 代码块所依赖的正文空格。"""
    original = "/** first\n     *\n     *     const value = 1;\n     */"
    expected = "/**\n     * first\n     *\n     *     const value = 1;\n     */"
    assert formatter.normalize_block(original, "    ") == expected


def test_crlf_and_empty_blocks_keep_a_stable_layout(formatter: Any) -> None:
    """现存回车换行不应在注释局部修改时被整段转成另一种换行，空注释也使用分隔符独占行且不会生成占位正文。"""
    assert formatter.normalize_block("/** first\r\n * second\r\n */") == (
        "/**\r\n * first\r\n * second\r\n */"
    )
    assert formatter.normalize_block("/** */") == "/**\n *\n */"


@pytest.mark.parametrize(
    "source",
    [
        "return /** annotation */ value;",
        "const value = /** @type {number} */ (1);",
        "/* prettier-ignore */\nconst value = 1;",
        "/* biome-ignore lint/style: deliberate fixture */\nconst value = 1;",
        "const value = import(/* @vite-ignore */ target);",
    ],
)
def test_inline_annotations_and_tool_directives_are_preserved(formatter: Any, source: str) -> None:
    """行内注解和工具指令不能因统一文档排版而改变含义，尤其不得在 return 与表达式之间新增触发自动分号的换行。"""
    assert formatter.replacements(source, formatter.native_ranges(source)) == []


@pytest.mark.parametrize(
    "source",
    ["return /** explanation */ value;", "const value = 1; /* explanation */"],
)
def test_inline_explanations_are_reported_without_automatic_rewriting(
    formatter: Any, source: str
) -> None:
    """不能自动换行的行内说明仍须被检查器报告违规，修复清单保持空以防 return 或预处理指令因插入换行改变行为。"""
    ranges = formatter.native_ranges(source)
    assert len(formatter.inline_violations(source, ranges)) == 1
    assert formatter.replacements(source, ranges) == []


def test_vite_directives_are_exempt_from_inline_relocation(formatter: Any) -> None:
    """Vite 的动态导入注解必须留在实际导入表达式中供构建器识别，格式门禁不能误当普通说明移动它或要求修改正文。"""
    source = "const value = import(/* @vite-ignore */ target);"
    ranges = formatter.native_ranges(source)
    assert formatter.inline_violations(source, ranges) == []


@pytest.mark.parametrize(
    "literal",
    [
        'const char* value = "\\" /** literal */";',
        'const char* value = R"tag(/** literal */)tag";',
        'const char* value = u8R"tag(/** literal */)tag";',
        'NSString* value = @"/** literal */";',
        'String value = """\n/** literal */\n""";',
    ],
)
def test_native_literals_do_not_become_comments(formatter: Any, literal: str) -> None:
    """原生普通字符串、带分隔符的原始字符串和 Java 文本块中的注释样本必须保持数据身份，不能被扫描成源码说明。"""
    source = literal + "\n/** real comment */\n"
    spans = formatter.native_ranges(source)
    assert len(spans) == 1
    assert source[spans[0]["offsetCodePoint"] : spans[0]["limitCodePoint"]] == "/** real comment */"


def test_stylesheet_urls_do_not_hide_following_comments(formatter: Any) -> None:
    """样式源码中的双斜线不是脚本行注释，出现网络地址后仍须继续识别后面的真实块注释而不能跳过整个物理行。"""
    source = 'a { background: url("https://example.test/path"); } /** real comment */'
    spans = formatter.native_ranges(source, styles=True)
    assert len(spans) == 1


def test_typescript_parser_preserves_templates_regex_and_surrogate_offsets(
    formatter: Any, tmp_path: Path
) -> None:
    """脚本中的模板、正则和补充字符必须由正式 TypeScript 桥接区分，码点坐标应准确定位真正的块注释并保留其余字节。"""
    source = (
        'const face = "😀";\n'
        "const pattern = /\\/\\*\\* literal \\*\\//g;\n"
        "const template = `/** literal */ ${1 + 2}`;\n"
        "/** real comment */\n"
        "export const value = 1;\n"
    )
    (tmp_path / "sample.ts").write_text(source)
    ranges = formatter.comment_ranges(tmp_path, [Path("sample.ts")])
    edits = formatter.replacements(source, ranges["sample.ts"])
    assert len(edits) == 1
    start, end, replacement = edits[0]
    assert source[start:end] == "/** real comment */"
    assert source[:start] + replacement + source[end:] == source.replace(
        "/** real comment */\n", "/**\n * real comment\n */\n"
    )


@pytest.fixture(name="repository")
def repository_fixture(tmp_path: Path) -> Path:
    """每项命令验收都创建真实临时 Git 仓库以验证文件选择和退出码，避免通过模拟枚举提前丢弃生成源码或未跟踪文件。"""
    subprocess.run(["git", "init", "-q", "--template=", str(tmp_path)], check=True)
    return tmp_path


def _run(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    """调用实际命令入口并收集诊断和返回状态，格式检查不能只在直接函数调用中成功而忽略公开命令的失败语义。"""
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


def test_fix_is_idempotent_and_honors_scope(repository: Path) -> None:
    """修复只作用于选定目录中的真实源码并在第二次调用保持字节不变，其他目录及被忽略依赖不应被顺手修改。"""
    (repository / "selected").mkdir()
    source = repository / "selected/source.java"
    source.write_text("/** actual documentation */\nclass Example {}\n")
    other = repository / "other.java"
    other.write_text("/** other documentation */\nclass Other {}\n")
    (repository / ".gitignore").write_text("node_modules/\n")
    (repository / "node_modules").mkdir()
    dependency = repository / "node_modules/dependency.java"
    dependency.write_text("/** dependency documentation */\nclass Dependency {}\n")
    assert _run(repository, "selected").returncode == 1
    assert _run(repository, "--fix", "selected").returncode == 0
    expected = "/**\n * actual documentation\n */\nclass Example {}\n"
    assert source.read_text() == expected
    assert _run(repository, "--fix", "selected").returncode == 0
    assert source.read_text() == expected
    assert other.read_text() == "/** other documentation */\nclass Other {}\n"
    assert dependency.read_text() == "/** dependency documentation */\nclass Dependency {}\n"
    remaining = _run(repository)
    assert remaining.returncode == 1
    assert "other.java:1:" in remaining.stdout
    assert "dependency.java" not in remaining.stdout


def test_generated_sources_are_checked_but_never_rewritten(repository: Path) -> None:
    """生成文件的格式问题仍须产生非零退出而不能被自动忽略，显式修复也必须保留原字节并交由生成器更新以维持来源约束。"""
    source = repository / "schema.generated.java"
    original = "/** generated documentation */\nclass Generated {}\n"
    source.write_text(original)
    result = _run(repository, "--fix")
    assert result.returncode == 1
    assert "schema.generated.java:1:" in result.stdout
    assert source.read_text() == original


def test_unparseable_native_comment_is_not_reported_as_clean(repository: Path) -> None:
    """未闭合的原生注释必须使扫描明确失败而不能给出零违规成功，调用者才能区分需要修复的源码和已经完成的排版。"""
    (repository / "broken.cc").write_text("/** unterminated")
    result = _run(repository)
    assert result.returncode == 2
    assert "could not parse" in result.stderr


def test_fix_rejects_inline_explanations_and_leaves_code_unchanged(repository: Path) -> None:
    """公开修复命令遇到真实行内说明必须继续返回违规状态且保留源码字节，避免仅跳过自动修复后对调用者伪报成功。"""
    source = repository / "inline.cc"
    original = "int value = 1; /** explanation */\n"
    source.write_text(original)
    result = _run(repository, "--fix")
    assert result.returncode == 1
    assert "inline explanatory block comment requires manual placement" in result.stdout
    assert source.read_text() == original


@pytest.mark.parametrize("extension", [".html", ".sql", ".go", ".rs", ".swift", ".tpl"])
def test_unsupported_block_languages_fail_explicitly(repository: Path, extension: str) -> None:
    """
    块标记所在的未接入语言及 HTML 内联脚本都须报告具体类别并保留原文件，以免把未验证能力当作排版成功。
    """
    source = repository / ("source" + extension)
    original = "/** documentation marker */\n"
    category = "unsupported source language requires a block-comment parser"
    if extension == ".html":
        original = "<script>" + original + "</script>"
        category = "Unsupported inline script"
    source.write_text(original)
    result = _run(repository, "--fix")
    assert result.returncode == 2
    assert category in result.stderr
    assert source.read_text() == original


def test_css_parser_preserves_unquoted_url_and_string_markers(
    formatter: Any, repository: Path
) -> None:
    """样式排版必须消费成熟语法范围，普通未引号地址与字符串伪注释不可改写，只有独立真实说明进入分隔符修复。"""
    source = (
        'a { x: url(https://a/中//path); content: "/*数据😀*/"; }\r\n' + "/** real comment */\r\n"
    )
    path = repository / "sample.css"
    path.write_bytes(source.encode())
    spans = formatter.comment_ranges(repository, [Path("sample.css")])["sample.css"]
    assert [item["text"] for item in spans] == ["/** real comment */"]
    assert _run(repository, "--fix").returncode == 0
    expected = source.replace("/** real comment */", "/**\n * real comment\n */")
    assert path.read_bytes() == expected.encode()
    assert _run(repository, "--fix").returncode == 0
    assert path.read_bytes() == expected.encode()


@pytest.mark.parametrize("source", ['/* valid */ a{x:"hidden_secret}', "/*hidden_secret"])
def test_css_parse_failure_cannot_rewrite_earlier_comments(repository: Path, source: str) -> None:
    """样式语法错误必须在任何修复写入前中止，即使前面已有可排版注释也保留原字节，英文诊断不得包含源码敏感标记。"""
    path = repository / "broken.css"
    path.write_bytes(source.encode())
    result = _run(repository, "--fix")
    assert result.returncode == 2
    assert path.read_bytes() == source.encode()
    assert "hidden_secret" not in result.stderr


def test_css_ambiguous_url_refuses_all_rewrites(repository: Path) -> None:
    """未引号地址的标记存在成熟语法歧义时修复器必须明确拒绝，前面的普通注释也不能先被改写后才发现范围不可信。"""
    source = "/** safe */\na { x: url(foo/*hidden_secret*/bar); }\n"
    path = repository / "ambiguous.css"
    path.write_bytes(source.encode())
    result = _run(repository, "--fix")
    assert result.returncode == 2
    assert "Unsupported CSS comment context" in result.stderr
    assert "hidden_secret" not in result.stderr
    assert path.read_bytes() == source.encode()


@pytest.mark.parametrize(
    ("source", "guard"),
    [
        ("//hidden_secret\\u000a class X {}", "Unsupported Java Unicode escape"),
        ("/*safe*/ /*hidden_secret", None),
        ('class X { String s = """\nhidden_secret', None),
        ("class X {}\r/** hidden_secret */\rclass Y {}", "Unsupported Java bare carriage return"),
    ],
)
def test_java_fix_rejects_guard_or_syntax_without_any_writes(
    repository: Path, source: str, guard: str | None
) -> None:
    """修复入口在任何文件写入之前完成全体可信范围检查，坏 Java 不能触发旧原生扫描旁路或提前改写另一个有效文件。"""
    good = repository / "a.java"
    good.write_text("/** actual documentation */\nclass X {}\n")
    bad = repository / "z.java"
    bad.write_bytes(source.encode())
    before = {path: path.read_bytes() for path in (good, bad)}
    result = _run(repository, "--fix")
    assert result.returncode == 2
    assert result.stdout == ""
    assert "hidden_secret" not in result.stderr
    if guard is not None:
        assert result.stderr == f'"z.java": {guard}; line 1\n'
    assert {path: path.read_bytes() for path in before} == before


@pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
def test_java_block_cli_formats_lf_and_crlf(repository: Path, newline: str) -> None:
    """独立说明块在常见两种换行中仍会实际排版，已经存在的块内换行种类以及相邻类声明原字节都应保留。"""
    path = repository / "sample.java"
    path.write_bytes(
        newline.join(["class X {}", "/** documentation", " */", "class Y {}"]).encode()
    )
    result = _run(repository, "--fix")
    assert result.returncode == 0, result.stderr
    assert (
        path.read_bytes()
        == newline.join(["class X {}", "/**", " * documentation", " */", "class Y {}"]).encode()
    )


def test_java_textblock_and_emoji_keep_real_block_only(formatter: Any, tmp_path: Path) -> None:
    """成熟语法必须跳过文本块中的伪注释并定位补充字符之后的独立真实块，排版修改只能影响正式注释而保留其他源字节。"""
    source = 'class X { String s = """\r\n/*literal😀*/\r\n"""; }\r\n/**真实*/'
    (tmp_path / "sample.java").write_bytes(source.encode())
    spans = formatter.comment_ranges(tmp_path, [Path("sample.java")])["sample.java"]
    assert len(spans) == 1
    start, end, replacement = formatter.replacements(source, spans)[0]
    assert source[start:end] == "/**真实*/"
    assert source[:start] + replacement + source[end:] == source.replace(
        "/**真实*/", "/**\n * 真实\n */"
    )


def test_html_block_consumer_checks_mature_ranges_without_writing(
    formatter: types.ModuleType, repository: Path
) -> None:
    """
    正式 HTML 注释原始区间要传到块消费者，修复入口必须完整保留这些边界与其中的样式标记及物理换行字节。
    """
    source = repository / "page.html"
    raw = '<div title="/*数据*/">😀</div><!-- /*真实*/\r\n#* -->'.encode()
    source.write_bytes(raw)
    result = _run(repository, "--fix")
    assert result.returncode == 0, result.stderr
    assert "0 files formatted" in result.stdout
    assert source.read_bytes() == raw
    (span,) = formatter.comment_ranges(repository, [Path("page.html")])["page.html"]
    assert span["text"] == "<!-- /*真实*/\r\n#* -->"
    assert (span["start"], span["end"]) == (1, 2)
    assert raw[span["offsetByte"] : span["limitByte"]] == span["text"].encode()


def test_html_block_consumer_rejects_without_c_marker_or_partial_fix(repository: Path) -> None:
    """
    真实说明之后的属性伪注释须触发同一成熟语法拒绝，即使完全没有斜杠星号，失败也必须发生在更早文件修复之前。
    """
    good = repository / "a.css"
    good.write_bytes(b"/* would format */")
    bad = repository / "z.html"
    raw = b'<!-- valid --><div title="<!--hidden_secret-->"></div>'
    bad.write_bytes(raw)
    result = _run(repository, "--fix")
    assert result.returncode == 2
    assert result.stdout == ""
    assert '"z.html": Unsupported HTML comment context' in result.stderr
    assert "hidden_secret" not in result.stderr
    assert good.read_bytes() == b"/* would format */"
    assert bad.read_bytes() == raw
