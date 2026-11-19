"""可信注释适配只消费固定成熟语法树的真实范围，保留原始字节与换行并在语法或坐标不确定时拒绝整次结果。

可选解析包仅在明确请求语言时加载；库存与显示列宽无需这些依赖，也不执行输入或自动下载语法。
"""

from bisect import bisect_right
import collections.abc
import importlib
import importlib.metadata
import json
import re
from typing import TYPE_CHECKING, TypedDict, cast

if TYPE_CHECKING:
    from tree_sitter import Node, Parser

VERSIONS = {
    "tree-sitter": "0.26.1",
    "tree-sitter-bash": "0.25.1",
    "tree-sitter-css": "0.25.0",
    "tree-sitter-java": "0.23.5",
}
GRAMMARS = {
    "shell": "tree_sitter_bash",
    "css": "tree_sitter_css",
    "java": "tree_sitter_java",
    "html": "tree_sitter_html",
}
GRAMMAR_ABIS = {"shell": 15, "css": 15, "java": 14, "html": 14}
COMMENT_KINDS = {
    "shell": {"comment"},
    "css": {"comment"},
    "java": {"line_comment", "block_comment"},
}
HTML_WHITESPACE = b" \t\r\n\f"
HTML_TEMPLATE_MARKERS = (
    b"{{",
    b"}}",
    b"{%",
    b"%}",
    b"<%",
    b"%>",
    b"<?",
    b"?>",
    b"${",
    b"<#",
    b"[#",
)
HTML_ELEMENTS = frozenset(
    b"a abbr address area article aside audio b bdi bdo blockquote body br button canvas caption "
    b"cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset "
    b"figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i img input "
    b"ins kbd label legend li link main map mark menu meta meter nav ol optgroup option output "
    b"p picture pre progress q rp rt ruby s samp script section select small source span strong "
    b"sub summary sup table tbody td th thead time title tr track u ul var video wbr".split()
)
HTML_TAG_NODES = {"start_tag", "end_tag", "self_closing_tag"}
HTML_NODES = HTML_TAG_NODES | {
    "attribute",
    "attribute_name",
    "attribute_value",
    "comment",
    "doctype",
    "document",
    "element",
    "entity",
    "quoted_attribute_value",
    "raw_text",
    "script_element",
    "style_element",
    "tag_name",
    "text",
}
HTML_SCRIPT_ATTRIBUTES = {
    b"src",
    b"type",
    b"async",
    b"defer",
    b"nomodule",
    b"integrity",
    b"crossorigin",
    b"referrerpolicy",
}
HTML_SCRIPT_TYPES = {b"", b"module", b"text/javascript", b"application/javascript"}
HTML_SCRIPT_SRC = re.compile(rb"(?:/|\./)[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*")


class CommentSyntaxError(ValueError):
    """解析环境、源码或坐标无法满足可信范围合同时使用有界错误，调用者不得将异常解释为空注释或继续输出部分报告。"""


def _failure(path: str, category: str, line: int = 1) -> CommentSyntaxError:
    """诊断仅包含截断且转义的路径、固定英文类别及行号，禁止把第三方异常中的源码或敏感字符串传播到命令日志。"""
    name = json.dumps(path, ensure_ascii=True)
    if len(name) > 180:
        name = name[:176] + '..."'
    return CommentSyntaxError(f"{name}: {category}; line {line}")


def _parser(language: str, path: str) -> "Parser":
    """实际需要适配时才核验冻结版本并加载当前语言，核心兼容范围及语法 ABI 必须符合已审计环境才能创建解析器。"""
    try:
        versions = VERSIONS | ({"tree-sitter-html": "0.23.2"} if language == "html" else {})
        for package, version in versions.items():
            if importlib.metadata.version(package) != version:
                raise _failure(path, "Parser version mismatch")
        core = importlib.import_module("tree_sitter")
        grammar = importlib.import_module(GRAMMARS[language])
    except (ImportError, importlib.metadata.PackageNotFoundError):
        raise _failure(path, "Parser dependency unavailable") from None
    try:
        syntax = core.Language(grammar.language())
        if (
            (core.MIN_COMPATIBLE_LANGUAGE_VERSION, core.LANGUAGE_VERSION) != (13, 15)
            or syntax.abi_version != GRAMMAR_ABIS[language]
            or not core.MIN_COMPATIBLE_LANGUAGE_VERSION
            <= syntax.abi_version
            <= core.LANGUAGE_VERSION
        ):
            raise _failure(path, "Parser ABI mismatch")
        return cast("Parser", core.Parser(syntax))
    except (TypeError, ValueError) as error:
        if isinstance(error, CommentSyntaxError):
            raise
        raise _failure(path, "Parser ABI mismatch") from None


class CommentRange(TypedDict):
    """每个范围同时保留原始字节和消费者码点坐标，物理行与原文作为交叉核验依据，避免直接用字节索引遮罩字符串。"""

    offsetByte: int
    limitByte: int
    offsetCodePoint: int
    limitCodePoint: int
    start: int
    end: int
    text: str


def _source_coordinates(source: bytes, path: str) -> tuple[str, dict[int, int], list[int]]:
    """码点边界与物理行末只从未归一化的原文构建，兼容消费者既有分行定义而不依赖语法树仅按换行字节累计的行号。"""
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError:
        raise _failure(path, "Invalid UTF-8") from None
    boundaries = {0: 0}
    byte_offset = 0
    for point, character in enumerate(text, 1):
        byte_offset += len(character.encode("utf-8"))
        boundaries[byte_offset] = point
    line_ends = []
    point_offset = 0
    for line in text.splitlines(keepends=True):
        point_offset += len(line)
        line_ends.append(point_offset)
    return text, boundaries, line_ends


def convert_ranges(
    source: bytes, spans: list[tuple[int, int, bytes]], path: str
) -> list[CommentRange]:
    """先验证完整 UTF8 及每个真实注释区间的边界、顺序和原文，再统一映射码点与物理行，任何一项失败均无部分返回。"""
    text, boundaries, line_ends = _source_coordinates(source, path)
    result: list[CommentRange] = []
    previous = 0
    for start, end, raw in spans:
        if (
            not previous <= start < end <= len(source)
            or start not in boundaries
            or end not in boundaries
            or source[start:end] != raw
        ):
            raise _failure(path, "Invalid comment span")
        offset, limit = boundaries[start], boundaries[end]
        result.append(
            {
                "offsetByte": start,
                "limitByte": end,
                "offsetCodePoint": offset,
                "limitCodePoint": limit,
                "start": bisect_right(line_ends, offset) + 1,
                "end": bisect_right(line_ends, limit - 1) + 1,
                "text": text[offset:limit],
            }
        )
        previous = end
    return result


def _check_css_context(node: "Node", path: str) -> None:
    """样式语法会把未引号地址正文误标为注释，因此仅接纳顶层和普通块的直接子节点，并拒绝任何函数参数祖先。"""
    parent = node.parent
    if parent is None or parent.type not in {"stylesheet", "block"}:
        raise _failure(path, "Unsupported CSS comment context", node.start_point.row + 1)
    while parent is not None:
        if parent.type in {"call_expression", "arguments"}:
            raise _failure(path, "Unsupported CSS comment context", node.start_point.row + 1)
        parent = parent.parent


def _checked_nodes(root: "Node", path: str) -> collections.abc.Iterator["Node"]:
    """
    按原文顺序遍历全部语法节点并在遍历末尾核验根状态，语法恢复留下的错误或缺失节点均不得交付任何可信结果。

    Yields:
        按源码顺序验证过的语法节点，根节点状态在完整消费时一并核验。
    """
    pending = [root]
    while pending:
        node = pending.pop()
        if node.is_missing or node.is_error:
            category = "Missing syntax node" if node.is_missing else "Syntax ERROR"
            raise _failure(path, category, node.start_point.row + 1)
        yield node
        pending.extend(reversed(node.children))
    if root.has_error:
        raise _failure(path, "Syntax error", root.start_point.row + 1)


def _html_comment_span(node: "Node", path: str) -> tuple[int, int, bytes]:
    """
    属性值内的伪注释可能被成熟语法标成真节点，直接父节点和原始边界均须符合限定域才能交给通用坐标转换。
    """
    line = node.start_point.row + 1
    parent = node.parent
    if parent is None or parent.type not in {"document", "element"}:
        raise _failure(path, "Unsupported HTML comment context", line)
    raw = node.text
    if raw is None or not raw.startswith(b"<!--") or not raw.endswith(b"-->"):
        raise _failure(path, "Unsupported HTML comment delimiter", line)
    body = raw[4:-3]
    if (
        len(raw) < 7
        or body.startswith((b">", b"->"))
        or body.endswith(b"<!-")
        or any(marker in body for marker in (b"<!--", b"-->", b"--!>"))
    ):
        raise _failure(path, "Unsupported HTML comment delimiter", line)
    return node.start_byte, node.end_byte, raw


def _html_attribute(node: "Node", source: bytes, path: str) -> tuple[bytes, bytes]:
    """
    属性名只接受普通 ASCII 形态，赋值取自树上原始范围以保留实体和引号边界，供脚本严格核验实际源码拼写。
    """
    line = node.start_point.row + 1
    parts = node.children
    name = parts[0]
    key = source[name.start_byte : name.end_byte].lower()
    if (
        name.type != "attribute_name"
        or not re.fullmatch(rb"[a-z][a-z0-9-]*", key)
        or key.startswith(b"on")
        or key in {b"srcdoc", b"xmlns", b"is", b"style", b"http-equiv"}
    ):
        raise _failure(path, "Unsupported HTML attribute", line)
    if len(parts) == 1:
        return key, b""
    value = parts[-1]
    if len(parts) != 3 or source[name.end_byte : value.start_byte].strip(HTML_WHITESPACE) != b"=":
        raise _failure(path, "Unsupported HTML attribute boundary", line)
    raw = source[value.start_byte : value.end_byte]
    if value.type == "quoted_attribute_value":
        return key, raw[1:-1]
    if value.type != "attribute_value" or not re.fullmatch(rb"[^ \t\r\n\f\"'<>`=]+", raw):
        raise _failure(path, "Unsupported HTML attribute boundary", line)
    return key, raw


def _html_tag(node: "Node", source: bytes, path: str) -> tuple[bytes, dict[bytes, bytes]]:
    """
    复核成熟树给出的标签边界及属性间隔，防止宽松空白把普通文字误解释成标签，也保留已限定的空元素和省略闭合形式。
    """
    line = node.start_point.row + 1
    opening, name, *remaining = node.children
    closing = remaining[-1]
    tag = source[name.start_byte : name.end_byte].lower()
    if name.type != "tag_name" or tag not in HTML_ELEMENTS:
        raise _failure(path, "Unsupported HTML element", line)
    if opening.end_byte != name.start_byte:
        raise _failure(path, "Unsupported HTML tag boundary", line)
    attributes: dict[bytes, bytes] = {}
    last = name.end_byte
    for attribute in remaining[:-1]:
        gap = source[last : attribute.start_byte]
        if attribute.type != "attribute" or not gap or gap.strip(HTML_WHITESPACE):
            raise _failure(path, "Unsupported HTML tag boundary", line)
        key, value = _html_attribute(attribute, source, path)
        if tag == b"script" and key in attributes:
            raise _failure(path, "Duplicate script attribute", line)
        attributes[key] = value
        last = attribute.end_byte
    if source[last : closing.start_byte].strip(HTML_WHITESPACE):
        raise _failure(path, "Unsupported HTML tag boundary", line)
    return tag, attributes


def _check_html_title(start: "Node", path: str) -> None:
    """
    标题在浏览器中使用特殊字符数据状态，仅接纳具有明确开闭标签及文本或实体子节点的标题，以保证正文边界一致。
    """
    parent = start.parent
    children = [child.type for child in parent.named_children] if parent is not None else []
    if (
        start.type != "start_tag"
        or children[-1:] != ["end_tag"]
        or any(kind not in {"text", "entity"} for kind in children[1:-1])
    ):
        raise _failure(path, "Unsupported title RCDATA context", start.start_point.row + 1)


def _check_html_script(
    start: "Node", attributes: dict[bytes, bytes], source: bytes, path: str
) -> None:
    """
    只接受具有明确起止标签和空白正文的外部脚本，路径与类型按原始拼写核验，解析注释时无需加载或理解脚本代码。
    """
    line = start.start_point.row + 1
    parent = start.parent
    if parent is None or parent.type != "script_element":
        raise _failure(path, "Unsupported script boundary", line)
    children = parent.named_children
    if [child.type for child in children] != ["start_tag", "raw_text", "end_tag"]:
        raise _failure(path, "Unsupported script boundary", line)
    end = children[-1]
    if source[start.end_byte : end.start_byte].strip(HTML_WHITESPACE):
        raise _failure(path, "Unsupported inline script or data body", line)
    if attributes.keys() - HTML_SCRIPT_ATTRIBUTES:
        raise _failure(path, "Unsupported script attribute", line)
    if not HTML_SCRIPT_SRC.fullmatch(attributes.get(b"src", b"")):
        raise _failure(path, "Unsupported external script src spelling", line)
    if attributes.get(b"type", b"") not in HTML_SCRIPT_TYPES:
        raise _failure(path, "Unsupported script type", line)


def _check_html_node(node: "Node", source: bytes, path: str) -> None:
    """
    精确限制可信语法节点与公开声明的元素域，文档类型和脚本边界由完整树给出，未知节点不能作为空注释继续计量。
    """
    if node.is_named and node.type not in HTML_NODES:
        raise _failure(path, "Unsupported HTML syntax context", node.start_point.row + 1)
    if node.type == "doctype" and node.is_named:
        raw = source[node.start_byte : node.end_byte]
        if not re.fullmatch(rb"<!doctype[ \t\r\n\f]+html[ \t\r\n\f]*>", raw, re.IGNORECASE):
            raise _failure(path, "Unsupported HTML doctype", node.start_point.row + 1)
    if node.type in HTML_TAG_NODES:
        tag, attributes = _html_tag(node, source, path)
        if node.type == "end_tag":
            return
        if tag == b"title":
            _check_html_title(node, path)
        elif tag == b"script":
            _check_html_script(node, attributes, source, path)


def _html_ranges(source: bytes, root: "Node", path: str) -> list[CommentRange]:
    """
    先查验整棵语法树，再限定每个注释与嵌入上下文；已识别的真实范围等到文档全部通过才交付给两个消费者。
    """
    nodes = tuple(_checked_nodes(root, path))
    spans = [_html_comment_span(node, path) for node in nodes if node.type == "comment"]
    for node in nodes:
        _check_html_node(node, source, path)
    return convert_ranges(source, spans, path)


def comment_ranges(source: bytes, language: str, path: str) -> list[CommentRange]:
    """固定语言的完整语法树必须没有错误或缺失节点才可导出注释，Shell 首行解释器指令不作为说明范围返回给比例消费者。"""
    if language not in GRAMMARS:
        raise _failure(path, "Unsupported source language")
    try:
        source.decode("utf-8")
    except UnicodeDecodeError:
        raise _failure(path, "Invalid UTF-8") from None
    if language == "java" and b"\\u" in source:
        raise _failure(path, "Unsupported Java Unicode escape")
    # 固定 Java 语法把裸回车后的代码吞进行注释，因此在构造任何解析器前拒绝这种原始字节序列。
    if language == "java" and re.search(rb"\r(?!\n)", source):
        raise _failure(path, "Unsupported Java bare carriage return")
    if language == "html" and any(marker in source for marker in HTML_TEMPLATE_MARKERS):
        raise _failure(path, "Unsupported HTML template marker")
    tree = _parser(language, path).parse(source)
    if language == "html":
        return _html_ranges(source, tree.root_node, path)
    spans: list[tuple[int, int, bytes]] = []
    for node in _checked_nodes(tree.root_node, path):
        if node.type in COMMENT_KINDS[language]:
            if language == "css":
                _check_css_context(node, path)
            raw = node.text
            if raw is None:
                raise _failure(path, "Invalid comment span")
            if not (language == "shell" and node.start_byte == 0 and raw.startswith(b"#!")):
                spans.append((node.start_byte, node.end_byte, raw))
    return convert_ranges(source, spans, path)
