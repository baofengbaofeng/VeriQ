"""仓库注释门禁按实际语法中的注释与文档串计算非空行比例，并检查中文及四十字符首行；自动结果只证明可机械验证的条件，
符号职责与解释质量仍须独立代码审查。

仅排除明确生成的合同文件、依赖和私有证据，不排除测试或旧代码。Python 使用 tokenize 与 AST，TypeScript
使用官方解析器区间。缺少解析工具或源码不可解析时直接失败，不输出虚假的零问题结果。
"""

import argparse
import ast
from collections.abc import Sequence
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tokenize
from typing import Any, Literal, NamedTuple, NotRequired, TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parent))
# 发行入口和验收都允许按文件路径加载模块，因此先注册脚本目录再导入同级库存，避免依赖调用方当前目录。
import comment_syntax  # pylint: disable=wrong-import-position
import source_inventory  # pylint: disable=wrong-import-position

GENERATED = source_inventory.GENERATED
_TYPESCRIPT_TERMINATORS = "\r\n\u2028\u2029"
_TYPESCRIPT_ROWS = re.compile(r"\r\n|[" + _TYPESCRIPT_TERMINATORS + "]")
_ADAPTER_TERMINATORS = _TYPESCRIPT_TERMINATORS + "\v\f\x1c\x1d\x1e\x85"
_PYTHON_LAYOUT = {
    tokenize.NL,
    tokenize.NEWLINE,
    tokenize.INDENT,
    tokenize.DEDENT,
    tokenize.ENDMARKER,
}
_PYTHON_TYPE_IGNORE_MARKERS = {
    "[no-any-return]": "# type: ignore[no-any-return]",
    "[arg-type]": "# type: ignore[arg-type]",
}


class _CommentBlock(NamedTuple):
    """
    记录语法范围起始行和逐行原文正文，空白行保留偏移，行注释标记限制只合并相邻的同类型注释。
    """

    start: int
    end: int
    body: list[str]
    is_line: bool


class _CommentRange(TypedDict):
    """
    记录 TypeScript 桥接器给出的原始码点位置与行号，只有经语法确认的固定工具标记携带已知代码角色。
    """

    offsetCodePoint: int
    limitCodePoint: int
    start: int
    end: int
    text: str
    codeDirective: NotRequired[Literal["vite-ignore"]]


type _SourceCommentRange = _CommentRange | comment_syntax.CommentRange


def _nonempty_rows(rows: list[str]) -> set[int]:
    """
    按调用语言已经划分的物理行返回非空行号，代码遮罩和分词结果使用同一坐标以排除纯空白行。
    """
    return {number for number, row in enumerate(rows, 1) if row.strip()}


def _python_position(rows: list[str], line: int, byte_column: int) -> tuple[int, int]:
    """
    将 AST 的行内 UTF8 字节偏移转换成分词器的码点列，确保中文或补充字符前后的真实代码仍在区间之外。
    """
    return line, len(rows[line - 1].encode("utf-8")[:byte_column].decode("utf-8"))


def _python_docstrings(text: str, rows: list[str]) -> dict[tuple[int, int], tuple[int, int]]:
    """
    由 AST 确认四类宿主的首表达式文档串，保存含外层括号的精确起止坐标，普通三引号字面量仍是代码。
    """
    spans = {}
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if ast.get_docstring(node, clean=False) is None:
                continue
            statement = node.body[0]
            assert statement.end_lineno is not None and statement.end_col_offset is not None
            start = _python_position(rows, statement.lineno, statement.col_offset)
            spans[start] = _python_position(rows, statement.end_lineno, statement.end_col_offset)
    return spans


def _add_docstring_body(rows: list[str], offset: int, spelling: str) -> None:
    """
    使用分词器给出的真实字符串拼写去掉前缀及引号，按物理行连接相邻片段，保留转义字符在原文中的位置。
    """
    literal = spelling.lstrip("rRuU")
    width = 3 if literal.startswith(('"""', "'''")) else 1
    for number, row in enumerate(literal[width:-width].split("\n"), offset):
        rows[number] += row


def _python_type_ignore_tags(text: str) -> dict[int, str]:
    """
    提取辅助类型注释语法确认的已知单码标签，解析拒绝某条类型注释时整份源码仍沿用普通说明计量。
    """
    try:
        tree = ast.parse(text, type_comments=True)
    except SyntaxError:
        return {}
    return {
        item.lineno: item.tag
        for item in tree.type_ignores
        if isinstance(item, ast.TypeIgnore) and item.tag in _PYTHON_TYPE_IGNORE_MARKERS
    }


def _python_source(text: str) -> tuple[list[_CommentBlock], set[int]]:
    """
    文档串按完整语法区间扣除对应代码词元，仍单独提取区间内的井号说明，并保留文档串前后的真实同行代码。

    仅已进入代码计数的同行名称、数字或字符串词元可承载辅助语法确认的固定类型检查标记。
    """
    source = io.StringIO(text, newline=None)
    text = source.getvalue()
    rows = text.split("\n")
    spans = _python_docstrings(text, rows)
    tags = _python_type_ignore_tags(text)
    blocks: list[_CommentBlock] = []
    code: set[int] = set()
    host_line = 0
    doc_end = (0, 0)
    doc_start = 0
    doc_body: list[str] = []
    for token in tokenize.generate_tokens(source.readline):
        start, end = token.start, token.end
        if token.type == tokenize.COMMENT:
            if start[0] == host_line and token.string == _PYTHON_TYPE_IGNORE_MARKERS.get(
                tags.get(start[0], "")
            ):
                continue
            blocks.append(_CommentBlock(start[0], end[0], [token.string[1:]], True))
        elif token.type not in _PYTHON_LAYOUT:
            span = spans.pop(start, None)
            if span is not None:
                doc_start, doc_end = start[0], span
                doc_body = [""] * (doc_end[0] - doc_start + 1)
                blocks.append(_CommentBlock(doc_start, doc_end[0], doc_body, False))
            if end <= doc_end:
                if token.type == tokenize.STRING:
                    _add_docstring_body(doc_body, start[0] - doc_start, token.string)
            elif token.exact_type != tokenize.SEMI or start[0] != doc_end[0]:
                code.update(range(start[0], end[0] + 1))
                if start[0] == end[0] and token.type in (
                    tokenize.NAME,
                    tokenize.NUMBER,
                    tokenize.STRING,
                ):
                    host_line = start[0]
    if spans:
        raise ValueError("Python docstring token starts do not match AST positions")
    return blocks, code & _nonempty_rows(rows)


def _typescript_body(raw: str) -> list[str]:
    """
    正式行说明只去掉双斜杠，块说明按编译器换行去掉边缘标记和续行装饰星号，保留真实正文中的其它标点。
    """
    if raw.startswith("//"):
        return [raw[2:]]
    opening = 3 if raw.startswith(("/**", "/*!")) and len(raw) > 4 else 2
    first, *rest = _TYPESCRIPT_ROWS.split(raw[opening:-2])
    return [first, *(row.lstrip().removeprefix("*") for row in rest)]


def _typescript_source(
    text: str, spans: Sequence[_SourceCommentRange]
) -> tuple[list[_CommentBlock], set[int]]:
    """
    以原始码点区间遮罩普通说明并按编译器换行统计代码，确认的固定标记保留原文，不参与正文检查。

    未知或缺失角色的区间继续按普通说明处理，同行的固定标记和说明可分别贡献代码与注释计数。
    """
    ordinary_spans = [item for item in spans if item.get("codeDirective") != "vite-ignore"]
    blocks = [
        _CommentBlock(
            item["start"],
            item["end"],
            _typescript_body(item["text"]),
            item["text"].startswith("//"),
        )
        for item in sorted(ordinary_spans, key=lambda item: item["offsetCodePoint"])
    ]
    residual = _masked_source(text, ordinary_spans, _TYPESCRIPT_TERMINATORS)
    return blocks, _nonempty_rows(_TYPESCRIPT_ROWS.split(residual))


def _legacy_comments(blocks: list[_CommentBlock]) -> tuple[int, list[tuple[int, str]]]:
    """
    每个物理行的有效正文只计一次，相邻行注释共享首行检查，文档串和星号块各自保留起始位置及首行。
    """
    comments: set[int] = set()
    checks: list[tuple[int, str]] = []
    previous_end = 0
    previous_is_line = False
    for block in sorted(blocks, key=lambda item: (item.start, item.end)):
        body = [row.strip() for row in block.body]
        comments.update(block.start + offset for offset, row in enumerate(body) if row)
        first = next(filter(None, body), "")
        if block.is_line and previous_is_line and block.start == previous_end + 1:
            origin, previous_first = checks[-1]
            checks[-1] = (origin, previous_first or first)
        else:
            checks.append((block.start, first))
        previous_end = block.end
        previous_is_line = block.is_line
    return len(comments), checks


def _is_shell(name: str) -> bool:
    """只为已登记的脚本后缀和精确安装路径选择井号正文规则，避免类型脚本或样式正文中的普通井号被误作分隔符。"""
    return Path(name).suffix == ".sh" or name in source_inventory.SOURCE_PATHS


def _comment_body(name: str, raw: str) -> str:
    """正文仅剥离所属语言的实际注释分隔符，脚本内字面的斜杠星号须保留，样式表适配继续使用既有剥离顺序。"""
    if Path(name).suffix == ".java":
        return _java_body(raw)
    if Path(name).suffix == ".html":
        return raw[4:-3]
    if Path(name).suffix == ".ps1":
        return raw[2:-2] if raw.startswith("<#") else raw[1:]
    if _is_shell(name):
        return raw.removeprefix("#").lstrip()
    return raw.removeprefix("//").removeprefix("/*").removesuffix("*/").lstrip("* ")


def _java_body(raw: str) -> str:
    """行说明只移除正式双斜杠以保留前导物理分行和原始行偏移，块说明逐行去装饰星号，其他正文标记保留为文字。"""
    if raw.startswith("//"):
        return raw[2:]
    opening = 3 if raw.startswith(("/**", "/*!")) and len(raw) > 4 else 2
    rows = raw[opening:-2].splitlines()
    return "\n".join(
        row.lstrip().removeprefix("*").lstrip() if index else row.lstrip()
        for index, row in enumerate(rows)
    )


def _first_comment_line(name: str, content: str) -> str:
    """首行跳过纯空白分隔符但保留脚本正文的字面星号，块注释续行仍沿用原有星号前缀剥离和 Unicode 长度契约。"""
    if Path(name).suffix in {".java", ".html", ".ps1"}:
        return next((line.strip() for line in content.splitlines() if line.strip()), "")
    return next(
        (
            line.strip() if _is_shell(name) else line.strip().lstrip("* ")
            for line in content.splitlines()
            if line.strip().strip("* ")
        ),
        "",
    )


def _read_source(root: Path, name: str, ranges: dict[str, Sequence[_SourceCommentRange]]) -> str:
    """读取源文时保留原始换行并为新增语言装入已验证区间，保证字节定位与后续码点遮罩来自同一份未经转换的文本。"""
    suffix = Path(name).suffix
    if (
        suffix in source_inventory.TREE_SITTER_FILE_EXTENSIONS
        or _is_shell(name)
        or suffix == ".ps1"
    ):
        raw = (root / name).read_bytes()
        language = suffix[1:] if suffix in source_inventory.TREE_SITTER_FILE_EXTENSIONS else "shell"
        if suffix == ".ps1":
            language = "powershell"
        ranges[name] = comment_syntax.comment_ranges(raw, language, name)
        return raw.decode("utf-8")
    with (root / name).open(encoding="utf-8", newline="") as source:
        return source.read()


def _comment_lines(name: str, start: int, content: str) -> set[int]:
    """按现有适配器的物理分行从真实正文计算覆盖，区分结构化正文与样式表和脚本已采用的空分隔符判断。"""
    if Path(name).suffix in {".java", ".html", ".ps1"}:
        return {start + offset for offset, line in enumerate(content.splitlines()) if line.strip()}
    return {
        start + offset
        for offset, line in enumerate(content.splitlines())
        if line.strip().strip("#/*\"' ")
    }


def _masked_source(text: str, spans: Sequence[_SourceCommentRange], terminators: str) -> str:
    """
    用空格遮住语法区间中的文字，同时完整保留所属语言的行终止字符，避免评论空行的偏移吞掉后续代码。
    """
    residual = list(text)
    for item in spans:
        for offset in range(item["offsetCodePoint"], item["limitCodePoint"]):
            if residual[offset] not in terminators:
                residual[offset] = " "
    return "".join(residual)


def _adapted_counts(
    name: str, text: str, spans: Sequence[_SourceCommentRange]
) -> tuple[int, int, list[tuple[int, str]]]:
    """
    保留样式表、脚本、Java 和 HTML 各自的正文与分行约定，已有的块归并和质量位置继续沿用原适配路径。
    """
    blocks = [(item["start"], item["end"], _comment_body(name, item["text"])) for item in spans]
    merged: list[tuple[int, int, str]] = []
    comments: set[int] = set()
    for start, end, content in sorted(blocks):
        if merged and start == merged[-1][1] + 1 and start == end and Path(name).suffix != ".html":
            previous = merged.pop()
            merged.append((previous[0], end, previous[2] + "\n" + content))
        else:
            merged.append((start, end, content))
        comments.update(_comment_lines(name, start, content))
    residual = _masked_source(text, spans, _ADAPTER_TERMINATORS)
    code = _nonempty_rows(residual.splitlines()) & _nonempty_rows(text.splitlines())
    checks = [(start, _first_comment_line(name, content)) for start, _, content in merged]
    return len(comments), len(code), checks


def _file_counts(
    name: str, text: str, ranges: dict[str, Sequence[_SourceCommentRange]]
) -> tuple[int, int, list[tuple[int, str]]]:
    """
    按库存已认可的语言选择坐标及正文适配过程，向报告统一提供有效注释行数、代码行数和独立首行待检查项。
    """
    suffix = Path(name).suffix
    if suffix in source_inventory.PYTHON_EXTENSIONS:
        blocks, code = _python_source(text)
    elif suffix in source_inventory.TYPESCRIPT_EXTENSIONS:
        blocks, code = _typescript_source(text, ranges[name])
    else:
        return _adapted_counts(name, text, ranges[name])
    comments, checks = _legacy_comments(blocks)
    return comments, len(code), checks


def audit(root: Path) -> dict[str, Any]:
    """审计 Git 记录及尚未忽略的新源码，注释与代码同一行时分别进入分子和代码分母；连续行注释合并为一个块检查首行，
    文档串只接受 AST 确认的模块、类与函数说明。

    空行不计入分子，单独的注释分隔符也不制造有效说明。大段字符串常量不会被当作文档串增加比例。自动检查不能判断内容是否灌
    水，报告明确保留人工审查责任。每个文件保留计数，便于 T22 按实际符号整改。
    """
    entries = [
        entry
        for entry in source_inventory.inventory(root)
        if not entry["generated"] and not entry["path"].as_posix().startswith(".superpowers/")
    ]
    unsupported = [
        {
            "path": entry["path"].as_posix(),
            "language": entry["language"],
            "reason": entry["unsupportedReason"],
        }
        for entry in entries
        if entry["unsupportedReason"] is not None
    ]
    selected = sorted(
        entry["path"].as_posix() for entry in entries if entry["unsupportedReason"] is None
    )
    js = [name for name in selected if Path(name).suffix in source_inventory.TYPESCRIPT_EXTENSIONS]
    ranges: dict[str, Sequence[_SourceCommentRange]] = (
        json.loads(
            subprocess.check_output(
                ["node", "scripts/comment_ranges.mjs"],
                cwd=root,
                input=json.dumps(js),
                text=True,
            )
        )
        if js
        else {}
    )
    rows: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    for name in selected:
        text = _read_source(root, name, ranges)
        comments, code, checks = _file_counts(name, text, ranges)
        for start, first in checks:
            if not 40 <= len(first) <= 120 or not re.search(r"[\u3400-\u9fff]", first):
                violations.append(
                    {
                        "path": name,
                        "line": start,
                        "reason": (
                            "Chinese comment first line must contain 40 to 120 characters"
                            if len(first) > 120
                            else "Chinese comment first line must contain at least 40 characters"
                        ),
                    }
                )
        rows.append({"path": name, "commentLines": comments, "codeLines": code})
    comment_count, code_count = (
        sum(row["commentLines"] for row in rows),
        sum(row["codeLines"] for row in rows),
    )
    ratio = comment_count / (comment_count + code_count) if comment_count + code_count else 0
    return {
        "method": "syntax-comments-v1",
        "generatedExclusions": sorted(GENERATED),
        "requiresHumanQualityReview": True,
        "ratio": ratio if not unsupported else None,
        "observedRatio": ratio,
        "coverageComplete": not unsupported,
        "unsupportedPaths": unsupported,
        "passed": not unsupported and ratio > 0.4 and not violations,
        "files": rows,
        "violations": violations,
    }


def main() -> None:
    """输出可保存的逐文件计数与违规位置，并以严格大于百分之四十及首行规则共同决定退出码；报告中的人工审查标志不能被自动
    流水线解释为已证明注释语义质量。

    默认根目录来自脚本位置，不受调用 cwd 影响。不提供跳过旧代码或降低阈值的命令行参数。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(Path(__file__).resolve().parents[1])
    except comment_syntax.CommentSyntaxError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    if report["coverageComplete"]:
        print(f"Comment ratio: {report['ratio']:.4%}; violations: {len(report['violations'])}")
    else:
        print(
            f"Comment ratio unavailable: {len(report['unsupportedPaths'])} unsupported source paths; "
            f"violations: {len(report['violations'])}"
        )
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
