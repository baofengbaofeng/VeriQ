"""将制品卷上的随机标识与共享 MySQL 安装绑定，使独立空卷无法冒充已登记的卷。"""

import os
import stat
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

from .service import Problem


def check_volume(root: Path, expected: str) -> None:
    """每次访问都读取卷上已登记的完整标识，挂载丢失时拒绝操作，防止在本地空目录生成虚假的删除回执。"""
    try:
        fd = os.open(root / ".veriq-volume", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            matches = stat.S_ISREG(os.fstat(fd).st_mode) and stream.read(37) == expected.encode()
    except OSError:
        matches = False
    if not matches:
        raise Problem(503, "ARTIFACT_VOLUME_MISMATCH", "Mount the registered artifact volume")


def initial_volume(root: Path) -> str:
    """以硬链接一次发布已经写完并同步的卷标识，若数据库事务回滚，下次登记可核验同一份标识并重试。"""
    marker = root / ".veriq-volume"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    volume_id = str(uuid4())
    fd, name = tempfile.mkstemp(dir=root, prefix=".volume-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(volume_id.encode())
            stream.flush()
            os.fsync(fd)
        try:
            os.link(name, marker)
        except FileExistsError:
            fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as existing:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError("Invalid artifact volume marker") from None
                volume_id = str(UUID(existing.read(37).decode("ascii")))
        check_volume(root, volume_id)
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return volume_id
    finally:
        os.unlink(name)
