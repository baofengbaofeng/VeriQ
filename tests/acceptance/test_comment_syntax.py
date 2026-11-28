"""可信注释适配验收直接调用固定成熟语法树，独立列出字符串与正文边界，拒绝坏语法及无法映射原文的字节位置。

合成输入均为数据，不执行脚本；版本漂移和缺包只在受控加载边界注入，实际语法测试仍使用服务环境的正式包。
"""

import hashlib
import importlib
from pathlib import Path
import subprocess
import sys
import types
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


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('<div title="/*伪😀*/"></div><!--真实😀-->', (31, 48, 26, 36, 1, 1, "<!--真实😀-->")),
        (
            '<ul>\r\n<li>甲<li>乙</ul><br><img src="/x">😀<!--真实\r\n😀-->',
            (47, 66, 40, 52, 2, 3, "<!--真实\r\n😀-->"),
        ),
        ('<script src="./x.js">\r\n \t</script><!--真实-->', (34, 47, 34, 43, 2, 2, "<!--真实-->")),
    ],
)
def test_html_ranges_keep_raw_bytes_and_allow_void_and_implicit_closure(
    source: str, expected: tuple[int, int, int, int, int, int, str]
) -> None:
    """
    普通属性中的样式字面量不产生注释，空脚本正文与可省略结束标签的页面仍可返回精确字节和物理行边界。
    """
    raw = source.encode()
    (span,) = _syntax().comment_ranges(raw, "html", "sample.html")
    assert (
        span["offsetByte"],
        span["limitByte"],
        span["offsetCodePoint"],
        span["limitCodePoint"],
        span["start"],
        span["end"],
        span["text"],
    ) == expected
    assert raw[span["offsetByte"] : span["limitByte"]] == span["text"].encode()
    assert source[span["offsetCodePoint"] : span["limitCodePoint"]] == span["text"]


@pytest.mark.parametrize(
    "script",
    [
        "<script SRC=/assets/App.js TYPE=module async defer nomodule></script>",
        '<script src="./x.js" type="" crossorigin="anonymous" integrity="sha256-data"></script>',
        '<script src="/x.js" type="text/javascript" referrerpolicy="no-referrer"></script>',
        '<script src="/x.js" type="application/javascript">\f</script>',
    ],
)
def test_html_allows_only_the_documented_external_script_variants(script: str) -> None:
    """
    明确允许的经典脚本和模块属性只作为页面代码保留，源码引用不会执行，外部脚本之后的真实注释仍能通过资格验证。
    """
    source = "<title>标题 &amp; 值</title>" + script + "<p><!--真说明--></p>"
    (span,) = _syntax().comment_ranges(source.encode(), "html", "sample.html")
    assert span["text"] == "<!--真说明-->"
    assert source[span["offsetCodePoint"] : span["limitCodePoint"]] == "<!--真说明-->"


@pytest.mark.parametrize(
    ("markup", "category"),
    [
        ('<div title="<!--hidden_secret-->"></div>', "Unsupported HTML comment context"),
        ("<div title='<!--hidden_secret-->'></div>", "Unsupported HTML comment context"),
        ('<!DOCTYPE html SYSTEM "<!--hidden_secret-->">', "Unsupported HTML doctype|Syntax ERROR"),
        ('<script>const x="<!--hidden_secret-->";/*JS*/</script>', "Unsupported inline script"),
        ('<script src="/x.js"><!--hidden_secret--></script>', "Unsupported inline script"),
        ('<style>a{content:"<!--hidden_secret-->";/*CSS*/}</style>', "Unsupported HTML element"),
        ('<script type="application/unknown" src="/x.js"></script>', "Unsupported script type"),
        ('<script type="application/json" src="/x.js"></script>', "Unsupported script type"),
        ('<script type="MODULE " src="/x.js"></script>', "Unsupported script type"),
        ('<script type="module" href="/x.js"></script>', "Unsupported script attribute"),
        ('<script src="/x.js" href="/y.js"></script>', "Unsupported script attribute"),
        ('<script src="/x.js" ATTR="value"></script>', "Unsupported script attribute"),
        ('<script src="/x.js" SRC="/y.js"></script>', "Duplicate script attribute"),
        ('<script src="/x.js" defer DEFER></script>', "Duplicate script attribute"),
        ('<script src=""></script>', "Unsupported external script src spelling"),
        ("<script src></script>", "Unsupported external script src spelling"),
        ('<script src="/x&#46;js"></script>', "Unsupported external script src spelling"),
        ('<script src="/x\\y.js"></script>', "Unsupported external script src spelling"),
        (
            '<script src="//example.invalid/x.js"></script>',
            "Unsupported external script src spelling",
        ),
        (
            '<script src="https://example.invalid/x.js"></script>',
            "Unsupported external script src spelling",
        ),
        ('<script src="x.js"></script>', "Unsupported external script src spelling"),
        ('<script src="/x y.js"></script>', "Unsupported external script src spelling"),
        ('<script src="/中文.js"></script>', "Unsupported external script src spelling"),
        ('<script src="/x.js">\u00a0</script>', "Unsupported inline script"),
        (
            '<script src="/x.js" data-x="<!--hidden_secret-->"></script>',
            "Unsupported HTML comment context",
        ),
        ("<title><!--hidden_secret--></title>", "Unsupported title RCDATA"),
        ("<title><b>hidden_secret</b></title>", "Unsupported title RCDATA"),
        ("<title/><!--hidden_secret-->", "Unsupported title RCDATA"),
        ("< div><!--hidden_secret--></ div>", "Unsupported HTML tag boundary"),
        ("<script\vsrc=/x.js></script>", "Unsupported HTML tag boundary"),
        ("<script src=/x.js></script\v><!--hidden_secret-->", "Unsupported HTML tag boundary"),
        ('<div style="color:red"></div>', "Unsupported HTML attribute"),
        ("<textarea><!--hidden_secret--></textarea>", "Unsupported HTML element"),
        ("<xmp><!--hidden_secret--></xmp>", "Unsupported HTML element"),
        ("<iframe><!--hidden_secret--></iframe>", "Unsupported HTML element"),
        ("<noembed><!--hidden_secret--></noembed>", "Unsupported HTML element"),
        ("<noframes><!--hidden_secret--></noframes>", "Unsupported HTML element"),
        ("<plaintext><!--hidden_secret--></plaintext>", "Unsupported HTML element"),
        ("<noscript><!--hidden_secret--></noscript>", "Unsupported HTML element"),
        ("<template><!--hidden_secret--></template>", "Unsupported HTML element"),
        ("<svg><!--hidden_secret--></svg>", "Unsupported HTML element"),
        ("<math><!--hidden_secret--></math>", "Unsupported HTML element"),
        ("<unknown-raw><!--hidden_secret--></unknown-raw>", "Unsupported HTML element"),
        ("<svg:svg><!--hidden_secret--></svg:svg>", "Unsupported HTML element|Syntax ERROR"),
        ("<未知>hidden_secret</未知>", "Unsupported HTML element|Syntax ERROR"),
        ('<button ONCLICK="hidden_secret()">x</button>', "Unsupported HTML attribute"),
        ('<div srcdoc="hidden_secret"></div>', "Unsupported HTML attribute"),
        ('<div xmlns:x="hidden_secret"></div>', "Unsupported HTML attribute"),
        ('<div 属性="hidden_secret"></div>', "Unsupported HTML attribute|Syntax ERROR"),
        ("<div>{{hidden_secret}}</div>", "Unsupported HTML template marker"),
        ("<p>{% hidden_secret %}</p>", "Unsupported HTML template marker"),
        ("<p><% hidden_secret %></p>", "Unsupported HTML template marker"),
        ("<p><?hidden_secret?></p>", "Unsupported HTML template marker"),
        ("<p>${hidden_secret}</p>", "Unsupported HTML template marker"),
        ("<!-->hidden_secret-->", "Unsupported HTML comment delimiter|Syntax ERROR"),
        ("<!--hidden_secret--!> still-data -->", "Unsupported HTML comment delimiter|Syntax ERROR"),
        ("<!-- outer <!--hidden_secret-->", "Unsupported HTML comment delimiter|Syntax ERROR"),
    ],
)
def test_html_unqualified_context_cannot_return_earlier_comment(markup: str, category: str) -> None:
    """
    当成熟语法误标属性或输入落在嵌入上下文时必须拒绝完整文档，前面的真实说明不能作为部分结果交付或出现在错误中。
    """
    with pytest.raises(ValueError, match=category) as caught:
        _syntax().comment_ranges(("<!--真实-->" + markup).encode(), "html", "sample.html")
    assert str(caught.value).startswith('"sample.html": ')
    assert "hidden_secret" not in str(caught.value)


@pytest.mark.parametrize(
    ("source", "category"),
    [
        (b"<!-- valid --><p>\xff</p>", "Invalid UTF-8"),
        (b"<!-- valid --><div><!--hidden_secret", "Syntax ERROR|Missing syntax node"),
        (b'<!-- valid --><div title="hidden_secret>', "Syntax ERROR|Missing syntax node"),
        (b'<!-- valid --><script type="module" src="/x.js">', "Syntax ERROR"),
        (b'<!-- valid --><script src="/x.js"> </script', "Missing syntax node"),
        (b'<!-- valid --><script src="/x.js"/>', "Unsupported script boundary|Syntax ERROR"),
    ],
)
def test_html_whole_tree_errors_reject_even_a_valid_prefix(source: bytes, category: str) -> None:
    """
    坏字节和未闭合注释、引号或脚本都必须具名拒绝，语法恢复期间找到的真实注释不能成为比例消费者的部分分子。
    """
    with pytest.raises(ValueError, match=category) as caught:
        _syntax().comment_ranges(source, "html", "malformed.html")
    assert "hidden_secret" not in str(caught.value)


@pytest.mark.parametrize("fault", ["missing-metadata", "version", "missing-import", "abi"])
def test_html_parser_dependency_faults_are_named(
    monkeypatch: pytest.MonkeyPatch, fault: str
) -> None:
    """
    固定包元数据、导入与精确语法 ABI 都是独立准入条件，受控故障通过真实接口传播且不会退回其他已安装语法。
    """
    metadata = importlib.import_module("importlib.metadata")
    core = importlib.import_module("tree_sitter")
    css = importlib.import_module("tree_sitter_css")
    original_version = metadata.version
    original_import = importlib.import_module
    original_language = core.Language

    def version(name: str) -> str:
        """
        只在目标发行包模拟逐渐失效的元数据，现有依赖继续调用真实查询，确保失败由新增语言自己的准入条件触发。
        """
        if name == "tree-sitter-html":
            if fault == "missing-metadata":
                raise metadata.PackageNotFoundError(name)
            if fault == "version":
                return "0.0.0"
        return str(original_version(name))

    def load(name: str, package: str | None = None) -> types.ModuleType:
        """
        仅在目标语法加载时注入不可用异常，保留其余模块和真实元数据，验证诊断不会输出第三方异常中的源码内容。
        """
        if name == "tree_sitter_html" and fault == "missing-import":
            raise ImportError("hidden_secret")
        return original_import(name, package)

    def wrong_language(capsule: object) -> object:
        """
        用实际样式语法的兼容 ABI 模拟错误的语法胶囊，检验版本正确也不能绕开对精确语言 ABI 的核验。
        """
        # 故障替身固定提供样式语法以验证精确版本检查，因此无需读取本应传给核心的正确语法胶囊。
        del capsule
        return original_language(css.language())

    monkeypatch.setattr(metadata, "version", version)
    monkeypatch.setattr(importlib, "import_module", load)
    if fault == "abi":
        monkeypatch.setattr(core, "Language", wrong_language)
    expected = {
        "missing-metadata": "Parser dependency unavailable",
        "version": "Parser version mismatch",
        "missing-import": "Parser dependency unavailable",
        "abi": "Parser ABI mismatch",
    }
    with pytest.raises(ValueError, match=expected[fault]) as caught:
        _syntax().comment_ranges(b"<!-- valid -->", "html", "sample.html")
    assert "hidden_secret" not in str(caught.value)


def test_all_tracked_actual_html_keeps_original_bytes_and_no_comments() -> None:
    """
    工作区跟踪的每个页面都以已知摘要绑定原字节，只有完整成熟语法资格通过且返回零范围才能固定无注释结论。
    """
    expected = {
        "apps/desktop/src/renderer/index.html": "200abad5c14d5758e5601f11e0292eb8159d64adb1befbb541580daf63ceb295",
        "apps/web/index.html": "988c5af3c5d95ddb35359d25ac262049afb20d37a01d39cc310a7e15bed3037c",
        "apps/web/tests/agent-strict-fixture.html": (
            "d7a8c188fddbc1f6e9a721ccb0889cdd140a77c37a8809a1ebf0e38084f8868d"
        ),
        "apps/web/tests/desktop-notifications-fixture.html": (
            "72b3ff7d9fe626e3efd11c1760277de542fa1ae75600c6cb1961deb935269ec4"
        ),
        "apps/web/tests/identity-strict-fixture.html": (
            "73b19cb6c847410b6bfe8a122e7c8627f409f166d2f212586c33eddb0636196f"
        ),
        "apps/web/tests/interaction-fixture.html": "dc64c3ddc545fc17404716ca3f1c925caaa99356c02c2970117a50c9397ffd7e",
        "apps/web/tests/workspace-form-bridge-fixture.html": (
            "faf7a08e494994ffc7e739c12dd968fc1e7351cb969f730d1b5717c2ce17b836"
        ),
        "fixtures/demo-app/index.html": "a18e94a56ac8757946e458abb46686b0dee08729d9dfd46de5417faea80e3d22",
        "index.html": "67c01c1e0307516026197e1186cb6a1b634689c6929b3067b92b5c6329526658",
    }
    paths = subprocess.check_output(["git", "ls-files", "-z", "--", "*.html"], cwd=ROOT)
    assert paths.decode().split("\0") == [*expected, ""]
    syntax = _syntax()
    for name, digest in expected.items():
        raw = (ROOT / name).read_bytes()
        assert raw and hashlib.sha256(raw).hexdigest() == digest
        assert syntax.comment_ranges(raw, "html", name) == []


def test_html_root_error_flag_prevents_partial_ranges(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    即使现有子节点都可以验证，完整语法树的错误标志仍阻断结果，故障替身只改变单独节点无法解释的根状态。
    """
    syntax = _syntax()
    core = importlib.import_module("tree_sitter")
    grammar = importlib.import_module("tree_sitter_html")
    parser = core.Parser(core.Language(grammar.language()))
    source = b"<!-- valid --><p>outside</p>"
    root = parser.parse(source).root_node
    assert not root.has_error
    flagged_root = types.SimpleNamespace(
        children=root.children,
        has_error=True,
        is_error=root.is_error,
        is_missing=root.is_missing,
        start_point=root.start_point,
    )

    def flagged_parser(language: str, path: str) -> types.SimpleNamespace:
        """
        保留真实树及它的完整子节点列表，仅模拟语法层的顶层错误状态，验证检测器没有把可读取范围当成语法成功。
        """
        # 替身复用固定语言和路径的真实节点，只覆盖根节点的错误标志，无需用参数重新选择解析器。
        del language, path

        def parse(raw: bytes) -> types.SimpleNamespace:
            """
            固定夹具的原始字节必须保持相同，封装只覆盖语法树的错误标志并把真实节点交给共享遍历。
            """
            assert raw == source
            return types.SimpleNamespace(root_node=flagged_root)

        return types.SimpleNamespace(parse=parse)

    monkeypatch.setattr(syntax, "_parser", flagged_parser)
    with pytest.raises(ValueError, match="Syntax error"):
        syntax.comment_ranges(source, "html", "sample.html")
