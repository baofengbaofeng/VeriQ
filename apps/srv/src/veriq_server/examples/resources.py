"""已安装示例资源仅通过 importlib.resources 读取固定包内 JSON 文件，API 和标准库导入器共享相同字节与依赖顺序，
不从当前工作目录或请求提供的路径寻找替代资源。

文件散列描述随包携带的实际源码，不代表编译通过或独立信任批准。清单不能指定新路径；七个资产名称和依赖顺序由本模块明确约束
。读取失败即停止提供样例，不生成默认资产或伪造验证回执。
"""

from hashlib import sha256
from importlib.resources import files
import json
from typing import Any
from uuid import UUID

ASSET_ORDER = ("catalog", "dataset", "fixture", "flow", "case", "suite", "environment")
KINDS = ("ELEMENT_CATALOG", "DATASET", "FIXTURE", "FLOW", "CASE", "SUITE", "ENVIRONMENT")
DATA_PATHS = ("manifest.json", *(f"assets/{key}.json" for key in ASSET_ORDER))


def sample_package() -> dict[str, Any]:
    """返回标准 JSON 数据对象和实际文件散列，调用方可安全序列化给已认证员工；内容不包含机器配置、文件系统路径或凭据，
    固定 UUID 仅作为导入时必须重写的模板别名。

    importlib Traversable 同时适用于安装目录与支持的包资源读取方式。每个文件有读取上限，非法 JSON、
    清单偏离或种类不匹配直接失败。返回的是新解析对象，调用方的 URL/角色替换不会修改包内模板。
    sourceInventory 不赋予发布权限，真正编译仍由现有协议执行。
    """
    root = files("veriq_server.examples").joinpath("data")
    documents: dict[str, Any] = {}
    inventory: dict[str, str] = {}
    for name in DATA_PATHS:
        with root.joinpath(*name.split("/")).open("rb") as source:
            raw = source.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Sample resource exceeded the package limit")
        documents[name] = json.loads(raw)
        inventory[name] = sha256(raw).hexdigest()
    manifest = documents["manifest.json"]
    if manifest.get("schemaVersion") != "1.0" or manifest.get("order") != list(ASSET_ORDER):
        raise ValueError("Invalid bundled sample manifest")
    aliases = manifest.get("versionAliases", {})
    if set(aliases) != {*ASSET_ORDER, "adapter", "business", "fixture-secret"}:
        raise ValueError("Invalid bundled sample aliases")
    for value in aliases.values():
        UUID(value)
    if len(set(aliases.values())) != len(aliases):
        raise ValueError("Duplicate bundled sample alias")
    assets = {key: documents[f"assets/{key}.json"] for key in ASSET_ORDER}
    for key, kind in zip(ASSET_ORDER, KINDS, strict=True):
        if (
            assets[key].get("kind") != kind
            or assets[key].get("document", {}).get("schemaVersion") != "1.0"
        ):
            raise ValueError("Invalid bundled sample resource kind")
    return {
        "schemaVersion": "1.0",
        "manifest": manifest,
        "assets": assets,
        "sourceInventory": inventory,
    }
