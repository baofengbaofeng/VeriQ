"""PowerShell 注释桥接只信任固定官方运行时的 Parser API，拒绝版本、输入、输出或坐标不确定性且从不执行被测文件。"""

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile
from typing import Any

from comment_powershell_process import ProcessBudgetError, run_parser

VERSION = "7.6.6"
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
TIMEOUT_SECONDS = 20
HELPER = r"""
param([string]$SourcePath)
$ErrorActionPreference = 'Stop'
try {
    if ($PSVersionTable.PSVersion.ToString() -cne '7.6.6' -or
        $PSVersionTable.PSEdition -cne 'Core') { exit 2 }
    $bytes = [System.IO.File]::ReadAllBytes($SourcePath)
    $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $text, [ref]$tokens, [ref]$errors)
    function Get-CommentSpans([System.Management.Automation.Language.Token[]]$items) {
        foreach ($token in $items) {
            if ($token.Kind -eq [System.Management.Automation.Language.TokenKind]::Comment) {
                ,@($token.Extent.StartOffset, $token.Extent.EndOffset, $token.Extent.Text)
            }
            if ($token -is [System.Management.Automation.Language.StringExpandableToken]) {
                Get-CommentSpans $token.NestedTokens
            }
        }
    }
    $comments = @(Get-CommentSpans $tokens)
    $result = [ordered]@{
        protocol = 1
        version = $PSVersionTable.PSVersion.ToString()
        edition = $PSVersionTable.PSEdition
        sha256 = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        byteLength = $bytes.Length
        utf16Length = $text.Length
        start = $ast.Extent.StartOffset
        end = $ast.Extent.EndOffset
        errorCount = $errors.Count
        comments = $comments
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 5 -Compress))
} catch {
    [Console]::Error.Write('Parser failure')
    exit 3
}
"""


class PowerShellError(ValueError):
    """桥接错误仅传递固定类别给统一诊断层，不允许运行时异常包含的源码、进程输出或临时文件路径进入审计日志。"""


def runtime_path() -> str:
    """显式工具路径优先，其次使用已准备的项目缓存和系统路径；这里只定位运行时，不执行安装或从网络获取任何文件。"""
    explicit = os.environ.get("VERIQ_POWERSHELL_PATH")
    if explicit:
        candidate = Path(explicit)
        if not candidate.is_absolute() or not candidate.is_file():
            raise PowerShellError("PowerShell runtime unavailable")
        return str(candidate)
    machine = {"x86_64": "x64", "AMD64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine()
    )
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(platform.system())
    name = "pwsh.exe" if system == "win32" else "pwsh"
    if machine and system:
        cache = (
            Path(__file__).resolve().parents[1]
            / ".superpowers/cache/powershell-parser"
            / VERSION
            / f"{system}-{machine}"
            / name
        )
        if cache.is_file():
            return str(cache)
    found = shutil.which("pwsh")
    if found:
        return str(Path(found).resolve())
    raise PowerShellError("PowerShell runtime unavailable")


def _run(runtime: str, source: bytes) -> bytes:
    """固定辅助脚本与源文件使用绝对路径参数，进程树与有界普通文件输出共享期限，任何运行时错误都只返回固定诊断类别。"""
    directory = Path(tempfile.mkdtemp(prefix="veriq-powershell-parser-"))
    cleanup_complete = True
    try:
        helper = directory / "parse.ps1"
        source_path = directory / "source.bin"
        helper.write_bytes(HELPER.encode("utf-8"))
        source_path.write_bytes(source)
        try:
            return run_parser(
                [runtime, "-NoProfile", "-NonInteractive", "-File", str(helper), str(source_path)],
                directory,
                TIMEOUT_SECONDS,
                MAX_OUTPUT_BYTES,
            )
        except ProcessBudgetError as error:
            cleanup_complete = error.cleanup_complete
            raise PowerShellError(str(error)) from None
    finally:
        if cleanup_complete:
            shutil.rmtree(directory)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """结构化回包禁止重复键覆盖已核验的版本或输入绑定，完整 JSON 消耗与精确字段集合一起防止混入额外输出或协议片段。"""
    result = dict(pairs)
    if len(result) != len(pairs):
        raise PowerShellError("Invalid PowerShell parser response")
    return result


def _coordinates(text: str) -> tuple[dict[int, int], int]:
    """映射仅登记完整 UTF16 码点的末端和相应 UTF8 字节位置，补充字符的中间代理位置永不成为可接纳的源码边界。"""
    boundaries = {0: 0}
    byte_offset = unit_offset = 0
    for character in text:
        byte_offset += len(character.encode("utf-8"))
        unit_offset += 2 if ord(character) > 0xFFFF else 1
        boundaries[unit_offset] = byte_offset
    return boundaries, unit_offset


def comment_spans(source: bytes) -> list[tuple[int, int, bytes]]:
    """只返回官方 Comment token 的原字节范围；UTF16 中间代理没有映射，输入摘要和边界核验结束前不交付部分结果。"""
    if len(source) > MAX_SOURCE_BYTES:
        raise PowerShellError("PowerShell source budget exceeded")
    if source.startswith(b"\xef\xbb\xbf"):
        raise PowerShellError("Unsupported PowerShell UTF-8 BOM")
    if b"\0" in source:
        raise PowerShellError("Unsupported PowerShell NUL")
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError:
        raise PowerShellError("Invalid UTF-8") from None
    boundaries, unit_offset = _coordinates(text)
    try:
        raw = _run(runtime_path(), source)
    except OSError:
        raise PowerShellError("PowerShell parser IO failure") from None
    if len(raw) > MAX_OUTPUT_BYTES:
        raise PowerShellError("PowerShell output budget exceeded")
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise PowerShellError("Invalid PowerShell parser response") from None
    expected = {
        "protocol": 1,
        "version": VERSION,
        "edition": "Core",
        "sha256": hashlib.sha256(source).hexdigest(),
        "byteLength": len(source),
        "utf16Length": unit_offset,
        "start": 0,
        "end": unit_offset,
        "errorCount": 0,
    }
    if (
        not isinstance(result, dict)
        or set(result) != set(expected) | {"comments"}
        or any(
            type(result[key]) is not type(value) or result[key] != value
            for key, value in expected.items()
        )
        or not isinstance(result["comments"], list)
    ):
        raise PowerShellError("Invalid PowerShell parser response")
    spans: list[tuple[int, int, bytes]] = []
    previous = 0
    for item in result["comments"]:
        if (
            not isinstance(item, list)
            or len(item) != 3
            or any(not isinstance(value, int) or isinstance(value, bool) for value in item[:2])
            or not isinstance(item[2], str)
        ):
            raise PowerShellError("Invalid PowerShell comment span")
        start, end, spelling = item
        if (
            not previous <= start < end <= unit_offset
            or start not in boundaries
            or end not in boundaries
        ):
            raise PowerShellError("Invalid PowerShell comment span")
        first, last = boundaries[start], boundaries[end]
        if (
            source[first:last].decode("utf-8") != spelling
            or not spelling.startswith("#")
            and not (spelling.startswith("<#") and spelling.endswith("#>"))
        ):
            raise PowerShellError("Invalid PowerShell comment span")
        spans.append((first, last, source[first:last]))
        previous = end
    return spans
