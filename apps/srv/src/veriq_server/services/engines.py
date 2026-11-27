"""操作员批准引擎清单读取器校验 ApprovedEngineInventoryV1，要求 engineVersion 唯一完整发行。必备
package/lock/dependencies/compiler.tgz；

生成源码路径不得标为批准发行。
"""

import json
from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path
from typing import Any

from ..contracts import canonical_bytes, validate_schema
from ..service import Problem
from ..settings import Settings

_CONNECTED_COMPONENTS = (
    ("compilerConnectedDatasets", "2.0"),
    ("runnerSdkConnectedDatasets", "2.0"),
)
_HTTP_COMPONENTS = (("compilerHttpDatasets", "1.0"), ("runnerSdkHttpDatasets", "1.0"))


class ApprovedEngines:
    """加载批准清单，require 返回引擎描述与规范哈希，ApprovedEngines 路径必须遵守 Workspace 作用域。
    ApprovedEngines 实现于 apps/srv/src/veriq_server/services/engines.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """

    def __init__(self, settings: Settings, raw: bytes | None = None):
        """记录路径或预载 raw，便于测试注入而不读盘，ApprovedEngines.__init__ 路径必须遵守 Workspace 作用域。
        __init__ 实现于 apps/srv/src/veriq_server/services/engines.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.path = settings.approved_engine_inventory_path
        self.raw = raw

    def require(self, version: str) -> tuple[dict[str, Any], str]:
        """匹配唯一引擎版本并检查文件白名单，错误归一 ENGINE_NOT_APPROVED，ApprovedEngines.require 路径必须遵守
        Workspace 作用域。
        require 实现于 apps/srv/src/veriq_server/services/engines.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
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

    def require_validation(
        self,
        version: str,
        required_capabilities: Mapping[str, object],
        *,
        inventory_hash: str | None = None,
    ) -> dict[str, Any]:
        """校验受管编译的批准发行是否覆盖冻结任务的联网要求，完成时先核对所提交的库存散列再判定组件能力。

        静态数据要求编译器和 SDK 同时支持联网格式，HTTP 在此基础上还要求两个组件的实时读取协议。
        无数据任务仍可使用缺少这些可选声明的旧发行。
        """
        engine, approved_hash = self.require(version)
        if inventory_hash is not None and inventory_hash != approved_hash:
            raise Problem(409, "ENGINE_INVENTORY_MISMATCH", "Compiler release inventory differs")
        if not supports_validation(engine, required_capabilities):
            raise Problem(
                409, "ENGINE_NOT_APPROVED", "Approved engine lacks required dataset capabilities"
            )
        return engine


def supports_validation(
    engine: Mapping[str, object], required_capabilities: Mapping[str, object]
) -> bool:
    """按任务冻结的数据协议检查批准库存中的编译器和 SDK 声明，两个组件都具备所需能力才能接单。"""
    components: tuple[tuple[str, str], ...] = ()
    if required_capabilities.get("httpDatasets"):
        components = _CONNECTED_COMPONENTS + _HTTP_COMPONENTS
    elif required_capabilities.get("connectedDatasets"):
        components = _CONNECTED_COMPONENTS
    return all(engine.get(field) == protocol for field, protocol in components)
