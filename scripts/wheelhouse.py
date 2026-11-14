"""离线 wheelhouse 生成器使用 uv 已解析的冻结生产需求与锁文件中的真实下载地址，不自行推导依赖关系；只选择适合 Python3.12 Linux x64 且不高于 Ubuntu24.04 glibc 基线的二进制 wheel。

每个下载必须匹配 uv.lock 的 SHA256，不能回退源码编译。
实际 Ubuntu 与容器启动验收仍由对应环境执行。
在 Debian 上制作兼容候选不等于已经验证目标操作系统。
"""

from hashlib import sha256
from typing import Any
from pathlib import Path
import re
import subprocess
import tomllib
import urllib.request
from release_processes import RunProcess

from packaging.requirements import Requirement
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename


def wheelhouse(
    root: Path, destination: Path, run_process: RunProcess = subprocess.run
) -> list[dict[str, Any]]:
    """先让 uv 按冻结锁导出生产依赖，再从每个锁定包的 wheel 列表选择当前 ABI 可安装的兼容文件；缺少二进制、哈希不符或空间不足均失败，不用宿主编译产物补齐发行。

    marker 由 packaging 标准解析器按当前 Python3.12 Linux 环境判断。
    wheel 文件名与标签由同一成熟库解析。
    下载以临时文件落盘，校验后才改名为可安装 wheel。
    requirements.txt 保留 uv 给出的完整哈希供离线审计。
    """
    exported = run_process(
        [
            "uv",
            "export",
            "--project",
            "apps/srv",
            "--frozen",
            "--no-dev",
            "--no-emit-project",
            "--format",
            "requirements-txt",
        ],
        cwd=root,
        text=True,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "requirements.txt").write_text(exported)
    packages = {
        canonicalize_name(item["name"]): item
        for item in tomllib.loads((root / "apps/srv/uv.lock").read_text())["package"]
    }
    tags = list(sys_tags())
    rank = {tag: index for index, tag in enumerate(tags)}
    selected = []
    for line in exported.splitlines():
        if not line or line.startswith(("#", " ", "-")):
            continue
        requirement = Requirement(line.rstrip(" \\"))
        if requirement.marker and not requirement.marker.evaluate():
            continue
        package = packages[canonicalize_name(requirement.name)]
        candidates = []
        for item in package.get("wheels", []):
            filename = item["url"].rsplit("/", 1)[1]
            _, version, _, supported = parse_wheel_filename(filename)
            if version not in requirement.specifier:
                continue
            compatible = []
            for tag in supported:
                platform = tag.platform
                match = re.fullmatch(r"manylinux_2_(\d+)_x86_64", platform)
                allowed = platform in {
                    "any",
                    "manylinux1_x86_64",
                    "manylinux2010_x86_64",
                    "manylinux2014_x86_64",
                } or (match is not None and int(match[1]) <= 39)
                if allowed and tag in rank:
                    compatible.append(rank[tag])
            if compatible:
                candidates.append((min(compatible), filename, item))
        if not candidates:
            raise ValueError(f"No compatible locked wheel: {requirement.name}")
        _, filename, item = min(candidates, key=lambda value: (value[0], value[1]))
        target = destination / filename
        digest = item["hash"].removeprefix("sha256:")
        if not target.exists():
            temporary = target.with_suffix(".partial")
            try:
                with (
                    urllib.request.urlopen(item["url"], timeout=60) as response,
                    temporary.open("wb") as stream,
                ):
                    while chunk := response.read(1024 * 1024):
                        stream.write(chunk)
                if sha256(temporary.read_bytes()).hexdigest() != digest:
                    raise ValueError("Locked wheel hash mismatch")
                temporary.rename(target)
            finally:
                temporary.unlink(missing_ok=True)
        if sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError("Existing wheelhouse hash mismatch")
        selected.append(
            {
                "name": package["name"],
                "version": package["version"],
                "filename": filename,
                "sha256": digest,
            }
        )
    return selected
