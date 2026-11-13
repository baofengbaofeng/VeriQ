"""将唯一前端构建目录复制到唯一 Python 包暂存目录，先验证完整候选再替换旧资源；调用入口持有构建锁，独立调用也使用同一把锁，防止并发构建混合不同身份的文件。

复制只使用已经检查过的普通文件，不沿符号链接遍历。
任何候选校验失败都保留先前的暂存目录。
正式 output 的原子发布由 build_release 单独负责。
"""

import argparse
import fcntl
from hashlib import sha256
import json
import os
from typing import Any
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/srv"))
from release_support import files, safe_path, validate_static


def stage_web(root: Path, commit: str, build_id: str, target: Path | None = None) -> dict[str, Any]:
    """只允许 apps/web/dist 到固定包资源目录的暂存映射，完整候选通过检查后才移走旧目录，并在替换失败时恢复原目录；目标覆盖参数仅能重复指定同一个白名单路径。

    root 必须是绝对规范路径，路径别名不能扩大清理范围。
    两份 metadata 由本次构建重写，不接受 Vite 目录内旧身份。
    候选位于目标同一文件系统，目录 rename 不会退化为复制。
    前一次备份只在新目录可用后删除。
    这不是公开服务目录的热替换协议，构建期间不会运行生产服务。
    """
    root = root.absolute()
    safe_path(root)
    source = root / "apps/web/dist"
    expected = root / "apps/srv/src/veriq_server/static/dist"
    if target is not None and target.absolute() != expected:
        raise ValueError("Unsafe frontend staging target")
    safe_path(expected)
    inputs = files(source)
    if not {"index.html", ".vite/manifest.json"} <= inputs.keys():
        raise ValueError("Missing frontend index or Vite manifest")
    version = json.loads((root / "package.json").read_bytes())["version"]
    expected.parent.mkdir(parents=True, exist_ok=True)
    candidate = Path(tempfile.mkdtemp(prefix=".stage-", dir=expected.parent))
    backup = candidate.with_name(candidate.name + "-previous")
    try:
        records = []
        for name, path in inputs.items():
            if name in {"static-manifest.json", "build-info.json"}:
                continue
            content = path.read_bytes()
            destination = candidate / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            records.append(
                {
                    "path": name,
                    "sha256": sha256(content).hexdigest(),
                    "sizeBytes": len(content),
                }
            )
        raw = (
            json.dumps(
                {"schemaVersion": "1.0", "files": records},
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        (candidate / "static-manifest.json").write_bytes(raw)
        info = {
            "version": version,
            "commit": commit,
            "buildId": build_id,
            "staticManifestHash": sha256(raw).hexdigest(),
        }
        (candidate / "build-info.json").write_text(json.dumps(info, sort_keys=True) + "\n")
        validate_static(candidate, version)
        try:
            if expected.exists():
                expected.rename(backup)
            candidate.rename(expected)
        except BaseException:
            if backup.exists() and not expected.exists():
                backup.rename(expected)
            raise
        return info
    finally:
        for owned in (candidate, backup):
            if owned.exists():
                shutil.rmtree(owned)


def main() -> None:
    """独立暂存入口先解析明确身份再获取工作区构建锁，失败时返回英文诊断且不发布任何成功标志；流水线内部直接调用 stage_web，并由外层持有相同的锁覆盖整个构建阶段。

    flock 使用非阻塞模式，冲突时明确失败而非等待另一个构建。
    锁文件位于固定 work 目录，拒绝链接替换。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--target", type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--build-id", required=True)
    args = parser.parse_args()
    try:
        lock = args.root / "work/build.lock"
        safe_path(lock)
        lock.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(stage_web(args.root, args.commit, args.build_id, args.target)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Frontend staging failed: {error}\n")


if __name__ == "__main__":
    main()
