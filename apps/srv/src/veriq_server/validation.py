"""OpenAPI 组件校验：从源码 YAML 或打包 _openapi.json 解析文档，并绑定 platform-v1 schema 以复用 Id/Timestamp 格式。

运行时控制面不依赖 Node；可编辑安装读仓库 contracts，wheel 安装读包内固化 OpenAPI/schema。validate_api 按组件名解析
$ref，校验失败由 jsonschema 抛出，调用方映射为 400
级请求错误。
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
    """惰性加载 OpenAPI 文档：优先读取源码树 platform.yaml，否则使用 wheel 内 _openapi.json。
    api_document 实现于 apps/srv/src/veriq_server/validation.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """
    source = Path(__file__).resolve().parents[4] / "packages/contracts/openapi/platform.yaml"
    return cast(
        dict[str, Any],
        json.loads(
            source.read_text()
            if source.exists()
            else files("veriq_server").joinpath("_openapi.json").read_text()
        ),
    )


@lru_cache(maxsize=1)
def _schema_registry() -> Registry[Any]:
    """按进程加载源码或安装包中的权威契约，让所有组件复用同一个只读注册表解析跨文档的结构引用。"""
    doc = api_document()
    # 外部 Id/Timestamp 引用复用平台合同中的规范定义，使 API 正文校验与既有校验器及配置加载使用同一标识和时间规则。
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
    return Registry().with_resources(
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


@lru_cache(maxsize=None)
def _component_validator(name: str) -> Draft202012Validator:
    """组件名由服务端路由指定，同一进程复用相同组件的校验器，部署新契约后随进程重启重新构建。"""
    return Draft202012Validator(
        {"$ref": "https://veriq.local/openapi/platform.yaml#/components/schemas/" + name},
        registry=_schema_registry(),
        format_checker=FormatChecker(),
    )


def validate_api(name: str, value: Any) -> None:
    """逐次校验实际传入的请求或响应，失败仍抛出原有的校验异常，处理器据此生成对应的请求错误。"""
    _component_validator(name).validate(value)
