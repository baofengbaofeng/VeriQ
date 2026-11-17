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


@pytest.mark.parametrize("package", ["tree-sitter", "tree-sitter-bash", "tree-sitter-css"])
def test_exact_version_drift_fails_closed(monkeypatch: pytest.MonkeyPatch, package: str) -> None:
    """任何已冻结解析包的版本漂移都必须阻止适配器输出范围，测试只替换发行元数据而不模拟真实语法树或注释位置。"""
    metadata = importlib.import_module("importlib.metadata")
    original = metadata.version
    monkeypatch.setattr(
        metadata, "version", lambda name: "0.0.0" if name == package else original(name)
    )
    with pytest.raises(ValueError, match="Parser version mismatch"):
        _syntax().comment_ranges(b"/* actual */", "css", "sample.css")


@pytest.mark.parametrize("name", ["tree_sitter", "tree_sitter_css"])
def test_missing_parser_import_fails_closed(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    """核心或当前语言包不能加载时须明确报错，失败路径不得返回空范围，也不依赖全局偶然存在的另一版本作为回退。"""
    original = importlib.import_module

    def unavailable(module: str, package: str | None = None) -> Any:
        if module == name:
            raise ImportError("hidden_secret")
        return original(module, package)

    monkeypatch.setattr(importlib, "import_module", unavailable)
    with pytest.raises(ValueError, match="Parser dependency unavailable") as caught:
        _syntax().comment_ranges(b"/* actual */", "css", "sample.css")
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
