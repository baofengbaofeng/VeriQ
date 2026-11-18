"""可信注释适配验收直接调用固定成熟语法树，独立列出字符串与正文边界，拒绝坏语法及无法映射原文的字节位置。

合成输入均为数据，不执行脚本；版本漂移和缺包只在受控加载边界注入，实际语法测试仍使用服务环境的正式包。
"""

import importlib
from pathlib import Path
import sys
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))


def _syntax() -> Any:
    """延迟导入正式适配模块以便旧实现给出缺失能力的红测，解析成功后的区间必须逐项符合独立声明的预期值。"""
    return importlib.import_module("comment_syntax")


@pytest.mark.parametrize(
    ("language", "source", "expected"),
    [
        ("shell", "#!/bin/sh\nprintf '#数据' #真实", ["#真实"]),
        ("shell", '#!/bin/sh\nx="#数据"\n#真实', ["#真实"]),
        ("shell", "#!/bin/sh\ncat <<EOF\n#数据\nEOF\n#真实", ["#真实"]),
        ("shell", "#!/bin/sh\ncat <<'EOF'\n#数据 $(echo '#数据')\nEOF\n#真实", ["#真实"]),
        ("shell", '#!/bin/sh\ncat <<"EOF"\n#数据\nEOF\n#真实', ["#真实"]),
        ("shell", "#!/bin/sh\ncat <<-EOF\n\t#数据\n\tEOF\n#真实", ["#真实"]),
        ("shell", "#!/bin/sh\nx=$(cat <<'EOF'\n中😀# $(printf '#数据')\nEOF\n)\n#真实", ["#真实"]),
        ("shell", "#!/usr/bin/env bash\nx=${value#prefix}\n#真实", ["#真实"]),
        ("css", 'a { content: "/*数据*/"; } /*真实*/', ["/*真实*/"]),
        ("css", "a { content: '/*数据*/'; } /**真实*/", ["/**真实*/"]),
        ("css", 'a { x: url("https://a/中/*数据*/"); } /*真实*/', ["/*真实*/"]),
        ("css", "a { x: url('https://a/😀/*数据*/'); } /*真实*/", ["/*真实*/"]),
        ("css", "a { x: url(https://a/中//path); } /*真实*/", ["/*真实*/"]),
        ("css", "/*真实*/", ["/*真实*/"]),
        ("css", "", []),
        ("shell", "", []),
        ("css", "/* */\n/**/", ["/* */", "/**/"]),
    ],
)
def test_mature_parser_ignores_literal_markers(
    language: str, source: str, expected: list[str]
) -> None:
    """引号、地址及多种 heredoc 中的标记必须保持数据身份，成熟语法树只返回真实注释而首行解释器指令保留为代码。"""
    spans = _syntax().comment_ranges(source.encode(), language, "sample")
    assert [span["text"] for span in spans] == expected
    for span in spans:
        assert source[span["offsetCodePoint"] : span["limitCodePoint"]] == span["text"]
        assert source.encode()[span["offsetByte"] : span["limitByte"]] == span["text"].encode()


@pytest.mark.parametrize(
    ("source", "language", "expected"),
    [
        ('a{x:"😀";}/*中😀文*/', "css", (12, 26, 9, 16, 1, 1)),
        ("class X {} /*中😀文*/", "java", (11, 25, 11, 18, 1, 1)),
        ("class X {}\r\n/*中😀文*/", "java", (12, 26, 12, 19, 2, 2)),
        ('a{x:"😀";}\r\n/*中😀文*/', "css", (14, 28, 11, 18, 2, 2)),
        ("#!/bin/sh\r\nprintf '😀'; #中😀文", "shell", (26, 37, 23, 27, 2, 2)),
        ("/*中\r\n😀\r\n*/", "css", (0, 15, 0, 10, 1, 3)),
    ],
)
def test_byte_and_codepoint_spans_preserve_crlf_and_eof(
    source: str, language: str, expected: tuple[int, int, int, int, int, int]
) -> None:
    """字节与码点坐标须分别指向原始文本，回车换行和补充字符不能让遮罩漂移，结束行以最后一个实际字符所在物理行为准。"""
    (span,) = _syntax().comment_ranges(source.encode(), language, "sample")
    assert (
        tuple(
            span[key]
            for key in (
                "offsetByte",
                "limitByte",
                "offsetCodePoint",
                "limitCodePoint",
                "start",
                "end",
            )
        )
        == expected
    )


@pytest.mark.parametrize(
    ("language", "source"),
    [
        ("shell", "#!/bin/sh\ncat <<'EOF'\n#hidden_secret"),
        ("shell", "#!/bin/sh\nprintf 'hidden_secret"),
        ("shell", "#!/bin/sh\nif true; then\necho hidden_secret\n"),
        ("css", "/*hidden_secret"),
        ("css", 'a{x:"hidden_secret}'),
        ("css", "/* valid */ a { hidden_secret: ; } }"),
    ],
)
def test_errors_and_missing_nodes_fail_without_partial_ranges(language: str, source: str) -> None:
    """未闭合正文、引号和缺失节点必须使整次解析拒绝，先有合法注释不能导致部分成功，诊断不能复制输入中的敏感标记。"""
    with pytest.raises(ValueError) as caught:
        _syntax().comment_ranges(source.encode(), language, "path\n" + "x" * 300)
    message = str(caught.value)
    assert "hidden_secret" not in message
    assert "\n" not in message
    assert len(message) < 300
    assert "line" in message


def test_invalid_utf8_is_rejected_before_parsing() -> None:
    """不可解码字节必须以有界英文错误拒绝，不能使用替换字符继续计算注释比例或泄露解码失败位置附近的原始数据。"""
    with pytest.raises(ValueError, match="Invalid UTF-8"):
        _syntax().comment_ranges(b"/*hidden_secret\xff*/", "css", "sample.css")


@pytest.mark.parametrize(
    "package", ["tree-sitter", "tree-sitter-bash", "tree-sitter-css", "tree-sitter-java"]
)
def test_exact_version_drift_fails_closed(monkeypatch: pytest.MonkeyPatch, package: str) -> None:
    """任何已冻结解析包的版本漂移都必须阻止适配器输出范围，测试只替换发行元数据而不模拟真实语法树或注释位置。"""
    metadata = importlib.import_module("importlib.metadata")
    original = metadata.version
    monkeypatch.setattr(
        metadata, "version", lambda name: "0.0.0" if name == package else original(name)
    )
    with pytest.raises(ValueError, match="Parser version mismatch"):
        _syntax().comment_ranges(b"/* actual */", "css", "sample.css")


@pytest.mark.parametrize("name", ["tree_sitter", "tree_sitter_css", "tree_sitter_java"])
def test_missing_parser_import_fails_closed(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    """核心或当前语言包不能加载时须明确报错，失败路径不得返回空范围，也不依赖全局偶然存在的另一版本作为回退。"""
    original = importlib.import_module

    def unavailable(module: str, package: str | None = None) -> Any:
        if module == name:
            raise ImportError("hidden_secret")
        return original(module, package)

    monkeypatch.setattr(importlib, "import_module", unavailable)
    with pytest.raises(ValueError, match="Parser dependency unavailable") as caught:
        _syntax().comment_ranges(
            b"/* actual */", "java" if name == "tree_sitter_java" else "css", "sample.css"
        )
    assert "hidden_secret" not in str(caught.value)


def test_incompatible_core_abi_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """核心声明的兼容范围不足以接纳冻结语法 ABI 时必须拒绝，不能仅凭构造器暂时接受便忽略安装环境已经漂移的事实。"""
    core = importlib.import_module("tree_sitter")
    monkeypatch.setattr(core, "LANGUAGE_VERSION", 14)
    with pytest.raises(ValueError, match="Parser ABI mismatch"):
        _syntax().comment_ranges(b"/* actual */", "css", "sample.css")


@pytest.mark.parametrize(
    "spans",
    [
        [(1, 4, b"bad")],
        [(0, 2, b"\xe4\xb8")],
        [(0, 3, b"bad")],
        [(0, 3, "中".encode()), (0, 3, "中".encode())],
        [(0, 99, b"bad")],
    ],
)
def test_invalid_ranges_cannot_mask_source(spans: list[tuple[int, int, bytes]]) -> None:
    """越界、重叠、码点内部和原文字节不一致的范围必须全部拒绝，防止错误解析坐标进入消费者后遮掉真实代码。"""
    with pytest.raises(ValueError, match="Invalid comment span"):
        _syntax().convert_ranges("中/*文*/".encode(), spans, "sample.css")


@pytest.mark.parametrize(
    "source",
    [
        "a { x: url(foo/*hidden_secret*/bar); } /*safe*/",
        "a { x: URL(foo/*hidden_secret*/bar); }",
        'a { x: url("value" /*hidden_secret*/); }',
        "a { color: /*hidden_secret*/ red; }",
        "a { x: calc(1 /*hidden_secret*/ + 2); }",
    ],
)
def test_css_ambiguous_comment_contexts_fail_closed(source: str) -> None:
    """成熟语法仍会误标未引号地址内的标记，因此仅接纳顶层或普通块注释，函数及声明上下文须显式拒绝而不能静默抬分。"""
    with pytest.raises(ValueError, match="Unsupported CSS comment context") as caught:
        _syntax().comment_ranges(source.encode(), "css", "ambiguous.css")
    assert "hidden_secret" not in str(caught.value)


def test_css_top_level_and_direct_block_comments_remain_supported() -> None:
    """保守上下文限定仍须接纳顶层与普通规则块中的真实说明，不能通过关闭整个样式族或删除源码路径来掩盖解析器边界。"""
    source = "/*top*/ a { /*block*/ color: red; } /*tail*/"
    spans = _syntax().comment_ranges(source.encode(), "css", "sample.css")
    assert [span["text"] for span in spans] == ["/*top*/", "/*block*/", "/*tail*/"]


@pytest.mark.parametrize("newline", ["\r", "\u2028", "\r\n"])
def test_span_lines_follow_consumer_physical_lines(newline: str) -> None:
    """样式注释中的物理换行须遵循消费者既有分行定义，不能直接使用语法树仅按换行字节累计的行号来定位有效正文。"""
    (span,) = _syntax().comment_ranges(("/*中" + newline + "😀*/").encode(), "css", "sample.css")
    assert (span["start"], span["end"]) == (1, 2)


def test_shell_crlf_comment_retains_raw_carriage_return() -> None:
    """脚本注释节点可能包含回车字符，适配器必须保留成熟语法原始字节并确保整段范围仍归属于正确的单个物理行。"""
    (span,) = _syntax().comment_ranges("#!/bin/sh\r\n#中😀\r\n".encode(), "shell", "sample.sh")
    assert span["text"] == "#中😀\r"
    assert (span["start"], span["end"]) == (2, 2)


def test_escaped_css_url_is_rejected_without_custom_name_normalization() -> None:
    """转义函数名无需自制归一化即可依据成熟树的注释上下文拒绝，不能把未引号地址正文误当可信说明或回退猜测。"""
    source = r"a { x: u\72l(foo/*hidden_secret*/bar); }"
    with pytest.raises(ValueError, match="Unsupported CSS comment context") as caught:
        _syntax().comment_ranges(source.encode(), "css", "escaped.css")
    assert "hidden_secret" not in str(caught.value)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('class X { String s = """\r\n/*data😀*/\r\n"""; } /*中😀文*/', ["/*中😀文*/"]),
        ('class X { String s = "\\\\U0061"; }\r\n//中😀文', ["//中😀文"]),
        ('class X { String s = "/*data*/"; } //真实', ["//真实"]),
    ],
)
def test_java_mature_ranges_keep_literals_and_original_coordinates(
    source: str, expected: list[str]
) -> None:
    """正式语法区分文本块和普通引号内的伪标记，真实注释在回车换行和补充字符之后仍准确指向未经预处理的原始坐标。"""
    spans = _syntax().comment_ranges(source.encode(), "java", "sample.java")
    assert [span["text"] for span in spans] == expected
    for span in spans:
        assert source[span["offsetCodePoint"] : span["limitCodePoint"]] == span["text"]
        assert source.encode()[span["offsetByte"] : span["limitByte"]] == span["text"].encode()
        assert span["start"] == source[: span["offsetCodePoint"]].count("\n") + 1


@pytest.mark.parametrize(
    "source",
    [
        b"//hidden_secret\\u000a class X {}",
        b"//hidden_secret\\uuuu000a class X {}",
        b'class X { String s = "\\\\u0061"; }',
        b"/*hidden_secret\\uXYZQ*/ class X {}",
        b'class X { String s = """\n\\u0061\n"""; }',
    ],
)
def test_java_raw_unicode_marker_is_rejected_before_parser(
    monkeypatch: pytest.MonkeyPatch, source: bytes
) -> None:
    """原始小写标记无论资格和所在语法位置都须先拒绝，合法转义字面量也保守失败且不能调用解析器或返回部分注释。"""

    def forbidden(language: str, path: str) -> Any:
        pytest.fail(f"Parser constructed for guarded input: {language}, {path}")

    monkeypatch.setattr(_syntax(), "_parser", forbidden)
    with pytest.raises(ValueError, match="Unsupported Java Unicode escape") as caught:
        _syntax().comment_ranges(source, "java", "sample.java")
    assert "hidden_secret" not in str(caught.value)


@pytest.mark.parametrize(
    "source",
    [
        b"// explanation\rclass X {}",
        b"class X { // explanation\r int field;\n}",
        b'class X { String text = """\nfirst\rsecond\n"""; }',
        b"class X {}\r",
    ],
    ids=["class-after-comment", "field-after-comment", "textblock", "bare-cr-at-eof"],
)
def test_java_bare_cr_rejects_valid_source(source: bytes) -> None:
    """裸回车是 Java 行终止符，无法获信的原始输入必须整份拒绝，避免成熟语法返回包含真实声明的虚假行注释范围。"""
    with pytest.raises(ValueError, match="Unsupported Java bare carriage return") as caught:
        _syntax().comment_ranges(source, "java", "sample.java")
    assert str(caught.value) == '"sample.java": Unsupported Java bare carriage return; line 1'


def test_java_bare_cr_is_rejected_before_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    """完整回车换行不能掩盖同一文件稍后出现的裸回车，必须在构造任何语法解析器前拒绝这类混合输入。"""

    def forbidden(language: str, path: str) -> Any:
        pytest.fail(f"Parser constructed for guarded input: {language}, {path}")

    monkeypatch.setattr(_syntax(), "_parser", forbidden)
    with pytest.raises(ValueError, match="Unsupported Java bare carriage return"):
        _syntax().comment_ranges(b"// first\r\n// second\rclass X {}", "java", "sample.java")


@pytest.mark.parametrize(
    "source", ['/* valid */ class X { String s = """\nhidden_secret', "/* valid */ /*hidden_secret"]
)
def test_java_malformed_tree_never_returns_partial_spans(source: str) -> None:
    """已找到真实注释之后的未闭合文本块或块注释仍使整次结果失败，成熟树恢复不能把坏输入交付给比例和排版消费者。"""
    with pytest.raises(ValueError) as caught:
        _syntax().comment_ranges(source.encode(), "java", "sample.java")
    assert "hidden_secret" not in str(caught.value)


@pytest.mark.parametrize("language,abi", [("java", 14), ("shell", 15), ("css", 15)])
def test_exact_language_abi_is_enforced(
    monkeypatch: pytest.MonkeyPatch, language: str, abi: int
) -> None:
    """每族正式解析器必须加载精确已审计的语法版本，其他仍在核心兼容范围内的 ABI 也不能被当成同一冻结语法接受。"""
    core = importlib.import_module("tree_sitter")
    grammar = importlib.import_module(_syntax().GRAMMARS[language])
    assert core.Language(grammar.language()).abi_version == abi
    actual = b"#actual" if language == "shell" else b"/*actual*/"
    assert len(_syntax().comment_ranges(actual, language, "sample")) == 1
    original = core.Language
    other = importlib.import_module("tree_sitter_css" if language == "java" else "tree_sitter_java")
    monkeypatch.setattr(core, "Language", lambda capsule: original(other.language()))
    with pytest.raises(ValueError, match="Parser ABI mismatch"):
        _syntax().comment_ranges(b"/*actual*/", language, "sample")


@pytest.mark.parametrize(
    "name,count",
    [("FixtureController", 13), ("FixtureStore", 12), ("IdentityFilter", 3), ("VeriqExample", 2)],
)
def test_all_actual_java_paths_use_qualified_mature_ranges(name: str, count: int) -> None:
    """四个实际业务夹具保持原字节并由成熟语法交付已观察的真实注释数量，这只验证限定支持域而不执行或编译任何 Java。"""
    path = Path("fixtures/integration/spring-boot-2.3.1/src/main/java/dev/veriq/example") / (
        name + ".java"
    )
    assert (
        len(_syntax().comment_ranges((ROOT / path).read_bytes(), "java", path.as_posix())) == count
    )


def test_java_missing_distribution_metadata_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """语法模块即使能被导入也不能替代正式发行元数据，缺少固定 Java 包身份时必须拒绝范围而不回退偶然可用的代码。"""
    metadata = importlib.import_module("importlib.metadata")
    original = metadata.version

    def unavailable(name: str) -> str:
        if name == "tree-sitter-java":
            raise metadata.PackageNotFoundError(name)
        return str(original(name))

    monkeypatch.setattr(metadata, "version", unavailable)
    with pytest.raises(ValueError, match="Parser dependency unavailable"):
        _syntax().comment_ranges(b"/*actual*/", "java", "sample.java")
