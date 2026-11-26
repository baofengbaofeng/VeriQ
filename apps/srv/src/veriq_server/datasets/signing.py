"""签名表达式只消费请求构造器提供的冻结字节，选取与排序不修改实际查询参数，也不允许表达式读取密钥。"""

import base64
import hashlib
import hmac
import os
from urllib.parse import quote_from_bytes, quote, urlencode

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .policy import unavailable


def query_bytes(pairs) -> bytes:
    """对有序二元组执行 RFC3986 百分号编码，重复键与空值仍占独立位置，空格固定编码为百分之二十。"""
    return urlencode(pairs, quote_via=quote, safe="").encode("ascii")


def signature_input(node, wire, args, pairs) -> bytes:
    """逐层计算经过验证的小型字节表达式，每步均检查中间结果预算，避免重复百分号编码放大内容。"""
    op = node["op"]
    if op in wire:
        result = wire[op]
    elif op == "LITERAL":
        result = node["value"].encode()
    elif op == "PARAMETER":
        result = args[node["name"]].encode()
    # 稳定排序按原文 Unicode 码点先比较名称再比较值，编码发生在排序之后；筛选不去重，也不改变线上请求顺序。
    elif op == "SORTED_QUERY":
        names = node.get("names")
        result = query_bytes(sorted(p for p in pairs if names is None or p[0] in names))
    elif op == "JOIN":
        result = (
            node["separator"]
            .encode()
            .join(signature_input(n, wire, args, pairs) for n in node["parts"])
        )
    else:
        value = signature_input(node["input"], wire, args, pairs)
        if op == "SHA256":
            result = hashlib.sha256(value).hexdigest().encode()
        elif op == "BASE64":
            result = base64.b64encode(value)
        elif op == "PERCENT_ENCODE":
            result = quote_from_bytes(value, safe="").encode()
        else:
            raise unavailable()
    if len(result) > 65536:
        raise unavailable()
    return result


def auth_header(auth, secret, wire, args, pairs):
    """签名仅写入已批准的请求头，加密通过库生成认证密文并使用新随机 nonce，固定输入签名可独立复算。"""
    if auth["kind"] == "BASIC":
        if not isinstance(secret, dict) or any(
            type(secret.get(k)) is not str for k in ("username", "password")
        ):
            raise unavailable()
        if ":" in secret["username"]:
            raise unavailable()
        token = (secret["username"] + ":" + secret["password"]).encode()
        return "Authorization", "Basic " + base64.b64encode(token).decode()
    if type(secret) is not str or not secret:
        raise unavailable()
    if auth["kind"] in {"BEARER", "API_KEY"}:
        if not all(33 <= ord(c) <= 126 for c in secret):
            raise unavailable()
        return (
            (auth["header"], secret)
            if auth["kind"] == "API_KEY"
            else ("Authorization", "Bearer " + secret)
        )
    message = signature_input(auth["input"], wire, args, pairs)
    if auth["algorithm"] == "HMAC_SHA256":
        return auth["header"], hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    try:
        key = base64.b64decode(secret, validate=True)
        if len(key) != 32:
            raise ValueError
        # 认证加密的随机数由操作系统生成，不取自声明、查询顺序或固定请求时间，以免同一密钥在重试时重复使用随机数。
        nonce = os.urandom(12)
        return (
            auth["header"],
            base64.b64encode(nonce + AESGCM(key).encrypt(nonce, message, None)).decode(),
        )
    except ValueError:
        raise unavailable() from None
