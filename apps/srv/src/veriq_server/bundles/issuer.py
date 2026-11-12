import base64
import copy
import fcntl
from contextlib import contextmanager
from collections.abc import Iterator
import json
import os
import re
import stat
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import uuid4
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from ..service import Problem
from ..contracts import validate_schema


class Issuer:
    """离线 Bundle 签发权威：从受权限目录装载 Ed25519 密钥材料，对外只暴露公钥信任集；私钥仅存于受控文件，public() 永不返回 privateKey。"""

    def __init__(self, path: str | Path | None):
        """校验目录与文件权限后装载 IssuerTrustV1；任何权限或指纹异常都映射 ISSUER_UNAVAILABLE；目录与文件禁止 group/other 可写，防止权限宽松加载。"""
        try:
            if not path:
                raise ValueError()
            self.path = Path(path)
            parent = self.path.parent.lstat()
            if not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o077:
                raise ValueError()
            with os.fdopen(os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_mode & 0o077:
                    raise ValueError()
                self.data = json.loads(stream.read(65537))
            if validate_schema("IssuerTrustV1", self.public()):
                raise ValueError()
            if len({key["keyId"] for key in self.data["keys"]}) != len(self.data["keys"]):
                raise ValueError()
            for key in self.data["keys"]:
                raw = base64.b64decode(key["publicKey"], validate=True)
                if len(raw) != 32 or sha256(raw).hexdigest() != key["fingerprint"]:
                    raise ValueError()
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,159}", self.data["issuerId"]):
                raise ValueError()
            self.private = Ed25519PrivateKey.from_private_bytes(
                base64.b64decode(self.data["privateKey"], validate=True)
            )
            public = self.private.public_key().public_bytes_raw()
            active = next(k for k in self.data["keys"] if k["keyId"] == self.data["activeKeyId"])
            if active["publicKey"] != base64.b64encode(public).decode() or active["revoked"]:
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError, StopIteration):
            raise Problem(
                503, "ISSUER_UNAVAILABLE", "Operator bundle issuer is unavailable"
            ) from None

    @staticmethod
    def key() -> tuple[Ed25519PrivateKey, dict[str, Any]]:
        """生成一对新的 Ed25519 密钥与可嵌入信任集的公钥元数据（含指纹与未撤销标记）；keyId 使用 uuid4 hex，指纹为公钥 SHA-256。"""
        key = Ed25519PrivateKey.generate()
        raw = key.public_key().public_bytes_raw()
        return key, {
            "keyId": "key_" + uuid4().hex,
            "algorithm": "Ed25519",
            "publicKey": base64.b64encode(raw).decode(),
            "fingerprint": sha256(raw).hexdigest(),
            "revoked": False,
        }

    @staticmethod
    def write(path: Path, data: dict[str, Any], initial: bool = False) -> None:
        """以 0700 目录与临时文件原子替换写入签发材料；initial 用 link 创建避免覆盖既有文件；fsync 文件与目录，降低崩溃窗口导致的半写状态。"""
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = path.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("Unsafe issuer directory")
        temporary = path.with_name(path.name + "." + uuid4().hex)
        try:
            with os.fdopen(
                os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
            ) as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            if initial:
                os.link(temporary, path)
            else:
                os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    @classmethod
    def initialize(cls, path: Path) -> "Issuer":
        """首次引导写入 revision=1 的签发者材料并返回已校验的 Issuer 实例；initial=True 用 link 创建，已存在则失败而非覆盖。"""
        key, public = cls.key()
        cls.write(
            path,
            {
                "issuerId": "issuer_" + uuid4().hex,
                "revision": 1,
                "activeKeyId": public["keyId"],
                "privateKey": base64.b64encode(key.private_bytes_raw()).decode(),
                "keys": [public],
            },
            initial=True,
        )
        return cls(path)

    @contextmanager
    def mutation(self) -> Iterator[None]:
        """跨进程排他持锁后重载最新快照执行算子变更，退出时原子写回；读路径使用旧/新快照；持锁期间重载磁盘快照，避免基于陈旧内存状态轮换。"""
        # 算子变更跨进程串行；对外服务依赖原子旧/新快照切换，不在此持读锁。
        fd = os.open(self.path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            fresh = Issuer(self.path)
            self.data, self.private = fresh.data, fresh.private
            yield
            self.write(self.path, self.data)
        finally:
            os.close(fd)

    def rotate(self) -> None:
        """在历史上限内轮换活跃私钥：追加新公钥条目并提升 revision，旧密钥仍可验签直至撤销；密钥历史达到 100 条时拒绝继续轮换，需运维清理策略。"""
        with self.mutation():
            if len(self.data["keys"]) >= 100:
                raise ValueError("Issuer key history limit reached")
            key, public = self.key()
            self.data.update(
                activeKeyId=public["keyId"],
                privateKey=base64.b64encode(key.private_bytes_raw()).decode(),
                revision=self.data["revision"] + 1,
            )
            self.data["keys"].append(public)
            self.private = key

    def revoke(self, key_id: str) -> None:
        """撤销非活跃历史密钥；必须先 rotate 才能处理当前 activeKeyId，防止信任真空；禁止直接撤销活跃密钥，强制先 rotate 再 revoke。"""
        with self.mutation():
            if key_id == self.data["activeKeyId"]:
                raise ValueError("Rotate before revoking the active key")
            key = next((k for k in self.data["keys"] if k["keyId"] == key_id), None)
            if key is None:
                raise ValueError("Unknown issuer key")
            key["revoked"] = True
            self.data["revision"] += 1

    def public(self) -> dict[str, Any]:
        """导出可分发的公钥信任集副本，刻意剥离 privateKey 字段供设备与离线验签使用；深拷贝 keys，避免调用方修改内存中的信任集。"""
        return {
            "issuerId": self.data["issuerId"],
            "revision": self.data["revision"],
            "keys": copy.deepcopy(self.data["keys"]),
        }

    def sign(self, manifest: bytes) -> bytes:
        """用当前活跃私钥对 Bundle 清单字节做 Ed25519 签名，供导出管线附加权威证明；签名字节供 Bundle 清单附加，验签方使用 public 信任集。"""
        return self.private.sign(manifest)
