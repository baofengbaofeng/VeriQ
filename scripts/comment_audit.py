"""仓库注释门禁按实际语法中的注释与文档串计算非空行比例，并检查中文及六十字符首行；自动结果只证明可机械验证的条件，符号职责与解释质量仍须独立代码审查。

仅排除明确生成的合同文件、依赖和私有证据，不排除测试或旧代码。
Python 使用 tokenize 与 AST，TypeScript 使用官方解析器区间。
缺少解析工具或源码不可解析时直接失败，不输出虚假的零问题结果。
"""

import argparse
import ast
import io
import json
from typing import Any
from pathlib import Path
import re
import subprocess
import tokenize

GENERATED = {
    "packages/contracts/src/api.generated.ts",
    "packages/contracts/src/types.generated.ts",
}
EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".mjs", ".mts", ".c", ".sh"}


def audit(root: Path) -> dict[str, Any]:
    """审计 Git 记录及尚未忽略的新源码，注释与代码同一行时分别进入分子和代码分母；连续行注释合并为一个块检查首行，文档串只接受 AST 确认的模块、类与函数说明。

    空行不计入分子，单独的注释分隔符也不制造有效说明。
    大段字符串常量不会被当作文档串增加比例。
    自动检查不能判断内容是否灌水，报告明确保留人工审查责任。
    每个文件保留计数，便于 T22 按实际符号整改。
    """
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        text=True,
    ).splitlines()
    selected = sorted(
        {
            name
            for name in names
            if Path(name).suffix in EXTENSIONS
            and name not in GENERATED
            and not name.startswith(".superpowers/")
            and (root / name).is_file()
        }
    )
    js = [name for name in selected if Path(name).suffix not in {".py", ".sh"}]
    ranges = json.loads(
        subprocess.check_output(
            ["node", "scripts/comment_ranges.mjs"],
            cwd=root,
            input=json.dumps(js),
            text=True,
        )
    )
    rows: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    for name in selected:
        text = (root / name).read_text()
        lines = text.splitlines()
        blocks = []
        comments: set[int] = set()
        code: set[int] = set()
        if name.endswith(".py"):
            for token in tokenize.generate_tokens(io.StringIO(text).readline):
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
        elif name.endswith(".sh"):
            for index, line in enumerate(lines, 1):
                if line.lstrip().startswith("#") and not line.startswith("#!"):
                    blocks.append((index, index, line.lstrip().lstrip("# ")))
                elif line.strip():
                    code.add(index)
        else:
            blocks = [
                (
                    item["start"],
                    item["end"],
                    item["text"]
                    .removeprefix("//")
                    .removeprefix("/*")
                    .removesuffix("*/")
                    .lstrip("* "),
                )
                for item in ranges[name]
            ]
            residual = list(text)
            for item in ranges[name]:
                for offset in range(item["offset"], item["limit"]):
                    if residual[offset] != "\n":
                        residual[offset] = " "
            code = {
                index
                for index, line in enumerate("".join(residual).splitlines(), 1)
                if line.strip()
            }
        merged: list[tuple[int, int, str]] = []
        for start, end, content in sorted(blocks):
            if merged and start == merged[-1][1] + 1 and start == end:
                previous = merged.pop()
                merged.append((previous[0], end, previous[2] + "\n" + content))
            else:
                merged.append((start, end, content))
            comments.update(
                index
                for index in range(start, end + 1)
                if lines[index - 1].strip().strip("#/*\"' ")
            )
        for start, _, content in merged:
            first = next(
                (
                    line.strip().lstrip("* ")
                    for line in content.splitlines()
                    if line.strip().strip("* ")
                ),
                "",
            )
            if len(first) < 60 or not re.search(r"[\u3400-\u9fff]", first):
                violations.append(
                    {
                        "path": name,
                        "line": start,
                        "reason": "Chinese comment first line must contain at least 60 characters",
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
        "ratio": ratio,
        "passed": ratio > 0.4 and not violations,
        "files": rows,
        "violations": violations,
    }


def main() -> None:
    """输出可保存的逐文件计数与违规位置，并以严格大于百分之四十及首行规则共同决定退出码；报告中的人工审查标志不能被自动流水线解释为已证明注释语义质量。

    默认根目录来自脚本位置，不受调用 cwd 影响。
    不提供跳过旧代码或降低阈值的命令行参数。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = audit(Path(__file__).resolve().parents[1])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Comment ratio: {report['ratio']:.4%}; violations: {len(report['violations'])}")
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
