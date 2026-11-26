"""VeriQ 源码行宽按编辑器显示列计算中文及全角字符，统一检查代码与注释并保留生成文件在内的完整仓库范围。

使用当前 Python 3.12 标准库的 Unicode 数据；组合标记与格式字符不占列，Tab 前进至下一个四列制表位。
工具只报告路径、行号与列宽，不输出可能包含凭据的源码正文；格式化器的建议宽度不能代替此硬性检查。
"""

import argparse
from pathlib import Path
import subprocess
import sys
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
# 发行入口和验收都允许按文件路径加载模块，因此先注册脚本目录再导入同级库存，避免依赖调用方当前目录。
import source_inventory  # pylint: disable=wrong-import-position

MAX_COLUMNS = 120

SOURCE_EXTENSIONS = source_inventory.SOURCE_EXTENSIONS
SOURCE_NAMES = source_inventory.SOURCE_NAMES
SOURCE_PATHS = source_inventory.SOURCE_PATHS


def display_width(text: str) -> int:
    """逐个码点累计编辑器约定的可见列宽，中文与全角字符占两列并让制表符按当前位置前进至下一个四列边界。"""
    columns = 0
    for character in text:
        if character == "\t":
            columns += 4 - columns % 4
        elif unicodedata.category(character) in {"Mn", "Me", "Cf"}:
            continue
        elif unicodedata.east_asian_width(character) in {"W", "F"}:
            columns += 2
        else:
            columns += 1
    return columns


def source_paths(root: Path) -> list[Path]:
    """从真实 Git 索引和未忽略的新文件选择可编程源码，保留生成文件及所有已跟踪源码而不扫描依赖缓存目录。"""
    return [entry["path"] for entry in source_inventory.inventory(root)]


def check_sources(root: Path) -> list[tuple[str, int, int]]:
    """读取选中的真实源码并记录每条超限物理行的位置和显示列数，导入语句及注释同样受一百二十列硬上限约束。"""
    violations = []
    for path in source_paths(root):
        text = (root / path).read_text(encoding="utf-8")
        for number, line in enumerate(text.split("\n"), 1):
            columns = display_width(line)
            if columns > MAX_COLUMNS:
                violations.append((path.as_posix(), number, columns))
    return violations


def main() -> None:
    """以脚本所在仓库为默认检查根并允许临时仓库夹具显式指定根目录，任何超限或读取失败均返回非零退出状态。"""
    parser = argparse.ArgumentParser(description="Check the 120-column source display-width limit.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        violations = check_sources(args.root.resolve())
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        print("Source display-width check could not read the repository.", file=sys.stderr)
        raise SystemExit(2) from None
    for path, line, columns in violations:
        print(f"{path}:{line}: display width {columns} exceeds {MAX_COLUMNS} columns")
    if violations:
        print(f"Source display-width check failed: {len(violations)} overlong lines.")
        raise SystemExit(1)
    print("Source display-width check passed: all source lines are within 120 columns.")


if __name__ == "__main__":
    main()
