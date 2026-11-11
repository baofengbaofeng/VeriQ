"""Operator-owned persistent Ed25519 identity; never reuse the session signing key."""

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
    def __init__(self, path: str | Path | None):
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
        # Operator mutations serialize across processes; serving uses atomic old/new snapshots.
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
        with self.mutation():
            if key_id == self.data["activeKeyId"]:
                raise ValueError("Rotate before revoking the active key")
            key = next((k for k in self.data["keys"] if k["keyId"] == key_id), None)
            if key is None:
                raise ValueError("Unknown issuer key")
            key["revoked"] = True
            self.data["revision"] += 1

    def public(self) -> dict[str, Any]:
        return {
            "issuerId": self.data["issuerId"],
            "revision": self.data["revision"],
            "keys": copy.deepcopy(self.data["keys"]),
        }

    def sign(self, manifest: bytes) -> bytes:
        return self.private.sign(manifest)
