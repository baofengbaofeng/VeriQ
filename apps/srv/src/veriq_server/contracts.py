"""从打包 schema 或源码树加载 platform-v1 契约，校验可移植 JSON，并计算资源快照的规范哈希与序列化输出。

本模块运行时不依赖 Node 与检出树；wheel 内嵌 _schemas，可编辑安装回退到 packages/contracts。
拒绝 NaN/Infinity 与超出 JS 安全整数的数值，保证跨语言契约与 rfc8785 规范字节一致。
"""

from __future__ import annotations

import json
import math
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any, TypedDict

from jsonschema import Draft202012Validator, FormatChecker

MAX_SAFE_INTEGER = 9_007_199_254_740_991


class ValidationIssue(TypedDict):
    """单条契约校验问题：包含 JSON Pointer 路径、稳定错误码以及面向调用方的英文说明消息，ValidationIssue 的失败路径返回稳定错误。"""

    path: str
    code: str
    message: str


@cache
def _schema() -> dict[str, Any]:
    """加载完整 platform-v1.schema.json，优先包资源，其次源码 contracts 路径。"""
    resource = files("veriq_server").joinpath("_schemas/platform-v1.schema.json")
    if resource.is_file():
        return json.loads(resource.read_text(encoding="utf-8"))  # type: ignore[no-any-return]
    # Hatch 可编辑安装暴露 src；wheel 则内嵌规范目录。
    path = (
        Path(__file__).resolve().parents[4] / "packages/contracts/schemas/platform-v1.schema.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


@cache
def _validator(schema_name: str) -> Draft202012Validator:
    """按 $defs 名称构造带 FormatChecker 的 Draft 2020-12 校验器并缓存。"""
    definitions = _schema()["$defs"]
    if schema_name not in definitions:
        raise ValueError(f"Unknown contract schema: {schema_name}")
    return Draft202012Validator(
        {"$ref": f"#/$defs/{schema_name}", "$defs": definitions}, format_checker=FormatChecker()
    )


def _pointer(parts: Any) -> str:
    """将绝对路径元组编码为 RFC6901 JSON Pointer，供问题排序与展示。"""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _portable_json(value: Any, ancestors: set[int]) -> bool:
    """判断值是否为可跨语言移植的 JSON：有限数、安全整数、无环引用且键均为字符串。"""
    if value is None or type(value) in (str, bool):
        return True
    if type(value) is int:
        return abs(value) <= MAX_SAFE_INTEGER
    if type(value) is float:
        return math.isfinite(value) and (not value.is_integer() or abs(value) <= MAX_SAFE_INTEGER)
    if type(value) not in (dict, list) or id(value) in ancestors:
        return False
    ancestors.add(id(value))
    try:
        if isinstance(value, dict):
            return all(
                type(key) is str and _portable_json(item, ancestors) for key, item in value.items()
            )
        return all(_portable_json(item, ancestors) for item in value)
    finally:
        ancestors.remove(id(value))


def validate_schema(schema_name: str, value: Any) -> list[ValidationIssue]:
    """先做可移植性检查再运行 schema，返回按路径排序的问题列表，空列表表示校验通过，validate_schema 的失败路径返回稳定错误。"""
    validator = _validator(schema_name)
    if not _portable_json(value, set()):
        return [
            {"path": "", "code": "INVALID_JSON", "message": "Expected finite, portable JSON values"}
        ]
    return [
        {
            "path": _pointer(error.absolute_path),
            "code": "SCHEMA_VIOLATION",
            "message": error.message,
        }
        for error in sorted(
            validator.iter_errors(value), key=lambda error: _pointer(error.absolute_path)
        )
    ]


def validate_case_schema(value: Any) -> list[ValidationIssue]:
    """校验 CaseDslV1 文档结构，供草稿保存与发布前的契约门禁流程复用同一套规则，validate_case_schema 的失败路径返回稳定错误。"""
    return validate_schema("CaseDslV1", value)


def serialize_contract(schema_name: str, value: Any) -> str:
    """校验通过后以紧凑且 allow_nan=False 的 JSON 文本序列化契约对象，拒绝非有限数值，serialize_contract 的失败路径返回稳定错误。"""
    issues = validate_schema(schema_name, value)
    if issues:
        raise ValueError(issues)
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def parse_contract(schema_name: str, text: str) -> Any:
    """解析 JSON 文本并校验命名契约，同时拒绝 Infinity 与 NaN 等非标准 JSON 常量，parse_contract 的失败路径返回稳定错误。"""
    def reject_constant(constant: str) -> None:
        raise ValueError(f"Non-JSON constant: {constant}")

    value = json.loads(text, parse_constant=reject_constant)
    issues = validate_schema(schema_name, value)
    if issues:
        raise ValueError(issues)
    return value


def canonical_bytes(value: Any) -> bytes:
    """使用 rfc8785 生成规范字节作为内容寻址哈希输入；遇到不可移植值时直接拒绝，canonical_bytes 的失败路径返回稳定错误。"""
    import rfc8785

    if not _portable_json(value, set()):
        raise ValueError("Expected portable JSON")
    return rfc8785.dumps(value)


def asset_source_hash(snapshot: dict[str, Any]) -> str:
    """对执行快照关键字段做规范哈希；authAdapters 按 versionId 排序后再纳入摘要计算，asset_source_hash 的失败路径返回稳定错误。"""
    import hashlib

    return hashlib.sha256(
        canonical_bytes(
            {
                key: (
                    sorted(snapshot[key], key=lambda item: item["versionId"])
                    if key == "authAdapters"
                    else snapshot[key]
                )
                for key in (
                    "schemaVersion",
                    "workspaceId",
                    "engineVersion",
                    "entryCaseVersionIds",
                    "assets",
                    *(["authAdapters"] if "authAdapters" in snapshot else []),
                )
            }
        )
    ).hexdigest()
