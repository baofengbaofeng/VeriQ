"""VeriQ 备份目录以私有普通文件保存数据库逻辑快照及制品字节，所有路径从固定快照根解析并拒绝链接，清单摘要绑定每个载荷以便恢复前完成全量完整性核验。"""

import base64
from datetime import datetime
from decimal import Decimal
from hashlib import sha256
import os
from pathlib import Path, PurePosixPath
import stat
from typing import Any


def encode_value(value: Any) -> dict[str, Any]:
    """为数据库列值增加独立类型标签，避免二进制和时间戳在 JSON 中丢失精度，也避免业务 JSON 恰好使用相同键名时被恢复器误识别为特殊类型或执行任何对象反序列化。"""
    if isinstance(value, bytes):
        return {"kind": "bytes", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, datetime):
        return {"kind": "datetime", "value": value.isoformat(timespec="microseconds")}
    if isinstance(value, Decimal):
        return {"kind": "decimal", "value": str(value)}
    return {"kind": "json", "value": value}


def decode_value(value: dict[str, Any]) -> Any:
    """仅解码备份格式显式支持的列类型并拒绝未知标签，不使用 pickle 或可执行 SQL，从而让恢复载荷只能通过已安装的 SQLAlchemy 表定义和数据库约束写入目标。"""
    if not isinstance(value, dict) or set(value) != {"kind", "value"}:
        raise ValueError("SNAPSHOT_VALUE_INVALID")
    kind, content = value["kind"], value["value"]
    if kind == "bytes":
        return base64.b64decode(content, validate=True)
    if kind == "datetime":
        return datetime.fromisoformat(content)
    if kind == "decimal":
        return Decimal(content)
    if kind == "json":
        return content
    raise ValueError("SNAPSHOT_VALUE_INVALID")


def private_file(path: Path, payload: bytes) -> None:
    """在已经受控的私有目录内独占创建文件并同步字节，已有文件直接失败而不是截断；备份包含解密所需密钥和口令哈希，因此每份载荷都固定采用操作员独占读写权限。"""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb"
    ) as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def safe_snapshot_file(root: Path, name: str) -> Path:
    """只接受清单中规范的相对 POSIX 文件路径并逐级拒绝符号链接，快照根也必须是私有真实目录；恢复前的摘要核验和随后读取共享这一入口，不允许越界载荷替换操作员配置。"""
    relative = PurePosixPath(name)
    if (
        not name
        or relative.is_absolute()
        or str(relative) != name
        or any(part in {".", ".."} for part in relative.parts)
    ):
        raise ValueError("SNAPSHOT_PATH_INVALID")
    if root.is_symlink() or not root.is_dir() or root.stat().st_mode & 0o077:
        raise ValueError("SNAPSHOT_DIRECTORY_UNSAFE")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("SNAPSHOT_PATH_UNSAFE")
    info = current.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("SNAPSHOT_FILE_UNSAFE")
    return current


def file_digest(path: Path) -> str:
    """以固定大小块计算整个文件的摘要而不把数据库快照或大制品一次性读入内存，文件打开时再次拒绝最终链接，读取错误会使备份或恢复整体失败而不产生成功回执。"""
    digest = sha256()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root: Path) -> dict[str, dict[str, Any]]:
    """在备份写完之后登记所有普通载荷的精确大小与摘要，目录树中的链接或特殊设备一律拒绝；完成清单自身稍后单独写入，其摘要由 CLI 返回给操作员作为独立恢复确认材料。"""
    result = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        if any((parent / name).is_symlink() for name in directories):
            raise ValueError("SNAPSHOT_LINK_UNSAFE")
        for name in files:
            path = parent / name
            relative = path.relative_to(root).as_posix()
            safe_snapshot_file(root, relative)
            result[relative] = {"size": path.stat().st_size, "sha256": file_digest(path)}
    return result


def copy_tree(source: Path, target: Path, *, existing_target: bool = False) -> None:
    """通过目录描述符递归复制外置制品并保留零字节退役对象，任何祖先链接、设备文件或源文件变化都会拒绝；复制使用私有目标权限，不从备份继承可执行位或宽松访问控制。"""
    source = source.absolute()
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in source.parts[1:]:
            child = os.open(
                component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor
            )
            os.close(descriptor)
            descriptor = child

        def copy_directory(directory_fd: int, destination: Path, *, root: bool = False) -> None:
            destination.mkdir(mode=0o700, parents=True, exist_ok=existing_target and root)
            for name in os.listdir(directory_fd):
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(
                        name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd
                    )
                    try:
                        copy_directory(child, destination / name)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    source_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
                    with os.fdopen(source_fd, "rb") as reader:
                        target_fd = os.open(
                            destination / name,
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                            0o600,
                        )
                        with os.fdopen(target_fd, "wb") as writer:
                            before = os.fstat(reader.fileno())
                            while chunk := reader.read(1024 * 1024):
                                writer.write(chunk)
                            writer.flush()
                            os.fsync(writer.fileno())
                            after = os.fstat(reader.fileno())
                            if (before.st_ino, before.st_size, before.st_mtime_ns) != (
                                after.st_ino,
                                after.st_size,
                                after.st_mtime_ns,
                            ):
                                raise ValueError("SNAPSHOT_SOURCE_CHANGED")
                else:
                    raise ValueError("SNAPSHOT_SOURCE_UNSAFE")
            output_directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(output_directory)
            finally:
                os.close(output_directory)

        copy_directory(descriptor, target, root=True)
    finally:
        os.close(descriptor)
