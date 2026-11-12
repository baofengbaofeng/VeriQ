"""OpenAPI 组件校验：从源码 YAML 或打包 _openapi.json 解析文档，并绑定 platform-v1 schema 以复用 Id/Timestamp 格式。

运行时控制面不依赖 Node；可编辑安装读仓库 contracts，wheel 安装读包内固化 OpenAPI/schema。
validate_api 按组件名解析 $ref，校验失败由 jsonschema 抛出，调用方映射为 400 级请求错误。
"""

import json
from functools import lru_cache
from pathlib import Path
from importlib.resources import files
from typing import Any, cast
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


@lru_cache
def api_document() -> dict[str, Any]:
    """惰性加载 OpenAPI 文档：优先读取源码树 platform.yaml，否则使用 wheel 内 _openapi.json。"""
    source = Path(__file__).resolve().parents[4] / "packages/contracts/openapi/platform.yaml"
    return cast(
        dict[str, Any],
        json.loads(
            source.read_text()
            if source.exists()
            else files("veriq_server").joinpath("_openapi.json").read_text()
        ),
    )


def validate_api(name: str, value: Any) -> None:
    """按 OpenAPI components/schemas 中的名称校验请求或响应体，并注册外部 Id/Timestamp 引用。"""
    doc = api_document()
    # 外部 Id/Timestamp 引用保持与 T01 校验器及配置文件一致。
    schema_path = (
        Path(__file__).resolve().parents[4] / "packages/contracts/schemas/platform-v1.schema.json"
    )
    if schema_path.exists():
        canonical = json.loads(schema_path.read_text())
    else:
        canonical = json.loads(
            files("veriq_server").joinpath("_schemas/platform-v1.schema.json").read_text()
        )
    uri = "https://veriq.local/openapi/platform.yaml"
    registry: Registry[Any] = Registry().with_resources(
        [
            (
                uri,
                Resource.from_contents(
                    {"$schema": "https://json-schema.org/draft/2020-12/schema", **doc}
                ),
            ),
            (
                "https://veriq.local/schemas/platform-v1.schema.json",
                Resource.from_contents(canonical),
            ),
        ]
    )
    Draft202012Validator(
        {"$ref": uri + "#/components/schemas/" + name},
        registry=registry,
        format_checker=FormatChecker(),
    ).validate(value)
