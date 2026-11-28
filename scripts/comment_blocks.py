"""VeriQ 注释排版工具只调整真实独立块注释的分隔符和正文前缀，保持字符串内容及行内注解所在的代码语义不变。

JavaScript 使用仓库已有的 TypeScript 注释桥接；原生语言跳过引号和原始字符串，生成源码必须经生成器更新。
正文长度与语义质量由既有注释审计负责，本工具不填充说明，不把格式通过解释为整个质量门禁通过。
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

import comment_syntax
from line_width import source_paths
import source_inventory

JAVASCRIPT = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
NATIVE = {".c", ".h", ".cc", ".hh", ".cxx", ".hxx", ".cpp", ".hpp", ".m", ".mm"}
STYLES = {".css", ".scss", ".less"}
UNSUPPORTED_BLOCK_LANGUAGES = {".sql", ".go", ".rs", ".swift", ".tpl"}
PRAGMA = re.compile(
    r"^(?:[#!]?@?__PURE__|[#!]?@?__NO_SIDE_EFFECTS__|@type\b|@ts-|@vite-ignore\b|"
    r"eslint-|biome-ignore\b|prettier-ignore\b|[#@]\s*source(?:Mapping)?URL=)"
)


class UnsupportedBlockLanguage(ValueError):
    """尚未接入词法解析器的源码语言出现块注释标记时明确中止检查，避免把未扫描的内容错误报告为零违规通过。"""


def normalize_block(comment: str, indent: str = "") -> str:
    """独立块注释保留原有正文的相对缩进和空白段落，仅将开闭分隔符移到独占行并为正文补齐统一星号前缀。"""
    opening = comment[:3] if comment.startswith(("/**", "/*!")) else "/*"
    body = comment[len(opening) : -2]
    rows = body.split("\n")
    content = []
    for index, row in enumerate(rows):
        row = row.removesuffix("\r")
        if index:
            row = row.removeprefix(indent)
            if row.startswith(" *"):
                row = row[2:].removeprefix(" ")
            elif row.startswith("*"):
                row = row[1:].removeprefix(" ")
        else:
            row = row.removeprefix(" ")
        content.append(row.rstrip())
    while content and not content[0].strip():
        content.pop(0)
    while content and not content[-1].strip():
        content.pop()
    newline = "\r\n" if "\r\n" in comment else "\n"
    lines = [opening]
    lines.extend(indent + " *" + (" " + row if row else "") for row in content)
    if not content:
        lines.append(indent + " *")
    lines.append(indent + " */")
    return newline.join(lines)


def native_ranges(text: str, *, styles: bool = False) -> list[dict[str, Any]]:
    """原生与样式源码按引号及注释的词法边界前进，跳过字符串中的注释样本并保留真实块注释的码点起止位置。"""
    result = []
    index = 0
    size = len(text)
    while index < size:
        if text.startswith("//", index) and not styles:
            ending = text.find("\n", index + 2)
            index = size if ending < 0 else ending + 1
            continue
        if text.startswith("/*", index):
            ending = text.find("*/", index + 2)
            if ending < 0:
                raise ValueError("Unterminated block comment")
            result.append({"offsetCodePoint": index, "limitCodePoint": ending + 2})
            index = ending + 2
            continue
        raw = re.match(r'R"([^ ()\\\t\r\n]{0,16})\(', text[index : index + 20])
        if raw:
            ending = text.find(")" + raw.group(1) + '"', index + len(raw.group(0)))
            if ending < 0:
                raise ValueError("Unterminated raw string")
            index = ending + len(raw.group(1)) + 2
            continue
        if text.startswith('"""', index):
            ending = index + 3
            while True:
                ending = text.find('"""', ending)
                if ending < 0:
                    raise ValueError("Unterminated text block")
                escapes = len(text[:ending]) - len(text[:ending].rstrip("\\"))
                if escapes % 2 == 0:
                    break
                ending += 3
            index = ending + 3
            continue
        if text[index] in {'"', "'", "`"}:
            quote = text[index]
            index += 1
            while index < size:
                if text[index] == "\\":
                    index += 2
                elif text[index] == quote:
                    index += 1
                    break
                else:
                    index += 1
            continue
        index += 1
    return result


def comment_ranges(
    root: Path, paths: list[Path], typescript: str | None = None
) -> dict[str, list[dict[str, Any]]]:
    """多语言源码统一返回码点注释区间，脚本语言复用正式解析器桥接且在桥接不可用时明确失败而非假报零问题。"""
    output: dict[str, list[dict[str, Any]]] = {}
    for path in paths:
        if path.suffix in UNSUPPORTED_BLOCK_LANGUAGES:
            with (root / path).open(encoding="utf-8", newline="") as source:
                if "/*" in source.read():
                    raise UnsupportedBlockLanguage(path.as_posix())
    javascript = [path.as_posix() for path in paths if path.suffix in JAVASCRIPT]
    if javascript:
        environment = os.environ.copy()
        if typescript:
            environment["VERIQ_TYPESCRIPT_PATH"] = str(Path(typescript).resolve())
        output.update(
            json.loads(
                subprocess.check_output(
                    ["node", str(Path(__file__).with_name("comment_ranges.mjs"))],
                    cwd=root,
                    input=json.dumps(javascript),
                    text=True,
                    env=environment,
                    stderr=subprocess.PIPE,
                )
            )
        )
    for path in paths:
        if path.suffix in source_inventory.TREE_SITTER_FILE_EXTENSIONS | {".ps1"}:
            output[path.as_posix()] = [
                dict(span)
                for span in comment_syntax.comment_ranges(
                    (root / path).read_bytes(),
                    "powershell" if path.suffix == ".ps1" else path.suffix[1:],
                    path.as_posix(),
                )
            ]
        elif path.suffix in NATIVE | STYLES:
            with (root / path).open(encoding="utf-8", newline="") as source:
                output[path.as_posix()] = native_ranges(source.read(), styles=path.suffix in STYLES)
    return output


def replacements(text: str, ranges: list[dict[str, Any]]) -> list[tuple[int, int, str]]:
    """仅接受起止行都没有其他代码的独立块注释，保留行内注解和格式化指令以避免换行触发自动分号或工具指令变化。"""
    changes = []
    for item in ranges:
        start, end = item["offsetCodePoint"], item["limitCodePoint"]
        comment = text[start:end]
        if not comment.startswith("/*"):
            continue
        line_start = text.rfind("\n", 0, start) + 1
        line_end = text.find("\n", end)
        line_end = len(text) if line_end < 0 else line_end
        indent = text[line_start:start]
        if indent.strip() or text[end:line_end].strip():
            continue
        opening = 3 if comment.startswith(("/**", "/*!")) else 2
        if PRAGMA.match(comment[opening:-2].strip()):
            continue
        normalized = normalize_block(comment, indent)
        if normalized != comment:
            changes.append((start, end, normalized))
    return changes


def inline_violations(text: str, ranges: list[dict[str, Any]]) -> list[int]:
    """真实行内说明不能被格式检查悄悄忽略，保留工具注解后返回需人工移动的位置且绝不自动插入可能改变语义的换行。"""
    violations = []
    for item in ranges:
        start, end = item["offsetCodePoint"], item["limitCodePoint"]
        comment = text[start:end]
        if not comment.startswith("/*"):
            continue
        opening = 3 if comment.startswith(("/**", "/*!")) else 2
        if PRAGMA.match(comment[opening:-2].strip()):
            continue
        line_start = text.rfind("\n", 0, start) + 1
        line_end = text.find("\n", end)
        line_end = len(text) if line_end < 0 else line_end
        if text[line_start:start].strip() or text[end:line_end].strip():
            violations.append(start)
    return violations


def select_paths(root: Path, scopes: list[str]) -> list[Path]:
    """按真实 Git 范围筛选调用者指定的文件或目录前缀，生成源码仍参与检查且不会通过目录名称猜测排除旧代码。"""
    prefixes = [Path(value).as_posix().rstrip("/") for value in scopes]
    return [
        path
        for path in source_paths(root)
        if not prefixes
        or any(
            path.as_posix() == prefix or path.as_posix().startswith(prefix + "/")
            for prefix in prefixes
        )
    ]


def main() -> None:
    """默认只报告注释格式的真实位置并以非零退出拒绝违规，显式修复只写普通源码且保留生成器所有权与正文质量门禁。"""
    parser = argparse.ArgumentParser(description="Check source block-comment layout.")
    parser.add_argument(
        "scopes", nargs="*", help="Optional repository-relative file or directory scopes."
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--typescript", help="Optional installed TypeScript library module path.")
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Format ordinary source; generated files remain read-only.",
    )
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        paths = select_paths(root, args.scopes)
        ranges = comment_ranges(root, paths, args.typescript)
        violations = 0
        changed = 0
        for name, spans in ranges.items():
            path = root / name
            if path.suffix == ".html":
                # 此处已完成全部 HTML 范围提取与验证，块排版只处理具有正式斜杠分隔符的语言。
                continue
            with path.open(encoding="utf-8", newline="") as source:
                text = source.read()
            unsafe = inline_violations(text, spans)
            for start in unsafe:
                line = text.count("\n", 0, start) + 1
                print(f"{name}:{line}: inline explanatory block comment requires manual placement")
            violations += len(unsafe)
            edits = replacements(text, spans)
            if args.fix and ".generated." not in path.name:
                for start, end, replacement in sorted(edits, reverse=True):
                    text = text[:start] + replacement + text[end:]
                if edits:
                    with path.open("w", encoding="utf-8", newline="") as source:
                        source.write(text)
                    changed += 1
            else:
                for start, _, _ in edits:
                    line = text.count("\n", 0, start) + 1
                    print(
                        f"{name}:{line}: block-comment delimiters and body require separate lines"
                    )
                violations += len(edits)
        print(
            f"Block-comment layout: {len(paths)} source files, {violations} violations, {changed} files formatted."
        )
        raise SystemExit(1 if violations else 0)
    except UnsupportedBlockLanguage as error:
        print(
            f"{error}: unsupported source language requires a block-comment parser.",
            file=sys.stderr,
        )
        raise SystemExit(2) from None
    except comment_syntax.CommentSyntaxError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except (OSError, ValueError, UnicodeError, subprocess.CalledProcessError):
        print("Block-comment check could not parse the source repository.", file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
