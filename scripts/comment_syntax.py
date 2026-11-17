"""可信注释适配只消费固定成熟语法树的真实范围，保留原始字节与换行并在语法或坐标不确定时拒绝整次结果。

可选解析包仅在明确请求语言时加载；库存与显示列宽无需这些依赖，也不执行输入或自动下载语法。
"""

from bisect import bisect_right
import importlib
import importlib.metadata
import json
from typing import TYPE_CHECKING, TypedDict, cast

if TYPE_CHECKING:
    from tree_sitter import Node, Parser

VERSIONS = {"tree-sitter": "0.26.1", "tree-sitter-bash": "0.25.1", "tree-sitter-css": "0.25.0"}
GRAMMARS = {"shell": "tree_sitter_bash", "css": "tree_sitter_css"}


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
        for package, version in VERSIONS.items():
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
            or syntax.abi_version != 15
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


def comment_ranges(source: bytes, language: str, path: str) -> list[CommentRange]:
    """固定语言的完整语法树必须没有错误或缺失节点才可导出注释，Shell 首行解释器指令不作为说明范围返回给比例消费者。"""
    if language not in GRAMMARS:
        raise _failure(path, "Unsupported source language")
    try:
        source.decode("utf-8")
    except UnicodeDecodeError:
        raise _failure(path, "Invalid UTF-8") from None
    tree = _parser(language, path).parse(source)
    pending = [tree.root_node]
    spans: list[tuple[int, int, bytes]] = []
    while pending:
        node = pending.pop()
        if node.is_missing or node.is_error:
            category = "Missing syntax node" if node.is_missing else "Syntax ERROR"
            raise _failure(path, category, node.start_point.row + 1)
        if node.type == "comment":
            if language == "css":
                _check_css_context(node, path)
            raw = node.text
            if raw is None:
                raise _failure(path, "Invalid comment span")
            if not (language == "shell" and node.start_byte == 0 and raw.startswith(b"#!")):
                spans.append((node.start_byte, node.end_byte, raw))
        pending.extend(reversed(node.children))
    if tree.root_node.has_error:
        raise _failure(path, "Syntax error", tree.root_node.start_point.row + 1)
    return convert_ranges(source, spans, path)
