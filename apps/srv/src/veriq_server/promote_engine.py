"""操作员显式晋升入口验证候选全部文件并以既有 issuer→inventory 权威锁协议追加批准版本；构建 CI 不调用此模块，同版本不同身份永远拒绝，避免重新解释旧签名包与发布回执。

私钥仅由操作员配置的既有权威加载器读取，不进入候选目录。
候选构建与批准晋升是两个独立动作。
候选在权威锁前预检、取得锁后重新验证，不占用任何数据库事务。
"""

import argparse
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any

from .bundles.authority import authority_guard
from .contracts import canonical_bytes, validate_schema
from .services.engines import ApprovedEngines
from .settings import Settings, load_settings


def _validate_candidate(settings: Settings, candidate: Path) -> tuple[bytes, dict[str, Any], str]:
    """读取候选的有界库存并逐文件验证路径、长度和摘要，返回本次实际读取的原始库存及规范身份；前后两次使用同一校验器，防止等待权威锁时变化的文件被旧内存条目掩盖。

    返回的字节快照只用于比较输入身份，不代表批准或修改候选目录。
    同步文件校验没有后台 worker，因此任务取消后不会迟到执行库存替换。
    """
    if not settings.approved_engine_inventory_path:
        raise ValueError("Approved inventory path is required")
    if any(path.is_symlink() for path in (candidate, *candidate.parents)):
        raise ValueError("Unsafe engine candidate path")
    inventory = candidate / "inventory.json"
    if inventory.is_symlink():
        raise ValueError("Unsafe candidate inventory")
    with inventory.open("rb") as stream:
        raw = stream.read(2 * 1024 * 1024 + 1)
    document = json.loads(raw)
    if (
        len(raw) > 2 * 1024 * 1024
        or validate_schema("ApprovedEngineInventoryV1", document)
        or len(document["engines"]) != 1
    ):
        raise ValueError("A single valid candidate engine is required")
    version = document["engines"][0]["engineVersion"]
    entry, identity = ApprovedEngines(settings, raw).require(version)
    total = 0
    for member in entry["files"]:
        total += member["sizeBytes"]
        if total > 128 * 1024 * 1024:
            raise ValueError("Candidate engine exceeds runtime size limit")
        if not re.fullmatch(
            r"(?:package\.json|package-lock\.json|dependencies\.json|engine/compiler\.tgz|vendor/[A-Za-z0-9_.-]+\.tgz)",
            member["path"],
        ):
            raise ValueError("Unsafe engine member path")
        path = candidate / member["path"]
        if any(part.is_symlink() for part in (path, *path.parents)) or not path.is_file():
            raise ValueError("Unsafe engine member")
        if path.stat().st_size != member["sizeBytes"]:
            raise ValueError("Engine candidate size mismatch")
        content = path.read_bytes()
        if len(content) != member["sizeBytes"] or sha256(content).hexdigest() != member["sha256"]:
            raise ValueError("Engine candidate content mismatch")
    return raw, entry, identity


async def promote_engine(settings: Settings, candidate: Path) -> str:
    """校验单个候选发行的路径、字节和严格库存，持有既有双重权威锁后重新读取当前批准清单并追加新身份；已存在版本只能与原条目完全一致，否则拒绝不可变身份冲突。

    候选目录必须没有任何符号链接组件。
    当前清单即使位于只读发行目录旁，锁仍放在可写 issuer 状态目录。
    fsync 文件与父目录确保原子替换后的持久性。
    保留旧条目让此前冻结的包与回执继续按原版本验证。
    同字节重复晋升幂等，不重复写清单。
    """
    approved_path = settings.approved_engine_inventory_path
    if not approved_path:
        raise ValueError("Approved inventory path is required")
    selected_raw, entry, identity = _validate_candidate(settings, candidate)
    version = entry["engineVersion"]
    async with authority_guard(settings, False) as (_, approved):
        current_raw, _, _ = _validate_candidate(settings, candidate)
        if current_raw != selected_raw:
            raise ValueError("Engine candidate changed while waiting for authority")
        current = json.loads(approved.raw or b"null")
        if validate_schema("ApprovedEngineInventoryV1", current):
            raise ValueError("Current approved inventory is invalid")
        versions = [engine["engineVersion"] for engine in current["engines"]]
        if len(versions) != len(set(versions)):
            raise ValueError("Current approved inventory has duplicate versions")
        for existing in current["engines"]:
            if existing["engineVersion"] == version:
                if canonical_bytes(existing) != canonical_bytes(entry):
                    raise ValueError("Engine version identity is immutable")
                return identity
        current["engines"].append(entry)
        if validate_schema("ApprovedEngineInventoryV1", current):
            raise ValueError("Approved inventory limit exceeded")
        target = Path(approved_path)
        if any(path.is_symlink() for path in (target, *target.parents)):
            raise ValueError("Unsafe approved inventory path")
        descriptor, name = tempfile.mkstemp(prefix=".inventory-", dir=target.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(canonical_bytes(current))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            directory = os.open(target.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
    return identity


def main() -> None:
    """操作员必须显式提供外置配置与候选目录，成功只输出已批准条目的公开摘要；任何配置、文件或权威错误均使用固定英文诊断，避免将数据库地址或签发者私钥打印到终端。

    命令不生成签发者，不替换配置选择，也不自动重新发布资源。
    配置切换应在新发行已安装到所有目标 Runtime 后另行进行。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(asyncio.run(promote_engine(load_settings(args.config), args.candidate)))
    except Exception:
        parser.exit(
            1,
            "Engine promotion failed. Check candidate integrity, immutable identity and operator configuration.\n",
        )


if __name__ == "__main__":
    main()
