"""显式安装固定版本的 PowerShell 开发解析工具，官方归档先校验完整摘要再解包，正式审计从不自行下载或执行受检源码。"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import tarfile
import tempfile
import zipfile

VERSION = "7.6.6"
ASSETS = {
    "darwin-x64": (
        "powershell-7.6.6-osx-x64.tar.gz",
        "e325ed9f666894eb39a5ea52800b602da2fb4242bbe9747ceddb39cdc66de805",
    ),
    "darwin-arm64": (
        "powershell-7.6.6-osx-arm64.tar.gz",
        "6df833d094ebac1c1a74340d7b3437f4aaf5e03ce640484a1c4359f3ce8b3db1",
    ),
    "linux-x64": (
        "powershell-7.6.6-linux-x64.tar.gz",
        "ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc",
    ),
    "linux-arm64": (
        "powershell-7.6.6-linux-arm64.tar.gz",
        "924829e54c983648f6f1419a2dc7f9433c861b2fb5bd57736ff096c24f133729",
    ),
    "win32-x64": (
        "PowerShell-7.6.6-win-x64.zip",
        "02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860",
    ),
}


def tool_identity() -> dict[str, str]:
    """只允许已核对官方摘要的宿主组合，开发者可先打印确切来源并手动下载，未知系统与架构不能猜测相近包。"""
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(platform.system())
    arch = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        platform.machine()
    )
    target = f"{system}-{arch}"
    if target not in ASSETS:
        raise ValueError("POWERSHELL_TARGET_UNSUPPORTED")
    filename, expected = ASSETS[target]
    return {
        "version": VERSION,
        "target": target,
        "sha256": expected,
        "url": f"https://github.com/PowerShell/PowerShell/releases/download/v{VERSION}/{filename}",
    }


def tool_version(executable: Path) -> str:
    """只启动已解包工具读取自身版本，关闭个人配置与交互，实际解析输入仍由独立适配器按结构化协议核验。"""
    if not executable.is_file() or executable.is_symlink():
        raise ValueError("POWERSHELL_EXECUTABLE_INVALID")
    result = subprocess.run(
        [
            str(executable),
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$PSVersionTable.PSVersion.ToString()",
        ],
        capture_output=True,
        stdin=subprocess.DEVNULL,
        text=True,
        timeout=30,
        check=True,
        env={**os.environ, "POWERSHELL_TELEMETRY_OPTOUT": "1"},
    )
    if result.stdout.strip() != VERSION:
        raise ValueError("POWERSHELL_VERSION_MISMATCH")
    return VERSION


def extract_archive(path: Path, destination: Path, filename: str) -> None:
    """只处理已验证摘要的归档，拒绝越界路径与链接；ZIP 禁止全部符号链接，tar 使用标准库 data 过滤器保留安全内部链接。"""
    if filename.endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                member = PurePosixPath(entry.filename.replace("\\", "/"))
                if (
                    member.is_absolute()
                    or ".." in member.parts
                    or any(":" in p for p in member.parts)
                ):
                    raise ValueError("POWERSHELL_ARCHIVE_PATH_INVALID")
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("POWERSHELL_ARCHIVE_LINK_FORBIDDEN")
            archive.extractall(destination)
    else:
        with tarfile.open(path, "r:gz") as archive:
            for tar_entry in archive.getmembers():
                member = PurePosixPath(tar_entry.name.replace("\\", "/"))
                if (
                    member.is_absolute()
                    or ".." in member.parts
                    or any(":" in p for p in member.parts)
                ):
                    raise ValueError("POWERSHELL_ARCHIVE_PATH_INVALID")
            archive.extractall(destination, filter="data")


def cache_directory() -> Path:
    """缓存只位于当前源码仓的忽略目录，已有父级不允许符号链接，准备过程不会借缓存入口改写仓库外的安装。"""
    root = Path(__file__).resolve().parents[1]
    cache = root / ".superpowers" / "cache" / "powershell-parser" / VERSION
    for directory in (cache, *cache.parents):
        if directory.is_symlink():
            raise ValueError("POWERSHELL_CACHE_LINK_FORBIDDEN")
        if directory == root:
            break
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def prepare(archive_path: Path, identity: dict[str, str]) -> Path:
    """归档摘要先于任何解包检查，版本和许可核验成功后才原子发布新缓存，已有缓存也须匹配固定来源与工具版本。"""
    with archive_path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != identity["sha256"]:
            raise ValueError("POWERSHELL_ARCHIVE_HASH_MISMATCH")
    cache = cache_directory()
    destination = cache / identity["target"]
    if destination.is_symlink():
        raise ValueError("POWERSHELL_CACHE_LINK_FORBIDDEN")
    binary = "pwsh.exe" if identity["target"].startswith("win32-") else "pwsh"
    if destination.exists():
        receipt = json.loads((destination / ".veriq-parser-tool.json").read_text(encoding="utf-8"))
        if receipt != identity:
            raise ValueError("POWERSHELL_CACHE_IDENTITY_MISMATCH")
        tool_version(destination / binary)
        return destination / binary
    with tempfile.TemporaryDirectory(prefix=".powershell-", dir=cache) as temporary:
        staged = Path(temporary) / "runtime"
        staged.mkdir()
        extract_archive(archive_path, staged, identity["url"].rsplit("/", 1)[-1])
        if not all(
            (staged / name).is_file() for name in (binary, "LICENSE.txt", "ThirdPartyNotices.txt")
        ):
            raise ValueError("POWERSHELL_ARCHIVE_CONTENTS_MISSING")
        if binary == "pwsh":
            (staged / binary).chmod(0o755)
        tool_version(staged / binary)
        (staged / ".veriq-parser-tool.json").write_text(
            json.dumps(identity, indent=4) + "\n", encoding="utf-8"
        )
        staged.rename(destination)
    return destination / binary


def main() -> None:
    """解析开发者显式准备或来源查询请求，工具安装与正式源码审计分离，查询来源不会触发下载或系统改动。"""
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--archive", type=Path, help="Previously downloaded official archive")
    inputs.add_argument(
        "--print-source",
        action="store_true",
        help="Print exact official asset and SHA256",
    )
    args = parser.parse_args()
    identity = tool_identity()
    if args.print_source:
        print(json.dumps(identity))
    else:
        print(str(prepare(args.archive, identity)))


if __name__ == "__main__":
    main()
