"""共享源码库存只从 Git 的零字节分隔清单选择现有源码边界，保留已跟踪文件和未忽略新文件并记录可信注释适配状态。

生成合同仍属于源码，仅由比例消费者按既有三条路径排除；列宽消费者不能继承该豁免。
此处不猜测未知后缀或配置中的嵌入语言，相关混合边界须另行研究。
"""

from pathlib import Path
import subprocess
from typing import TypedDict

SOURCE_EXTENSIONS = {
    ".py",
    ".pyi",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".c",
    ".h",
    ".cc",
    ".hh",
    ".cxx",
    ".hxx",
    ".cpp",
    ".hpp",
    ".m",
    ".mm",
    ".java",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".sql",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".swift",
    ".go",
    ".rs",
    ".nsh",
    ".nsi",
    ".tpl",
    ".cmake",
}
SOURCE_NAMES = {"Makefile", "CMakeLists.txt", "Dockerfile"}
SOURCE_PATHS = {"deploy/desktop/macos/scripts/preinstall"}

GENERATED = {
    "apps/desktop/src/shared/operations.generated.ts",
    "packages/contracts/src/api.generated.ts",
    "packages/contracts/src/types.generated.ts",
}
PYTHON_EXTENSIONS = {".py", ".pyi"}
TYPESCRIPT_EXTENSIONS = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}


class SourceFile(TypedDict):
    """每个已选文件保留原始路径与解析支持理由，生成身份只表达比例排除政策，不能让列宽检查丢弃实际源码。"""

    path: Path
    language: str
    generated: bool
    unsupportedReason: str | None


def inventory(root: Path) -> list[SourceFile]:
    """从真实索引与未忽略文件枚举源码并标记可信语言适配，无法验证注释边界的输入保留路径和原因供比例消费者失败关闭。"""
    output = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
    )
    paths = {Path(name) for name in output.decode("utf-8").split("\0") if name}
    entries: list[SourceFile] = []
    for path in sorted(paths):
        if (
            not (
                path.suffix in SOURCE_EXTENSIONS
                or path.name in SOURCE_NAMES
                or path.name.startswith("Dockerfile.")
                or path.as_posix() in SOURCE_PATHS
            )
            or not (root / path).is_file()
        ):
            continue
        language = path.suffix.removeprefix(".") or path.name
        reason: str | None = "No trusted syntax/comment adapter for this source language"
        if path.suffix in PYTHON_EXTENSIONS:
            language, reason = "python", None
        elif path.suffix in TYPESCRIPT_EXTENSIONS:
            language, reason = "typescript", None
        elif path.suffix == ".css":
            language, reason = "css", None
        elif path.suffix == ".sh" or path.as_posix() in SOURCE_PATHS:
            language = "shell"
            with (root / path).open("rb") as source:
                first = source.readline().removesuffix(b"\n").removesuffix(b"\r")
            reason = (
                None
                if first in {b"#!/usr/bin/env bash", b"#!/bin/sh"}
                else "Unsupported shell shebang: expected #!/usr/bin/env bash or #!/bin/sh"
            )
        entries.append(
            {
                "path": path,
                "language": language,
                "generated": path.as_posix() in GENERATED,
                "unsupportedReason": reason,
            }
        )
    return entries
