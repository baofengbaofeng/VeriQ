"""仓库注释门禁按实际语法中的注释与文档串计算非空行比例，并检查中文及四十字符首行；自动结果只证明可机械验证的条件，
符号职责与解释质量仍须独立代码审查。

仅排除明确生成的合同文件、依赖和私有证据，不排除测试或旧代码。Python 使用 tokenize 与 AST，TypeScript
使用官方解析器区间。缺少解析工具或源码不可解析时直接失败，不输出虚假的零问题结果。
"""

import argparse
import ast
import io
import json
from typing import Any
from pathlib import Path
import re
import subprocess
import sys
import tokenize

sys.path.insert(0, str(Path(__file__).resolve().parent))
# 发行入口和验收都允许按文件路径加载模块，因此先注册脚本目录再导入同级库存，避免依赖调用方当前目录。
import comment_syntax  # pylint: disable=wrong-import-position
import source_inventory  # pylint: disable=wrong-import-position

GENERATED = source_inventory.GENERATED


def _is_shell(name: str) -> bool:
    """只为已登记的脚本后缀和精确安装路径选择井号正文规则，避免类型脚本或样式正文中的普通井号被误作分隔符。"""
    return Path(name).suffix == ".sh" or name in source_inventory.SOURCE_PATHS


def _comment_body(name: str, raw: str) -> str:
    """正文仅剥离所属语言的实际注释分隔符，脚本内字面的斜杠星号须保留，而旧脚本桥接继续使用既有剥离顺序。"""
    if _is_shell(name):
        return raw.removeprefix("#").lstrip()
    return raw.removeprefix("//").removeprefix("/*").removesuffix("*/").lstrip("* ")


def _first_comment_line(name: str, content: str) -> str:
    """首行跳过纯空白分隔符但保留脚本正文的字面星号，块注释续行仍沿用原有星号前缀剥离和 Unicode 长度契约。"""
    return next(
        (
            line.strip() if _is_shell(name) else line.strip().lstrip("* ")
            for line in content.splitlines()
            if line.strip().strip("* ")
        ),
        "",
    )


def _read_source(root: Path, name: str, ranges: dict[str, Any]) -> str:
    """读取源文时保留原始换行并为新增语言装入已验证区间，保证字节定位与后续码点遮罩来自同一份未经转换的文本。"""
    if (
        Path(name).suffix == ".css"
        or Path(name).suffix == ".sh"
        or name in source_inventory.SOURCE_PATHS
    ):
        raw = (root / name).read_bytes()
        language = "css" if Path(name).suffix == ".css" else "shell"
        ranges[name] = comment_syntax.comment_ranges(raw, language, name)
        return raw.decode("utf-8")
    with (root / name).open(encoding="utf-8", newline="") as source:
        return source.read()


def _comment_lines(name: str, start: int, end: int, content: str, lines: list[str]) -> set[int]:
    """新增语言只累计真实范围中的非空正文，旧语言保留既有关闭行规则，防止空注释旁的代码在新增适配中被错误计为说明。"""
    if Path(name).suffix in {".sh", ".css"} or name in source_inventory.SOURCE_PATHS:
        return {
            start + offset
            for offset, line in enumerate(content.splitlines())
            if line.strip().strip("#/*\"' ")
        }
    return {index for index in range(start, end + 1) if lines[index - 1].strip().strip("#/*\"' ")}


def _masked_source(name: str, text: str, spans: list[dict[str, Any]]) -> str:
    """新增语言遮罩保留既有物理分行定义的全部边界，防止注释空行错移后吞掉代码；旧类型脚本仍保持原有回车换行规则。"""
    line_breaks = "\r\n"
    if _is_shell(name) or Path(name).suffix == ".css":
        line_breaks += "\v\f\x1c\x1d\x1e\x85\u2028\u2029"
    residual = list(text)
    for item in spans:
        for offset in range(item["offsetCodePoint"], item["limitCodePoint"]):
            if residual[offset] not in line_breaks:
                residual[offset] = " "
    return "".join(residual)


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
    ranges = (
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
        lines = text.splitlines()
        blocks = []
        comments: set[int] = set()
        code: set[int] = set()
        if Path(name).suffix in source_inventory.PYTHON_EXTENSIONS:
            # Python 分词器依赖逐个物理行读取，StringIO 必须启用通用换行以识别合法裸回车并与 AST 行号一致；
            # 转换仅作用于分词输入，供 Node 坐标遮罩使用的原始文本仍完整保留。
            for token in tokenize.generate_tokens(io.StringIO(text, newline=None).readline):
                if token.type == tokenize.COMMENT:
                    blocks.append((token.start[0], token.end[0], token.string.lstrip("# ")))
                elif token.type not in {
                    tokenize.NL,
                    tokenize.NEWLINE,
                    tokenize.INDENT,
                    tokenize.DEDENT,
                    tokenize.ENDMARKER,
                }:
                    code.update(range(token.start[0], token.end[0] + 1))
            tree = ast.parse(text)
            for node in ast.walk(tree):
                if (
                    isinstance(
                        node,
                        (
                            ast.Module,
                            ast.ClassDef,
                            ast.FunctionDef,
                            ast.AsyncFunctionDef,
                        ),
                    )
                    and ast.get_docstring(node, clean=False) is not None
                ):
                    value = node.body[0]
                    assert value.end_lineno is not None
                    blocks.append(
                        (
                            value.lineno,
                            value.end_lineno,
                            ast.get_docstring(node, clean=False) or "",
                        )
                    )
                    code.difference_update(range(value.lineno, value.end_lineno + 1))
        else:
            blocks = [
                (item["start"], item["end"], _comment_body(name, item["text"]))
                for item in ranges[name]
            ]
            residual = _masked_source(name, text, ranges[name])
            code = {index for index, line in enumerate(residual.splitlines(), 1) if line.strip()}
        merged: list[tuple[int, int, str]] = []
        for start, end, content in sorted(blocks):
            if merged and start == merged[-1][1] + 1 and start == end:
                previous = merged.pop()
                merged.append((previous[0], end, previous[2] + "\n" + content))
            else:
                merged.append((start, end, content))
            comments.update(_comment_lines(name, start, end, content, lines))
        for start, _, content in merged:
            first = _first_comment_line(name, content)
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
        code.intersection_update(index for index, line in enumerate(lines, 1) if line.strip())
        rows.append({"path": name, "commentLines": len(comments), "codeLines": len(code)})
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
