"""VeriQ 发行编排器按前端检查构建、完整暂存、服务检查测试、wheel、干净安装和原子输出顺序执行，所有阶段以同一源码及锁文件身份绑定；失败证据保留在 work，而成功指针最后才切换。

应急跳过只影响动态测试，不影响类型、格式、注释或包完整性门禁。
构建独占锁覆盖所有共享暂存文件，取消也不会产生成功 release.json。
正常发布要求在 Ubuntu24.04 x64 与 Python3.12 上实际验证。
容器镜像有独立流水线，不能把宿主验证写成镜像证明。
"""

import argparse
from dataclasses import dataclass
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from typing import Any
import uuid
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage_web import stage_web
from verify_wheel import verify_wheel, clean_install
from wheelhouse import wheelhouse
from npm_sbom import npm_sbom
from release_support import safe_path


@dataclass(frozen=True)
class BuildOptions:
    """构建参数明确是否跳过动态测试、对应原因和新引擎版本，根目录来自入口而非任意清理目标；调用方不能通过选项关闭静态、包完整性或目标平台验证。

    默认值代表正常完整发行。
    引擎版本独立于产品版本，旧库存不在构建时自动晋升。
    """

    root: Path
    skip_tests: bool = False
    reason: str | None = None
    engine_version: str = "1.0.0"


ReleaseManifest = dict[str, Any]


def source_binding(root: Path) -> dict[str, str]:
    """记录全部受版本控制的源码与新增未忽略文件的精确散列，构建结束时重新读取并比较；生成物与私有证据不进入 Git 文件集合，锁文件仍明确参与相同身份检查。

    字节身份比单独的 commit 更严格，能够检测脏工作区或运行期间编辑。
    正常发行仍另外要求工作区干净，候选验证可独立使用这份映射。
    """
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        text=True,
    ).splitlines()
    return {
        name: sha256((root / name).read_bytes()).hexdigest()
        for name in sorted(set(names))
        if (root / name).is_file() and not name.startswith(".superpowers/")
    }


def publish(candidate: Path, output: Path) -> None:
    """候选具备验证状态与摘要清单后才移动到不可变目录并原子替换 server 符号链接；任何前置校验失败都保留旧指针，已有普通目录不会被递归清理或静默覆盖。

    版本目录与指针位于同一文件系统，os.replace 提供单次切换。
    旧版本保留供运维审查和回滚，构建器不自动删除历史发行。
    发布前核对 sha256sums，防止最后阶段的文件修改被遗漏。
    """
    safe_path(candidate)
    manifest = json.loads((candidate / "release.json").read_bytes())
    if manifest.get("status") != "VERIFIED" or not (candidate / "sha256sums").is_file():
        raise ValueError("Only fully verified releases can be published")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", manifest.get("buildId", "")):
        raise ValueError("Unsafe release build identity")
    listed = set()
    for line in (candidate / "sha256sums").read_text().splitlines():
        digest, name = line.split("  ", 1)
        if name in listed:
            raise ValueError("Duplicate release checksum entry")
        listed.add(name)
        path = candidate / name
        safe_path(path)
        if (
            not path.resolve().is_relative_to(candidate.resolve())
            or sha256(path.read_bytes()).hexdigest() != digest
        ):
            raise ValueError("Release checksum mismatch")
    actual = {
        path.relative_to(candidate).as_posix()
        for path in candidate.rglob("*")
        if path.is_file() and path.name != "sha256sums"
    }
    if actual != listed:
        raise ValueError("Release checksum closure mismatch")
    safe_path(output)
    output.mkdir(parents=True, exist_ok=True)
    current = output / "server"
    if current.exists() and not current.is_symlink():
        raise ValueError("Existing output/server must be migrated explicitly")
    destination = output / ("server-" + manifest["buildId"])
    if destination.exists():
        raise ValueError("Immutable release destination already exists")
    candidate.rename(destination)
    pointer = output / (".server-" + uuid.uuid4().hex)
    try:
        pointer.symlink_to(destination.name, target_is_directory=True)
        os.replace(pointer, current)
        fd = os.open(output, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        pointer.unlink(missing_ok=True)


def build_release(options: BuildOptions) -> ReleaseManifest:
    """在独占构建锁内运行真实工具与默认完整测试，逐阶段保存命令、开始结束时间和退出结果；只有完整包校验、离线启动、源码复核与目标 ABI 验收全部成功后才发布。

    子进程继承显式测试配置但日志不打印环境变量。
    数据库相关测试统一由同一 flock 串行，避免夹具互相清空数据库。
    SDK 保持原始两个工作进程和超时，不配置重试到通过。
    缺测试配置或浏览器的默认构建直接失败。
    所有测试跳过状态写入 release，常规 CI 还会明确拒绝应急包。
    """
    root = options.root.resolve()
    if options.skip_tests and not (options.reason and options.reason.strip()):
        raise ValueError("--skip-tests requires --reason")
    work = root / "work"
    safe_path(work)
    work.mkdir(exist_ok=True)
    fd = os.open(work / "build.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        identifier = (
            time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:12]
        )
        run = work / ("release-" + identifier)
        run.mkdir()
        records = []

        def command(name: str, argv: list[str]) -> None:
            """每个真实命令单独保存日志与时间，退出失败时立刻写入阶段记录并中止后续步骤；不捕获并忽略 CalledProcessError，也不把缺条件的测试改成成功状态。

            argv 是数组，不经 shell 插值。
            记录仅包含公开命令参数，不读取机密环境值。
            """
            started = time.time()
            interrupted: BaseException | None = None
            with (run / f"{name}.log").open("w") as log:
                process = subprocess.Popen(
                    argv,
                    cwd=root,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    env={
                        **os.environ,
                        "MYPYPATH": os.pathsep.join(
                            [str(root / "apps/srv"), str(root / "scripts")]
                        ),
                    },
                )
                try:
                    result_code = process.wait()
                except BaseException as error:
                    interrupted = error
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    result_code = process.returncode
            records.append(
                {
                    "name": name,
                    "argv": argv,
                    "cwd": str(root),
                    "started": started,
                    "finished": time.time(),
                    "exitCode": result_code,
                }
            )
            (run / "commands.json").write_text(json.dumps(records, indent=2) + "\n")
            if interrupted is not None:
                raise interrupted
            if result_code:
                raise RuntimeError(
                    f"Release phase failed: {name}; see {run / (name + '.log')}"
                )

        if sys.version_info[:2] != (3, 12) or platform.machine() != "x86_64":
            raise ValueError("Release requires Python 3.12 and Linux x64")
        for tool, expected in [
            ("node", "v24.22.1"),
            ("pnpm", "11.25.0"),
            ("uv", "uv 0.13.5"),
        ]:
            actual = subprocess.check_output([tool, "--version"], text=True).strip()
            if not actual.startswith(expected):
                raise ValueError(f"Unsupported release tool version: {tool}")
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip()
        if subprocess.check_output(
            ["git", "status", "--porcelain", "--untracked-files=normal"], cwd=root
        ).strip():
            raise ValueError("Normal release requires a clean committed source tree")
        binding = source_binding(root)
        (run / "source-binding.json").write_text(
            json.dumps(binding, sort_keys=True, indent=2) + "\n"
        )
        command("pnpm-install", ["pnpm", "install", "--frozen-lockfile"])
        command("web-check", ["pnpm", "--filter", "@veriq/web", "check"])
        command("web-build", ["pnpm", "--filter", "@veriq/web", "build"])
        info = stage_web(root, commit, identifier)
        command(
            "python-sync",
            ["uv", "sync", "--project", "apps/srv", "--frozen", "--all-groups"],
        )
        command("types", ["pnpm", "check"])
        command("lint", ["pnpm", "lint"])
        command("format", ["pnpm", "format:check"])
        command(
            "ruff",
            [sys.executable, "-m", "ruff", "check", "apps/srv", "scripts", "tests"],
        )
        command(
            "ruff-format",
            [
                sys.executable,
                "-m",
                "ruff",
                "format",
                "--check",
                "apps/srv",
                "scripts",
                "tests",
            ],
        )
        command(
            "mypy",
            [
                sys.executable,
                "-m",
                "mypy",
                "--config-file",
                "apps/srv/pyproject.toml",
                "apps/srv/src",
            ],
        )
        command(
            "build-types",
            [
                sys.executable,
                "-m",
                "mypy",
                "--config-file",
                "apps/srv/pyproject.toml",
                "scripts",
                "apps/srv/hatch_build.py",
                "apps/srv/release_support.py",
            ],
        )
        command(
            "engine-types",
            [
                "pnpm",
                "--filter",
                "@veriq/contracts",
                "exec",
                "tsc",
                "--noEmit",
                "--project",
                "../../scripts/tsconfig.json",
            ],
        )
        command(
            "comments",
            [
                sys.executable,
                "scripts/comment_audit.py",
                "--output",
                str(run / "comment-audit.json"),
            ],
        )
        if not options.skip_tests:
            command(
                "test-conditions",
                [
                    "flock",
                    "/tmp/veriq-t12-db.lock",
                    sys.executable,
                    "scripts/test_conditions.py",
                ],
            )
            command(
                "python-tests",
                [
                    "flock",
                    "/tmp/veriq-t12-db.lock",
                    sys.executable,
                    "-m",
                    "pytest",
                    "-c",
                    "apps/srv/pyproject.toml",
                    "apps/srv/tests",
                    "tests/acceptance",
                    "--cov=veriq_server",
                    "--cov-fail-under=75",
                    "--junitxml=" + str(run / "python-junit.xml"),
                ],
            )
            if any(
                int(suite.get("skipped", "0"))
                for suite in ET.parse(run / "python-junit.xml").iter("testsuite")
            ):
                raise ValueError("Default release tests must not be skipped")
            command("contracts-tests", ["pnpm", "--filter", "@veriq/contracts", "test"])
            command(
                "compiler-tests",
                ["pnpm", "--filter", "@veriq/compiler", "test:coverage"],
            )
            command(
                "sdk-tests",
                [
                    "flock",
                    "/tmp/veriq-t12-db.lock",
                    "pnpm",
                    "--filter",
                    "@veriq/runner-sdk",
                    "test:coverage",
                ],
            )
            command(
                "runtime-tests",
                [
                    "flock",
                    "/tmp/veriq-t12-db.lock",
                    "pnpm",
                    "--filter",
                    "@veriq/runtime",
                    "test",
                ],
            )
            command(
                "web-tests",
                [
                    "flock",
                    "/tmp/veriq-t12-db.lock",
                    "pnpm",
                    "--filter",
                    "@veriq/web",
                    "test:e2e",
                ],
            )
        engine = run / "engine"
        command(
            "engine",
            [
                "pnpm",
                "--filter",
                "@veriq/contracts",
                "exec",
                "tsx",
                "../../scripts/build_engine.mts",
                options.engine_version,
                str(engine),
            ],
        )
        destination = root / "apps/srv/src/veriq_server/release/engine-inventory.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(engine / "inventory.json", destination)
        wheel_output = work / "server-wheel"
        safe_path(wheel_output)
        wheel_output.mkdir(exist_ok=True)
        for previous in wheel_output.glob("*.whl"):
            safe_path(previous)
            previous.unlink()
        command(
            "wheel",
            [
                "uv",
                "run",
                "--project",
                "apps/srv",
                "--frozen",
                "--all-groups",
                "python",
                "-m",
                "build",
                "--wheel",
                "--no-isolation",
                "apps/srv",
                "--outdir",
                "work/server-wheel",
            ],
        )
        wheels = list((work / "server-wheel").glob("*.whl"))
        if len(wheels) != 1:
            raise ValueError("Wheel output must contain exactly one artifact")
        wheel = wheels[0]
        verified = verify_wheel(wheel)
        house = run / "wheelhouse"
        locked_wheels = wheelhouse(root, house)
        installed = clean_install(wheel, house, run / "installation")
        if (
            platform.freedesktop_os_release().get("ID") != "ubuntu"
            or platform.freedesktop_os_release().get("VERSION_ID") != "24.04"
        ):
            raise ValueError(
                "Ubuntu 24.04 target acceptance must run on the target OS; host candidate is not a release"
            )
        if source_binding(root) != binding:
            raise ValueError("Source changed during release")
        candidate = run / "candidate"
        candidate.mkdir()
        shutil.copy2(wheel, candidate / wheel.name)
        shutil.copytree(root / "deploy", candidate / "deploy")
        shutil.copytree(house, candidate / "wheelhouse")
        shutil.copytree(engine, candidate / "engine")
        shutil.copy2(root / "THIRD_PARTY_NOTICES.md", candidate / "NOTICE")
        shutil.copy2(run / "installation/server-sbom.json", candidate / "SBOM.json")
        npm_metadata = npm_sbom(root, candidate / "frontend")
        shutil.copytree(run / "installation", candidate / "evidence/installation")
        for name in ("source-binding.json", "commands.json"):
            shutil.copy2(run / name, candidate / "evidence" / name)
        shutil.copy2(
            root / "apps/srv/src/veriq_server/static/dist/static-manifest.json",
            candidate / "static-manifest.json",
        )
        engine_metadata = json.loads((engine / "inventory.json").read_bytes())[
            "engines"
        ][0]
        manifest = {
            "status": "VERIFIED",
            "version": info["version"],
            "buildId": identifier,
            "commit": commit,
            "staticManifestHash": info["staticManifestHash"],
            "testsSkipped": options.skip_tests,
            "skipReason": options.reason,
            "engineVersion": options.engine_version,
            "compilerVersion": engine_metadata["compilerVersion"],
            "runnerSdkVersion": engine_metadata["runnerSdkVersion"],
            "engineInventorySha256": sha256(
                (engine / "inventory.json").read_bytes()
            ).hexdigest(),
            "locks": {
                name: binding[name] for name in ("pnpm-lock.yaml", "apps/srv/uv.lock")
            },
            "frontendSbom": npm_metadata,
            "sourceBindingSha256": sha256(
                (run / "source-binding.json").read_bytes()
            ).hexdigest(),
            "wheel": verified,
            "wheelhouse": locked_wheels,
            "installation": installed,
        }
        (candidate / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")

        def checksums() -> str:
            """递归散列候选内全部普通文件并以相对路径记录，先生成归档内清单再增加归档本身摘要；仅排除清单自身，避免循环哈希，同时覆盖部署脚本、许可与 wheelhouse 的独立文件。

            内层清单用于解压后的离线安装检查。
            外层清单额外绑定最终压缩包字节。
            """
            return "".join(
                f"{sha256(path.read_bytes()).hexdigest()}  {path.relative_to(candidate).as_posix()}\n"
                for path in sorted(candidate.rglob("*"))
                if path.is_file() and path.name != "sha256sums"
            )

        (candidate / "sha256sums").write_text(checksums())
        with tarfile.open(
            candidate / f"veriq-server-{info['version']}-linux-x64.tar.gz", "w:gz"
        ) as archive:
            for path in sorted(candidate.iterdir()):
                if not path.name.endswith(".tar.gz"):
                    archive.add(path, arcname=path.name)
        (candidate / "sha256sums").write_text(checksums())
        publish(candidate, root / "output")
        return manifest


def main() -> None:
    """默认执行全部门禁，with-tests 是相同语义的显式别名，skip-tests 必须附带非空原因；命令行不会提供绕过静态验证或目标平台验证的隐藏选项。

    错误结束保留 work 内日志，由操作员读取对应阶段。
    正常输出只有完整成功后返回的公开发行描述。
    """
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--with-tests", action="store_true")
    group.add_argument("--skip-tests", action="store_true")
    parser.add_argument("--reason")
    parser.add_argument("--engine-version", default="1.0.0")
    args = parser.parse_args()
    if args.skip_tests and not (args.reason and args.reason.strip()):
        parser.error("--skip-tests requires --reason")
    if args.reason and not args.skip_tests:
        parser.error("--reason requires --skip-tests")
    try:
        print(
            json.dumps(
                build_release(
                    BuildOptions(
                        Path(__file__).resolve().parents[1],
                        args.skip_tests,
                        args.reason,
                        args.engine_version,
                    )
                )
            )
        )
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release failed: {error}\n")


if __name__ == "__main__":
    main()
