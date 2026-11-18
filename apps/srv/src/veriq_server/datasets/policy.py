"""将可编辑的 HTTP 数据集与部署方登记的固定路由配对，凭证和传输只接收完成授权后的配置。"""

from dataclasses import dataclass
import re
from typing import Any
from .connection import DatasetConnection
from ..contracts import validate_schema
from ..service import Problem


def unavailable() -> Problem:
    """统一隐藏未登记目标、无权使用目标和凭证已撤销之间的区别，错误正文不会包含内部地址或凭证引用。"""
    return Problem(
        422, "DATASET_CONNECTION_UNAVAILABLE", "Dataset connection or binding is unavailable"
    )


@dataclass(frozen=True)
class BoundDataset:
    """授权结果携带已检查的数据定义和部署连接，调用者无需从请求字段重新推断地址、身份或密钥。"""

    document: dict[str, Any]
    connection: DatasetConnection


def scoped_connection(
    registry: dict[str, DatasetConnection],
    workspace_id: str,
    user_id: str,
    environment_version_id: str,
    ref: str,
) -> DatasetConnection:
    """先按不可变连接版本定位，再核对工作区、用户与环境；普通草稿和读取路径都不会披露其它部署信息。"""
    target = registry.get(ref)
    if (
        target is None
        or target.workspace_id != workspace_id
        or target.environment_version_id != environment_version_id
        or user_id not in target.user_ids
    ):
        raise unavailable()
    return target


def bind_connection(
    registry, workspace_id, user_id, environment_version_id, document
) -> BoundDataset:
    """独立核对调用环境及用户授权，然后核实方法、路径、映射和认证；任何失败均发生在密钥解析前。"""
    if validate_schema("DatasetV2", document) or document["source"]["kind"] != "HTTP":
        raise unavailable()
    source = document["source"]
    # 声明中的 UUID 只是索引，当前用户和运行环境都来自调用方的独立授权上下文，不能以一个工作区内的其它连接替代。
    target = scoped_connection(
        registry, workspace_id, user_id, environment_version_id, source["connectionRef"]
    )
    if (
        source["environmentVersionId"] != environment_version_id
        or source["method"] not in target.routes.get(source["path"], ())
        or (source["method"] == "GET" and source["body"] is not None)
    ):
        raise unavailable()
    # 比较时头名不区分大小写；重复的大小写拼写可能使签名和服务端解释不同，故在生成实际字节前拒绝。
    headers = {h.lower() for h in source["headers"]}
    if (
        len(headers) != len(source["headers"])
        or not headers <= {h.lower() for h in target.request_headers}
        or target.signature_header.lower() in headers
        or any(any(not 32 <= ord(c) <= 126 for c in v) for v in source["headers"].values())
    ):
        raise unavailable()
    auth = source["auth"]
    if auth.get("algorithm", auth["kind"]) not in target.auth_kinds:
        raise unavailable()
    if auth["kind"] != "NONE":
        # 连接批准的操作与该单一版本批准的用途必须同时满足；同主机其它凭证的授权不能扩大本次密钥用途。
        grant = target.credentials.get(auth["secretRef"])
        if (
            not grant
            or grant.version_id != auth["secretVersionId"]
            or auth.get("algorithm", auth["kind"]) not in grant.purposes
        ):
            raise unavailable()
    if (
        auth["kind"] in {"API_KEY", "SIGNED"}
        and target.signature_header.lower() != auth["header"].lower()
    ):
        raise unavailable()
    if auth["kind"] == "SIGNED":
        # 用显式栈先限制节点总数和嵌套深度，之后才在固定上下文求值，表达式没有通用函数调用或密钥读取节点。
        pending = [(auth["input"], 1)]
        count = 0
        while pending:
            node, depth = pending.pop()
            count += 1
            if (
                count > 64
                or depth > 8
                or (node["op"] == "PARAMETER" and node["name"] not in source["parameters"])
            ):
                raise unavailable()
            pending.extend((child, depth + 1) for child in node.get("parts", []))
            if "input" in node:
                pending.append((node["input"], depth + 1))
    # 所有声明字段都有唯一映射；行上的字段仍可以不存在，因为是否必填由字段声明决定，而不是由映射路径决定。
    mapping = source["mapping"]
    if set(mapping["values"]) != set(document["fields"]) or (
        {"order", "parentKey"} & mapping.keys()
    ) != ({"order", "parentKey"} if document["shape"] == "TREE" else set()):
        raise unavailable()
    for template in source["headers"].values():
        for token in re.findall(r"\{\{(.*?)\}\}", template):
            if token != "request.timestamp" and (
                not token.startswith("arg.") or token[4:] not in source["parameters"]
            ):
                raise unavailable()
    body = source["body"] or {}
    if "parameter" in body and body["parameter"] not in source["parameters"]:
        raise unavailable()
    if (
        "raw" in body
        and isinstance(body["raw"], dict)
        and source["parameters"].get(body["raw"]["parameter"]) != "string"
    ):
        raise unavailable()
    for pair in body.get("form", []):
        if (
            isinstance(pair["value"], dict)
            and pair["value"]["parameter"] not in source["parameters"]
        ):
            raise unavailable()
    for pair in source["query"]:
        if (
            isinstance(pair["value"], dict)
            and pair["value"]["parameter"] not in source["parameters"]
            or pair["name"] == source.get("pagination", {}).get("parameter")
        ):
            raise unavailable()
    return BoundDataset(document, target)
