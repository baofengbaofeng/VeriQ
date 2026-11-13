"""独立 wheel 验证器核对 ZIP 唯一成员、RECORD 摘要、迁移与完整静态库存，并可在仓库外进行离线安装和生产 HTTP 探测；它不接受 editable 包作为已验证发行。

归档成员先检查路径及文件类型，再写入临时目录。
干净安装只从显式 wheelhouse 取依赖，不能回退网络索引。
生产探测进程的 PATH 为空，数据根位于只读包目录之外。
"""

import argparse
import base64
import csv
from email.parser import BytesParser
from hashlib import sha256
import io
import json
from typing import Any, cast
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/srv"))
from release_support import validate_static


def verify_wheel(wheel: Path) -> dict[str, Any]:
    """检查真实 wheel 的所有成员与 RECORD 精确对应，再用同一静态校验器验证解压资源；返回可绑定 release.json 的构建身份，发现重复、额外或篡改字节即失败。

    RECORD 自身不带散列是 wheel 标准规定的唯一例外。
    ZIP 中的路径不能携带绝对地址或父目录段。
    迁移、OpenAPI 和 Schema 都是控制服务运行所需资源。
    文件权限只允许普通文件，归档链接不能成为安装路径跳转。
    """
    with (
        zipfile.ZipFile(wheel) as archive,
        tempfile.TemporaryDirectory(prefix="veriq-wheel-") as temporary,
    ):
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate wheel member")
        for entry in archive.infolist():
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if (
                path.is_absolute()
                or any(part in {"", ".", ".."} for part in entry.filename.split("/"))
                or "\\" in entry.filename
            ):
                raise ValueError("Unsafe wheel member")
            if stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                raise ValueError("Unsafe wheel member type")
        records = [name for name in names if name.endswith(".dist-info/RECORD")]
        if len(records) != 1:
            raise ValueError("Wheel RECORD missing or ambiguous")
        seen = set()
        for name, digest, size in csv.reader(io.StringIO(archive.read(records[0]).decode())):
            if name in seen or name not in names:
                raise ValueError("Wheel RECORD member mismatch")
            seen.add(name)
            if name == records[0] and not digest and not size:
                continue
            content = archive.read(name)
            expected = "sha256=" + base64.urlsafe_b64encode(
                sha256(content).digest()
            ).decode().rstrip("=")
            if digest != expected or size != str(len(content)):
                raise ValueError("Wheel RECORD content mismatch")
        if seen != set(names):
            raise ValueError("Wheel RECORD closure mismatch")
        required = {
            "veriq_server/static/dist/index.html",
            "veriq_server/_openapi.json",
            "veriq_server/__init__.py",
            "veriq_server/__main__.py",
            "veriq_server/migrations/env.py",
            "veriq_server/release/engine-inventory.json",
            "veriq_server/release/LICENSE",
            "veriq_server/release/NOTICE",
            "veriq_server/release/server.example.json",
            "veriq_server/release/version.json",
        }
        if (
            not required <= set(names)
            or not any(name.startswith("veriq_server/migrations/versions/") for name in names)
            or not any(name.startswith("veriq_server/_schemas/") for name in names)
        ):
            raise ValueError("Required server package resources are missing")
        metadata = records[0].removesuffix("RECORD") + "METADATA"
        version = BytesParser().parsebytes(archive.read(metadata))["Version"]
        archive.extractall(temporary)
        info = validate_static(Path(temporary) / "veriq_server/static/dist", version)
        return {
            "wheel": wheel.name,
            "sha256": sha256(wheel.read_bytes()).hexdigest(),
            "buildInfo": info,
        }


def clean_install(wheel: Path, wheelhouse: Path, evidence: Path) -> dict[str, Any]:
    """在仓库外创建空虚拟环境并仅通过离线 wheelhouse 安装候选，随后以只读包和空 PATH 启动真实生产服务；安装依赖、HTTP 行为及进程退出任何一步失败都不能形成成功证明。

    临时环境验证后删除，避免占用发行构建机的有限空间。
    安装日志写入调用方指定证据目录，而非输出机密配置。
    探测只使用合成配置，不读取实际签发者或业务凭证。
    不验证 MySQL 迁移，这个独立断言负责包安装与静态运行闭包。
    """
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="veriq-clean-install-") as directory:
        root = Path(directory)
        environment = root / "venv"
        python = environment / "bin/python"
        commands = [
            ["uv", "venv", "--python", sys.executable, str(environment)],
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                "--no-index",
                "--find-links",
                str(wheelhouse.resolve()),
                str(wheel.resolve()),
            ],
        ]
        with (evidence / "clean-install.log").open("w") as log:
            for command in commands:
                subprocess.run(command, cwd=root, check=True, stdout=log, stderr=subprocess.STDOUT)
            probe = Path(__file__).with_name("probe_install.py").read_text()
            try:
                result = subprocess.run(
                    [str(python), "-I", "-B", "-c", probe],
                    cwd=root,
                    env={"PATH": "", "PYTHONDONTWRITEBYTECODE": "1"},
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except subprocess.CalledProcessError as error:
                log.write((error.stdout or "") + (error.stderr or ""))
                raise
            finally:
                server_log = root / "server.log"
                if server_log.exists():
                    (evidence / "installed-server.log").write_bytes(server_log.read_bytes())
            log.write(result.stderr)
        report = cast(dict[str, Any], json.loads(result.stdout))
        subprocess.run(
            [
                sys.executable,
                "-m",
                "cyclonedx_py",
                "environment",
                str(python),
                "--output-reproducible",
                "--gather-license-texts",
                "--validate",
                "-o",
                str((evidence / "server-sbom.json").resolve()),
            ],
            check=True,
            cwd=root,
        )
        (evidence / "clean-install.json").write_text(json.dumps(report, indent=2) + "\n")
        return report


def main() -> None:
    """命令行默认只验证 wheel 字节，显式指定 wheelhouse 后再做真实离线安装；两种模式的报告字段不同，因此调用方不能把静态检查误写成已经完成无 Node 生产启动验收。

    错误保留英文操作诊断，并以非零退出码阻断发布。
    evidence 只记录构建输入和结果，不携带业务数据。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--wheelhouse", type=Path)
    parser.add_argument("--evidence", type=Path, default=Path("work/package-evidence"))
    args = parser.parse_args()
    try:
        report = verify_wheel(args.wheel)
        if args.wheelhouse:
            report["cleanInstall"] = clean_install(args.wheel, args.wheelhouse, args.evidence)
        print(json.dumps(report))
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as error:
        message = (
            "Installed wheel subprocess failed; inspect evidence logs"
            if isinstance(error, subprocess.CalledProcessError)
            else str(error)
        )
        parser.exit(1, f"Wheel verification failed: {message}\n")


if __name__ == "__main__":
    main()
