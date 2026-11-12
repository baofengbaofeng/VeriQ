"""操作员批准引擎清单读取器校验 ApprovedEngineInventoryV1，要求 engineVersion 唯一完整发行。
必备 package/lock/dependencies/compiler.tgz；生成源码路径不得标为批准发行。
"""


import json
from hashlib import sha256
from pathlib import Path
from typing import Any
from ..contracts import canonical_bytes, validate_schema
from ..service import Problem
from ..settings import Settings


class ApprovedEngines:
    """加载批准清单，require 返回引擎描述与规范哈希，ApprovedEngines 路径必须遵守 Workspace 作用域。"""
    def __init__(self, settings: Settings, raw: bytes | None = None):
        """记录路径或预载 raw，便于测试注入而不读盘，ApprovedEngines.__init__ 路径必须遵守 Workspace 作用域。"""
        self.path = settings.approved_engine_inventory_path
        self.raw = raw

    def require(self, version: str) -> tuple[dict[str, Any], str]:
        """匹配唯一引擎版本并检查文件白名单，错误归一 ENGINE_NOT_APPROVED，ApprovedEngines.require 路径必须遵守 Workspace 作用域。"""
        try:
            if not self.path:
                raise ValueError("Absent inventory")
            raw = self.raw if self.raw is not None else Path(self.path).read_bytes()
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError("Oversize inventory")
            document = json.loads(raw)
            if validate_schema("ApprovedEngineInventoryV1", document):
                raise ValueError("Invalid inventory")
            matches = [e for e in document["engines"] if e["engineVersion"] == version]
            if len(matches) != 1:
                raise ValueError("Engine not approved")
            engine = matches[0]
            paths = [f["path"] for f in engine["files"]]
            if len(paths) != len(set(paths)) or not {
                "package.json",
                "package-lock.json",
                "dependencies.json",
                "engine/compiler.tgz",
            } <= set(paths):
                raise ValueError("Incomplete release inventory")
            if any(
                not (
                    p
                    in {
                        "package.json",
                        "package-lock.json",
                        "dependencies.json",
                        "engine/compiler.tgz",
                    }
                    or p.startswith("vendor/")
                )
                for p in paths
            ):
                raise ValueError("Generated source cannot be release-approved")
            return engine, sha256(canonical_bytes(engine)).hexdigest()
        except (OSError, ValueError, KeyError, TypeError):
            raise Problem(
                409, "ENGINE_NOT_APPROVED", "Operator-approved engine inventory is unavailable"
            ) from None
