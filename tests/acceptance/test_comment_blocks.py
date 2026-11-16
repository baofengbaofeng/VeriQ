"""块注释排版验收覆盖分隔符独占行与原始字符串保护，真实临时仓库同时验证生成源码只能检查而不能被修复器改写。

注释正文长度和解释质量属于独立门禁；这里的短夹具只验证词法与排版行为，不代替仓库源码的有效说明。
"""

import importlib.util
from pathlib import Path
import subprocess
import sys
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/comment_blocks.py"


@pytest.fixture
def formatter(monkeypatch: pytest.MonkeyPatch) -> Any:
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
def test_inline_explanations_are_reported_without_automatic_rewriting(formatter: Any, source: str) -> None:
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
        'const char* value = "\\\" /** literal */";',
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
    assert source[spans[0]["offsetCodePoint"]:spans[0]["limitCodePoint"]] == "/** real comment */"


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
        'const pattern = /\\/\\*\\* literal \\*\\//g;\n'
        'const template = `/** literal */ ${1 + 2}`;\n'
        '/** real comment */\n'
        'export const value = 1;\n'
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


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    """每项命令验收都创建真实临时 Git 仓库以验证文件选择和退出码，避免通过模拟枚举提前丢弃生成源码或未跟踪文件。"""
    subprocess.run(["git", "init", "-q", "--template=", str(tmp_path)], check=True)
    return tmp_path


def _run(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    """调用实际命令入口并收集诊断和返回状态，格式检查不能只在直接函数调用中成功而忽略公开命令的失败语义。"""
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), *arguments],
        capture_output=True,
        text=True,
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
    """未接入解析器的语言出现块注释标记时须明确失败并保留原文件，不能把未检查的源码当作格式合格或猜测字符串上下文。"""
    source = repository / ("source" + extension)
    original = "/** documentation marker */\n"
    source.write_text(original)
    result = _run(repository, "--fix")
    assert result.returncode == 2
    assert "unsupported source language requires a block-comment parser" in result.stderr
    assert source.read_text() == original
