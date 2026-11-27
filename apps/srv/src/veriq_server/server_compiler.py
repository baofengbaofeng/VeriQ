"""服务端编译专用执行器为每个作业创建私有目录，仅使用已批准的发行字节及运维钉选的本机工具，不接触设备认证。"""

import asyncio
import hashlib
import json
import os
import re
import signal
import stat
import tarfile
from contextlib import ExitStack, suppress
from functools import lru_cache
from importlib import resources
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .contracts import canonical_bytes, validate_schema
from .settings import Settings

_RELEASE_LIMIT = 128 * 1024 * 1024
_RESULT_LIMIT = 2 * 1024 * 1024
_SNAPSHOT_LIMIT = 16 * 1024 * 1024
_REQUIRED = frozenset(
    {"package.json", "package-lock.json", "dependencies.json", "engine/compiler.tgz"}
)
_MEMBER_SEGMENT = re.compile(r"[a-zA-Z0-9._-]+")
_SAFE_VENDOR = re.compile(r"vendor/[a-zA-Z0-9._-]+\.tgz")
_CODE = re.compile(r"[A-Z][A-Z_0-9]{0,79}")
_TSX_VERSION = "4.23.15"


class ServerCompileError(RuntimeError):
    """专用编译失败只携带稳定错误码和已通过契约检查的诊断，避免将私有路径、环境或源码抄进作业回应。"""

    def __init__(self, code: str, diagnostics: list[dict[str, Any]] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics if diagnostics is not None else []


def _relative_parts(value: str) -> tuple[str, ...]:
    """所有暂存成员使用可移植相对路径，拒绝空片段、回退目录和不属于锁定产物名称字符集的内容。"""
    parts = tuple(value.split("/"))
    if any(part in {".", ".."} or not _MEMBER_SEGMENT.fullmatch(part) for part in parts):
        raise ServerCompileError("UNSAFE_COMPILER_PATH")
    return parts


def _regular_bytes(root: Path, relative: str, limit: int) -> bytes:
    """从已打开目录描述符逐层访问文件，拒绝链接和特殊文件，通过有界读取防止损坏发行成员耗尽进程内存。"""
    parts = _relative_parts(relative)
    flags = os.O_RDONLY | os.O_NOFOLLOW
    with ExitStack() as stack:
        directory = os.open(root, flags | os.O_DIRECTORY)
        stack.callback(os.close, directory)
        for part in parts[:-1]:
            directory = os.open(part, flags | os.O_DIRECTORY, dir_fd=directory)
            stack.callback(os.close, directory)
        descriptor = os.open(parts[-1], flags | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
                raise ServerCompileError("COMPILER_FILE_LIMIT")
            data = stream.read(limit + 1)
    if len(data) > limit:
        raise ServerCompileError("COMPILER_FILE_LIMIT")
    return data


def _stage_release(root: Path, work: Path | None, engine: dict[str, Any]) -> bytes:
    """逐项向私有目录写入经过 SHA-256 核对的发行成员，仅在全量清单吻合时把真实编译器归档交给解包步骤。"""
    seen: set[str] = set()
    remaining = _RELEASE_LIMIT
    archive = b""
    try:
        for file in engine["files"]:
            name = file["path"]
            if name in seen or (name not in _REQUIRED and not _SAFE_VENDOR.fullmatch(name)):
                raise ServerCompileError("UNSAFE_ENGINE_RELEASE")
            seen.add(name)
            content = _regular_bytes(root, name, remaining)
            if (
                len(content) != file["sizeBytes"]
                or hashlib.sha256(content).hexdigest() != file["sha256"]
            ):
                raise ServerCompileError("ENGINE_RELEASE_HASH_MISMATCH")
            remaining -= len(content)
            if work is not None:
                destination = work / name
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                destination.write_bytes(content)
            if name == "engine/compiler.tgz":
                archive = content
    except OSError as error:
        raise ServerCompileError("ENGINE_RELEASE_UNAVAILABLE") from error
    if not _REQUIRED <= seen or not archive:
        raise ServerCompileError("INCOMPLETE_ENGINE_RELEASE")
    return archive


@lru_cache(maxsize=64)
def _verified_release(
    root: Path, inventory: bytes, _file_identities: tuple[tuple[int, ...], ...]
) -> bool:
    """文件身份或批准库存变化时重新校验全部发行字节，文件未变化时可以在连续轮询之间复用校验结论。"""
    _stage_release(root, None, json.loads(inventory))
    return True


def local_release_available(settings: Settings, engine: dict[str, Any]) -> bool:
    """使用编译阶段的有界读取和摘要校验确认本机具备完整发行，编译时还会重新验证实际复制的字节。"""
    try:
        root = configured_release_path(settings, engine["engineVersion"]).resolve(strict=True)
        identities = []
        for member in engine["files"]:
            stat_result = root.joinpath(*_relative_parts(member["path"])).stat()
            identities.append(
                (
                    stat_result.st_dev,
                    stat_result.st_ino,
                    stat_result.st_size,
                    stat_result.st_ctime_ns,
                )
            )
        return _verified_release(root, canonical_bytes(engine), tuple(identities))
    except (OSError, ServerCompileError):
        return False


def _extract_compiler(work: Path) -> None:
    """只手工写入已验证归档内的普通文件和目录，放弃归档附带的权限、所有权、链接及其它文件系统状态。"""
    archive = work / "engine" / "compiler.tgz"
    destination = work / "engine" / "compiler"
    destination.mkdir(mode=0o700)
    seen: set[str] = set()
    remaining = _RELEASE_LIMIT
    try:
        with tarfile.open(archive, "r|gz") as entries:
            for entry in entries:
                name = entry.name
                parts = _relative_parts(name)
                if (
                    name in seen
                    or len(seen) >= 10_000
                    or parts[0] not in {"src", "LICENSE", "package.json"}
                    or not (entry.isdir() or entry.isreg())
                    or not 0 <= entry.size <= remaining
                ):
                    raise ServerCompileError("UNSAFE_ENGINE_ARCHIVE")
                seen.add(name)
                remaining -= entry.size
                path = destination.joinpath(*parts)
                if entry.isdir():
                    path.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                source = entries.extractfile(entry)
                if source is None:
                    raise ServerCompileError("UNSAFE_ENGINE_ARCHIVE")
                with source:
                    content = source.read()
                if len(content) != entry.size:
                    raise ServerCompileError("UNSAFE_ENGINE_ARCHIVE")
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with path.open("xb") as opened:
                    opened.write(content)
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ServerCompileError("UNSAFE_ENGINE_ARCHIVE") from error
    if not {"src/index.ts", "package.json"} <= seen:
        raise ServerCompileError("INCOMPLETE_ENGINE_RELEASE")


def _verify_lock(work: Path, engine: dict[str, Any]) -> None:
    """安装前检查根依赖和冻结条目只引用已经核验的 vendor 归档，避免离线安装仍读取工作目录外的本机依赖。"""
    package = json.loads(_regular_bytes(work, "package.json", _RESULT_LIMIT))
    lock = json.loads(_regular_bytes(work, "package-lock.json", _RESULT_LIMIT))
    available = {
        "file:" + item["path"] for item in engine["files"] if _SAFE_VENDOR.fullmatch(item["path"])
    }
    if not isinstance(package, dict) or not isinstance(lock, dict):
        raise ServerCompileError("UNSAFE_ENGINE_LOCK")
    locked = lock.get("packages")
    direct = package.get("dependencies")
    if lock.get("lockfileVersion") != 3:
        raise ServerCompileError("UNSAFE_ENGINE_LOCK")
    if (
        not isinstance(direct, dict)
        or not isinstance(locked, dict)
        or not isinstance(locked.get(""), dict)
        or any(key not in {"name", "version", "type", "private", "dependencies"} for key in package)
        or any(not isinstance(ref, str) or ref not in available for ref in direct.values())
    ):
        raise ServerCompileError("UNSAFE_ENGINE_LOCK")
    for name, item in locked.items():
        if not name:
            continue
        if (
            not name.startswith("node_modules/")
            or not isinstance(item, dict)
            or not isinstance(item.get("resolved"), str)
            or item["resolved"] not in available
        ):
            raise ServerCompileError("UNSAFE_ENGINE_LOCK")
        if (
            not isinstance(item.get("integrity"), str)
            or not item["integrity"].startswith("sha512-")
            or any(
                item.get(flag)
                for flag in ("link", "hasInstallScript", "dev", "optional", "inBundle")
            )
        ):
            raise ServerCompileError("UNSAFE_ENGINE_LOCK")


def _absolute_path(value: str | None) -> Path:
    """工作进程必须获明确绝对路径，避免启动目录、用户环境和系统搜索路径影响实际使用的编译工具或发行身份。"""
    if value is None or not Path(value).is_absolute():
        raise ServerCompileError("SERVER_COMPILER_NOT_CONFIGURED")
    return Path(value)


def configured_release_path(settings: Settings, engine_version: str) -> Path:
    """按批准清单中作业的冻结版本选择明确配置的目录，单版本目录仅作为当前引擎版本的回退。"""
    chosen = settings.server_compiler_release_dirs.get(engine_version)
    if chosen is None and engine_version == settings.validation_engine_version:
        chosen = settings.server_compiler_release_dir
    return _absolute_path(chosen)


def _tools(settings: Settings) -> tuple[Path, Path, Path]:
    """解析操作员指定的工具路径并检查已锁定的加载器包，确保控制服务不会通过全局路径偶然获得编译能力。"""
    try:
        node = _absolute_path(settings.server_compiler_node_path).resolve(strict=True)
        npm = _absolute_path(settings.server_compiler_npm_cli_path).resolve(strict=True)
        tsx = _absolute_path(settings.server_compiler_tsx_path).resolve(strict=True)
        manifest = json.loads(_regular_bytes(tsx.parent.parent, "package.json", 64 * 1024))
    except (OSError, ValueError) as error:
        raise ServerCompileError("SERVER_COMPILER_TOOL_UNAVAILABLE") from error
    if not (
        node.is_file()
        and npm.is_file()
        and npm.name == "npm-cli.js"
        and tsx.is_file()
        and tsx.name == "loader.mjs"
        and isinstance(manifest, dict)
        and manifest.get("name") == "tsx"
        and manifest.get("version") == _TSX_VERSION
    ):
        raise ServerCompileError("SERVER_COMPILER_TOOL_UNAVAILABLE")
    return node, npm, tsx


async def _run(
    argv: list[str], cwd: Path, env: dict[str, str], failure: str, *, capture: bool = False
) -> bytes:
    """启动独立进程组并限制实际运行时间，超时或取消时回收编译子进程，普通子进程输出不进入 API 或日志。"""
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            start_new_session=True,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as error:
        raise ServerCompileError(failure) from error
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=45)
    except (TimeoutError, asyncio.CancelledError) as error:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
        if isinstance(error, asyncio.CancelledError):
            raise
        raise ServerCompileError(failure) from error
    if process.returncode != 0:
        raise ServerCompileError(failure)
    return output or b""


def _collect_output(work: Path, archive: bytes) -> tuple[bytes, dict[str, bytes]]:
    """仅回传描述符声明且摘要吻合的实际编译字节，失败结果中的结构化诊断需先通过共享契约再离开隔离目录。"""
    output = work / "compiled"
    if (work / "diagnostics.json").exists():
        diagnostics = json.loads(_regular_bytes(work, "diagnostics.json", _RESULT_LIMIT))
        if (
            isinstance(diagnostics, list)
            and 0 < len(diagnostics) <= 100
            and all(not validate_schema("CompilerDiagnosticV1", issue) for issue in diagnostics)
        ):
            code = diagnostics[0]["code"]
            if _CODE.fullmatch(code):
                raise ServerCompileError(code, diagnostics)
        raise ServerCompileError("COMPILATION_FAILED")
    bundle = _regular_bytes(output, "bundle.json", _RESULT_LIMIT)
    descriptor = json.loads(bundle)
    if validate_schema("CompiledAssetBundle", descriptor) or canonical_bytes(descriptor) != bundle:
        raise ServerCompileError("INVALID_COMPILED_BUNDLE")
    files = {"engine/compiler.tgz": archive}
    remaining = _RELEASE_LIMIT - len(archive)
    for entry in descriptor["files"]:
        path = entry["path"]
        if path in files or path == "bundle.json":
            raise ServerCompileError("INVALID_COMPILED_BUNDLE")
        content = _regular_bytes(output, path, remaining)
        if (
            len(content) != entry["sizeBytes"]
            or hashlib.sha256(content).hexdigest() != entry["sha256"]
        ):
            raise ServerCompileError("INVALID_COMPILED_BUNDLE")
        files[path] = content
        remaining -= len(content)
    return bundle, files


async def compile_snapshot(
    settings: Settings, engine: dict[str, Any], snapshot: dict[str, Any], *, connected: bool
) -> tuple[bytes, dict[str, bytes]]:
    """运行已批准引擎上的静态分析和确定性编译，产物只来自本次私有工作目录，控制服务不承担 Node 环境依赖。"""
    if snapshot.get("engineVersion") != engine.get("engineVersion"):
        raise ServerCompileError("ENGINE_NOT_APPROVED")
    try:
        root = configured_release_path(settings, engine["engineVersion"]).resolve(strict=True)
    except OSError as error:
        raise ServerCompileError("ENGINE_RELEASE_UNAVAILABLE") from error
    try:
        with TemporaryDirectory(prefix="veriq-server-compiler-") as directory:
            work = Path(directory)
            archive = _stage_release(root, work, engine)
            _verify_lock(work, engine)
            _extract_compiler(work)
            frozen = canonical_bytes(snapshot)
            if len(frozen) > _SNAPSHOT_LIMIT:
                raise ServerCompileError("SNAPSHOT_TOO_LARGE")
            (work / "snapshot.json").write_bytes(frozen)
            (work / "release.json").write_bytes(canonical_bytes(engine))
            bridge = resources.files("veriq_server").joinpath("server_compile_entry.mjs")
            (work / "compile.mjs").write_bytes(bridge.read_bytes())
            await _execute_tools(work, settings, connected)
            return _collect_output(work, archive)
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ServerCompileError("COMPILATION_FAILED") from error


async def _execute_tools(work: Path, settings: Settings, connected: bool) -> None:
    """检查运维指定的 Node 版本，在隔离环境完成离线依赖安装及静态编译，命令不访问其他进程的配置或缓存。"""
    node, npm, tsx = _tools(settings)
    (work / "user.npmrc").touch(mode=0o600)
    (work / "global.npmrc").touch(mode=0o600)
    # 从空环境构造命令输入，禁止把服务端数据库、密钥、Node 注入选项或系统 npm 用户配置传入子进程。
    env = {"PATH": f"{node.parent}:/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work)}
    version = await _run(
        [str(node), "--version"], work, env, "SERVER_COMPILER_NODE_REQUIRED", capture=True
    )
    if not re.fullmatch(rb"v24\.\d+\.\d+\n?", version):
        raise ServerCompileError("SERVER_COMPILER_NODE_REQUIRED")
    # 发行内的依赖全部使用经过审核的本地归档，安装不访问注册表、不处理生命周期脚本，也不共享缓存。
    await _run(
        [
            str(node),
            str(npm),
            "ci",
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--update-notifier=false",
            "--userconfig",
            str(work / "user.npmrc"),
            "--globalconfig",
            str(work / "global.npmrc"),
            "--cache",
            str(work / "npm-cache"),
        ],
        work,
        env,
        "SERVER_COMPILER_INSTALL_FAILED",
    )
    argv = [str(node), "--import", tsx.as_uri(), str(work / "compile.mjs")]
    if connected:
        argv.append("--connected")
    await _run(argv, work, env, "SERVER_COMPILER_EXECUTION_FAILED")
