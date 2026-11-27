"""在向模型供应商发送内容或披露已有生成结果前，核对运营方批准的协议、主机、有效端口和完整路径。"""

from ipaddress import ip_address
import re
from typing import Any
from urllib.parse import unquote_to_bytes

import httpx

from ..service import Problem
from ..settings import Settings

# 单独校验原始协议和授权部分，避免解析器忽略空凭据、空端口、空查询或片段，导致畸形输入与已授权地址相同。
_ENDPOINT = re.compile(
    r"https?://(?:\[[0-9a-f:.]+\]|[^:@%/?#\\\[\]]+)(?::[0-9]+)?(?P<path>/[^?#\\]*)?",
    re.ASCII | re.IGNORECASE,
)
_DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_INVALID_ESCAPE = re.compile(r"%(?![a-fA-F0-9]{2})")
_ESCAPE = re.compile(rb"%[a-fA-F0-9]{2}")


def _valid_path(path: str) -> bool:
    """拒绝编码错误、控制字节、点路径段和隐藏的分隔符，普通百分号编码仍按客户端真正发出的路径匹配。"""
    if _INVALID_ESCAPE.search(path):
        return False
    for part in path.split("/"):
        decoded = unquote_to_bytes(part)
        if decoded in {b".", b".."} or b"/" in decoded or b"\\" in decoded:
            return False
        if any(byte < 32 or byte == 127 for byte in decoded):
            return False
    return True


def _allowed_host(url: httpx.URL, development: bool) -> str | None:
    """使用客户端已完成国际化转换的主机名校验域名或地址，仅对开发配置开放明确列入清单的回环明文端点。"""
    host = url.raw_host.decode("ascii")
    if ":" in host:
        host = ip_address(host).compressed
    elif len(host) > 254 or not all(
        _DNS_LABEL.fullmatch(label) for label in host.removesuffix(".").split(".")
    ):
        return None
    if url.scheme == "http" and not (
        development and (host == "localhost" or ip_address(host).is_loopback)
    ):
        return None
    return host


def _endpoint_key(value: object, development: bool) -> tuple[str, str, int, bytes] | None:
    """使用模型客户端相同的解析器规范化主机和有效端口，路径保留大小写，拒绝会改变目标的路径折叠。"""
    if not isinstance(value, str) or len(value) > 2048 or not (match := _ENDPOINT.fullmatch(value)):
        return None
    if not value.isprintable() or any(character.isspace() for character in value):
        return None
    try:
        if not _valid_path(match["path"] or "/"):
            return None
        url = httpx.URL(value)
        host = _allowed_host(url, development)
        port = url.port if url.port is not None else (443 if url.scheme == "https" else 80)
        if not host or not 1 <= port <= 65535:
            return None
    except (ValueError, httpx.InvalidURL):
        return None
    return url.scheme, host, port, _ESCAPE.sub(lambda item: item[0].upper(), url.raw_path)


def public_provider_config(config: dict[str, Any]) -> dict[str, Any]:
    """保留可供管理员修复的正常地址和冻结的模型费率，旧地址含凭据或无法安全解析时仅返回遮蔽标志。"""
    public = {key: value for key, value in config.items() if key != "apiKey"}
    if "baseURL" in config and _endpoint_key(config["baseURL"], development=True) is None:
        public["baseURL"] = "[REDACTED]"
    return public


def endpoint_allowed(settings: Settings, base_url: object) -> bool:
    """比较候选端点与当前部署授权的完整目标，开发环境的明文连接还必须使用明确列出的本机名或回环地址。"""
    development = settings.environment == "development"
    candidate = _endpoint_key(base_url, development)
    return candidate is not None and any(
        _endpoint_key(allowed, development) == candidate
        for allowed in settings.ai_allowed_base_urls
    )


def require_endpoint(settings: Settings, base_url: object) -> None:
    """将非法地址和未登记目标映射为同一拒绝结果，错误正文不会包含用户提交的地址、凭据或查询参数。"""
    if not endpoint_allowed(settings, base_url):
        raise Problem(422, "AI_ENDPOINT_FORBIDDEN", "Model provider endpoint is not authorized")
