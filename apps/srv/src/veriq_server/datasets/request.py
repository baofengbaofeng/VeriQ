"""服务端从批准连接构造唯一请求目标与签名字节，跨页共享总时限、网络预算和并发槽，失败不返回部分行。"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from contextvars import ContextVar
import logging
import ssl
from datetime import UTC, datetime
import errno
import re
import json
import hmac
import time
from urllib.parse import urlsplit, urlencode
from jsonschema import Draft202012Validator

import httpx

from ..contracts import canonical_bytes, validate_schema
from ..service import Problem
from .mapping import MappingBudget, complete_rows, invalid, map_response, pointer
from .policy import BoundDataset, SecretResolver, unavailable
from .signing import auth_header, query_bytes

MAX_BYTES = 2 * 1024 * 1024
SLOTS = asyncio.Semaphore(4)
_WIRE_ACTIVE = ContextVar("dataset_wire_active", default=False)


def _hide_wire_record(_record: logging.LogRecord) -> bool:
    return not _WIRE_ACTIVE.get()


# HTTP 栈的调试事件包括上游响应头；只屏蔽当前数据集读取上下文，其它异步任务保留原有日志等级。
for _name in ("httpcore.http11", "httpcore.connection"):
    logging.getLogger(_name).addFilter(_hide_wire_record)


def _limit() -> Problem:
    return Problem(422, "DATASET_RESPONSE_LIMIT", "Dataset response exceeds the budget")


def _incomplete() -> Problem:
    return Problem(422, "DATASET_PAGINATION_INCOMPLETE", "Dataset pagination did not complete")


def build_request(
    config: BoundDataset,
    args: dict[str, Any],
    now_utc: datetime,
    key_resolver: SecretResolver,
    *,
    page_number: int = 1,
    cursor: str | None = None,
) -> httpx.Request:
    """请求 URL 使用批准的数字地址，TLS 名称与 Host 来自同一个部署源；签名复用最终发送的查询及正文。"""
    source, target = config.document["source"], config.connection
    types = source["parameters"]
    if (
        set(args) != set(types)
        or validate_schema("JsonObject", args)
        or len(canonical_bytes(args)) > 65536
    ):
        raise unavailable()
    if any(not Draft202012Validator.TYPE_CHECKER.is_type(v, types[k]) for k, v in args.items()):
        raise unavailable()
    # 查询与表达式使用同一份类型化实参投影：字符串保留原文，其它 JSON 类型先规范化，再执行所选的传输编码。
    strings: dict[str, str] = {
        k: v if type(v) is str else canonical_bytes(v).decode() for k, v in args.items()
    }

    def value(node: str | dict[str, str]) -> str:
        return strings[node["parameter"]] if isinstance(node, dict) else node

    def ordered(entries: list[dict[str, Any]]) -> list[tuple[str, str]]:
        return [(pair["name"], value(pair["value"])) for pair in entries]

    # 分页参数也是本次请求的一部分，必须在签名之前加入有序序列，使每页摘要覆盖真正发送的分页位置。
    pairs = ordered(source["query"])
    paging = source.get("pagination")
    if paging:
        token = str(page_number) if paging["kind"] == "PAGE" else cursor
        if token is not None:
            pairs.append((paging["parameter"], token))
    query = query_bytes(pairs)
    body = source["body"] or {}
    media = "application/json"
    if "raw" in body:
        content = value(body["raw"]).encode()
        media = "text/plain; charset=utf-8"
    elif "form" in body:
        content = urlencode(ordered(body["form"])).encode("ascii")
        media = "application/x-www-form-urlencoded"
    elif body:
        content = canonical_bytes(args[body["parameter"]] if "parameter" in body else body["json"])
    else:
        content = b""
    path = source["path"].encode("ascii")
    if len(query) > 8192 or len(content) > 65536:
        raise unavailable()
    origin = urlsplit(target.origin)
    # 连接地址与 TLS 身份分开传递：传输层只连接批准的数字地址，证书校验和 HTTP Host 保留经登记的域名。
    url = httpx.URL(
        scheme="https",
        host=target.address,
        port=origin.port,
        raw_path=path + (b"?" + query if query else b""),
    )
    # 同一次请求只生成一个时间值，Header 插值与表达式读取同一个秒值，以免跨秒构造造成签名无法验证。
    timestamp = str(int(now_utc.timestamp()))
    headers = {"Host": origin.netloc, "Accept-Encoding": "identity"}
    for header, template in source["headers"].items():
        resolved = re.sub(
            r"\{\{(.*?)\}\}",
            lambda m: timestamp if m[1] == "request.timestamp" else strings[m[1][4:]],
            template,
        )
        if len(resolved) > 4096 or any(not 32 <= ord(c) <= 126 for c in resolved):
            raise unavailable()
        headers[header] = resolved
    if source["body"]:
        headers["Content-Type"] = media
    auth = source["auth"]
    if auth["kind"] != "NONE":
        wire = {
            "QUERY": query,
            "BODY": content,
            "PATH": path,
            "METHOD": source["method"].encode(),
            "TIMESTAMP": timestamp.encode(),
        }
        key, header_value = auth_header(
            auth, key_resolver(auth["secretRef"], auth["secretVersionId"]), wire, strings, pairs
        )
        headers[key] = header_value
    if sum(len(name) + len(value) + 4 for name, value in headers.items()) > 16384:
        raise unavailable()
    return httpx.Request(
        source["method"],
        url,
        headers=headers,
        content=content,
        extensions={
            "sni_hostname": origin.hostname,
            "timeout": dict.fromkeys(("connect", "read", "write", "pool"), 4.0),
        },
    )


async def _page(
    transport: httpx.AsyncBaseTransport, wire: httpx.Request, remaining: int
) -> tuple[object, int]:
    # 调试过滤器使用任务局部状态保护整次读取，连接失败和异常取消也会恢复调用方的原始日志上下文。
    token = _WIRE_ACTIVE.set(True)
    try:
        return await _read_page(transport, wire, remaining)
    finally:
        _WIRE_ACTIVE.reset(token)


async def _read_page(
    transport: httpx.AsyncBaseTransport, wire: httpx.Request, remaining: int
) -> tuple[object, int]:
    response = await transport.handle_async_request(wire)
    try:
        if not 200 <= response.status_code < 300:
            raise Problem(502, "DATASET_UPSTREAM_REJECTED", "Dataset upstream rejected the read")
        if response.headers.get("content-encoding", "identity") != "identity":
            raise invalid()
        # 按原始传输分块扣除剩余预算，避免根据上游自报的长度预分配内存或在解压后发现响应已经超限。
        raw = bytearray()
        async for part in response.aiter_raw():
            if len(raw) + len(part) > remaining:
                raise _limit()
            raw.extend(part)
        try:
            return json.loads(raw), len(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise invalid() from None
    finally:
        await response.aclose()


def verify_signature(
    config: BoundDataset, args: dict[str, Any], secret: SecretResolver, probe: dict[str, str]
) -> dict[str, bool]:
    """在固定 UTC 时间构造相同的请求字节并恒时比较签名，只返回匹配状态且不会为验证操作发起请求。"""
    auth = config.document["source"]["auth"]
    if auth.get("algorithm") != "HMAC_SHA256":
        raise unavailable()
    # 日期时间契约允许小写的分隔符与 UTC 后缀，标准库解析前统一其大小写以支持同一时刻的等价写法。
    try:
        at = datetime.fromisoformat(probe["at"].upper())
    except ValueError:
        raise unavailable() from None
    if at.tzinfo is None:
        raise unavailable()
    wire = build_request(config, args, at, secret)
    return {
        "signatureMatches": hmac.compare_digest(wire.headers[auth["header"]], probe["expected"])
    }


def open_transport() -> httpx.AsyncHTTPTransport:
    """为一次有界读取建立独立且启用证书校验的连接池，不读取环境代理或跨读取复用旧授权连接。"""
    # 显式创建校验对端证书和主机名的 TLS 客户端上下文，不从环境变量开启会话密钥记录或代理。
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    return httpx.AsyncHTTPTransport(verify=context, trust_env=False, retries=0)


def _retryable_connect(error: BaseException | None) -> bool:
    if isinstance(error, httpx.ConnectTimeout):
        return True
    # 仅在异常链中找到明确的暂时性套接字错误时重试，证书失败与原因未知的连接错误不能通过重试掩盖。
    for _ in range(8):
        if error is None:
            break
        if isinstance(error, ssl.SSLError):
            return False
        if isinstance(error, OSError) and error.errno in {
            errno.ECONNRESET,
            errno.ECONNREFUSED,
            errno.ETIMEDOUT,
            errno.EHOSTUNREACH,
            errno.ENETUNREACH,
            errno.EAGAIN,
        }:
            return True
        error = error.__cause__ or error.__context__
    return False


async def fetch_rows(
    config: BoundDataset,
    args: dict[str, Any],
    key_resolver: SecretResolver,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    recheck: Callable[[], Awaitable[None]] | None = None,
) -> list[dict[str, Any]]:
    """一次逻辑读取只占用一个并发槽；仅部署允许的 GET 连接失败重试一次，并共享分页与重试的十秒期限。"""
    if SLOTS.locked():
        raise Problem(429, "DATASET_BUSY", "Dataset request capacity exhausted")
    deadline = time.monotonic() + 10
    async with SLOTS:
        try:
            async with asyncio.timeout(10), transport or open_transport() as client:
                rows = []
                seen = set()
                budget = MAX_BYTES
                mapped = MappingBudget(deadline=deadline)
                source = config.document["source"]
                paging = source.get("pagination")
                cursor = None
                for number in range(1, (paging["maxPages"] if paging else 1) + 1):
                    if number > 1 and recheck:
                        await recheck()
                    wire = build_request(
                        config,
                        args,
                        datetime.now(UTC),
                        key_resolver,
                        page_number=number,
                        cursor=cursor,
                    )
                    try:
                        page, size = await _page(client, wire, budget)
                    except (httpx.ConnectError, httpx.ConnectTimeout) as fault:
                        # 只有建立连接阶段失败时才复用已签名的 GET 请求；已发出的请求或未声明幂等的 POST 都不重复发送。
                        if (
                            not config.connection.retry_reads
                            or source["method"] != "GET"
                            or not _retryable_connect(fault)
                        ):
                            raise
                        if recheck:
                            await recheck()
                        page, size = await _page(client, wire, budget)
                    budget -= size
                    rows.extend(map_response(config.document, page, budget=mapped))
                    if time.monotonic() >= deadline:
                        raise TimeoutError
                    if not paging:
                        return complete_rows(rows)
                    token = pointer(page, paging["next"])
                    if paging["kind"] == "PAGE":
                        if type(token) is not bool:
                            raise _incomplete()
                        if not token:
                            return complete_rows(rows)
                    else:
                        if token is None:
                            return complete_rows(rows)
                        if (
                            type(token) is not str
                            or not token
                            or len(token) > 1024
                            or token in seen
                        ):
                            raise _incomplete()
                        seen.add(token)
                        cursor = token
                raise _incomplete()
        except (TimeoutError, httpx.TimeoutException):
            raise Problem(504, "DATASET_REQUEST_TIMEOUT", "Dataset read timed out") from None
        except httpx.HTTPError:
            raise Problem(
                502, "DATASET_TRANSPORT_FAILED", "Dataset upstream is unavailable"
            ) from None
        except (UnicodeError, ValueError, RecursionError):
            raise invalid() from None


def masked_preview(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """预览公开行数和前十行实际存在的声明字段名，连行键也可能携带业务信息，因此不把键或值放入管理响应。"""
    return {
        "rowCount": len(rows),
        "sample": [{"fields": sorted(row["values"])} for row in rows[:10]],
    }
