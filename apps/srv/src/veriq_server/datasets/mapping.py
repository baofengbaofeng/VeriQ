"""按声明的 JSON 指针映射返回数组，字段缺失与空值彼此独立，树结构须在所有分页拼接完成后检查。"""

from dataclasses import dataclass
import time
from typing import Any
from jsonschema import Draft202012Validator

from ..contracts import canonical_bytes, validate_schema
from ..service import Problem

MISSING = object()


def invalid() -> Problem:
    """映射错误仅公开稳定分类，原始行键、响应片段或上游错误消息不会经异常正文返回给编辑器。"""
    return Problem(422, "DATASET_RESPONSE_INVALID", "Dataset response is invalid or incomplete")


@dataclass
class MappingBudget:
    """跨页记录投影后的规范字节与剩余行数，同时检查 CPU 映射用时，以防响应别名放大或同步计算超时。"""

    remaining: int = 2 * 1024 * 1024 - 2
    rows: int = 10000
    deadline: float = float("inf")

    def charge(self, size: int) -> None:
        """每次写入行或字段之前扣划实际规范字节，超限发生在构造完整超大结果之前，调用者须放弃本次读取。"""
        self.remaining -= size
        if self.remaining < 0 or self.rows < 0:
            raise Problem(422, "DATASET_RESPONSE_LIMIT", "Dataset response exceeds the budget")
        if time.monotonic() >= self.deadline:
            raise TimeoutError


def pointer(document: Any, path: str) -> Any:
    """逐段解码 JSON 指针并按实际容器选择字典键或规范数组索引，显式空值仍是成功获取的值。"""
    value = document
    for token in path.split("/")[1:]:
        key = token.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict) and key in value:
            value = value[key]
        elif (
            isinstance(value, list)
            and key.isascii()
            and key.isdecimal()
            and len(key) <= 9
            and (key == "0" or not key.startswith("0"))
            and int(key) < len(value)
        ):
            value = value[int(key)]
        else:
            return MISSING
    return value


def map_response(
    dataset: dict[str, Any], document: object, *, budget: MappingBudget | None = None
) -> list[dict[str, Any]]:
    """映射当前单页并校验必填、空值、字段类型与行契约，忽略未选取的响应字段而不留存原始文档。"""
    budget = budget or MappingBudget()
    mapping = dataset["source"]["mapping"]
    items = pointer(document, mapping["rows"])
    if not isinstance(items, list):
        raise invalid()
    # 行数和映射字节均跨页累计，一个很短的响应也可能把同一大型对象投影到多个字段，因此网络限额不能代替结果限额。
    budget.rows -= len(items)
    budget.charge(0)
    rows = []
    for item in items:
        row = {"key": pointer(item, mapping["key"]), "values": {}}
        if dataset["shape"] == "TREE":
            row.update((key, pointer(item, mapping[key])) for key in ("order", "parentKey"))
        if validate_schema("TreeDataRowV2" if dataset["shape"] == "TREE" else "DataRowV1", row):
            raise invalid()
        budget.charge(len(canonical_bytes(row)) + 1)
        for name, path in mapping["values"].items():
            value = pointer(item, path)
            field = dataset["fields"][name]
            if value is MISSING:
                if field["required"]:
                    raise invalid()
            elif (value is None and not field["nullable"]) or (
                value is not None
                and not Draft202012Validator.TYPE_CHECKER.is_type(value, field["type"])
            ):
                raise invalid()
            else:
                budget.charge(len(canonical_bytes(value)) + len(canonical_bytes(name)) + 2)
                row["values"][name] = value
        rows.append(row)
    return rows


def complete_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """汇总后验证全局行键唯一及父节点关系，允许子节点在前页出现而父节点在下一页出现的树形数据。"""
    # 先拼接所有页再建立全局键索引，允许树父节点出现在下一页，同时能够拒绝跨页重复、孤儿或环。
    by_key = {row["key"]: row for row in rows}
    if len(by_key) != len(rows):
        raise invalid()
    depths: dict[str, int] = {}
    for row in rows:
        key = row["key"]
        chain: dict[str, None] = {}
        while key is not None and key not in depths:
            if key in chain or key not in by_key or len(chain) >= 100:
                raise invalid()
            chain[key] = None
            key = by_key[key].get("parentKey")
        depth = depths.get(key, 0)
        for key in reversed(chain):
            depth += 1
            if depth > 100:
                raise invalid()
            depths[key] = depth
    return rows
