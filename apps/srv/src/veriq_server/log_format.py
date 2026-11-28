"""服务端日志与共享脚本渲染器遵守同一单行事件协议，对字段脱敏、转义并限制整条输出的编码字节数。"""

from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
import math
import re

_LEVELS = frozenset({"FATAL", "ERROR", "WARNING", "STRACE", "NOTICE", "TRACE", "DEBUG"})
_LEVEL_ALIASES = {"INFO": "NOTICE", "WARN": "WARNING", "CRITICAL": "FATAL"}
_TAGS = frozenset(
    {
        "_undef",
        "_com_request_in",
        "_com_request_out",
        "_com_http_success",
        "_com_http_failure",
        "_com_mysql_success",
        "_com_mysql_failure",
        "_com_smtp_success",
        "_com_smtp_failure",
    }
)
_REDACTED = "***"
_SECRET_NAME = (
    r"password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential(?:s)?|"
    r"authorization|cookie|session(?:[_-]?id)?|phone|id[_-]?card|email|dsn|(?:db|database)[_-]?url"
)
_SENSITIVE_KEY = re.compile(rf"(?:^|_)(?:{_SECRET_NAME})(?:_|$)", re.IGNORECASE | re.ASCII)
_SECRET_ASSIGNMENT = re.compile(
    rf"""((?a:\b)[a-z0-9_-]{{0,128}}?(?:{_SECRET_NAME})["']?[\s\ufeff]*[:=][\s\ufeff]*)"""
    r"""(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s\ufeff,;&|"'<>]+)""",
    re.IGNORECASE,
)
_URL_CREDENTIALS = re.compile(r"(?a:\b)([a-z][a-z0-9+.-]{0,31}://)[^\s\ufeff/?#]+@", re.IGNORECASE)
_DATABASE_URL = re.compile(
    r"""(?a:\b)(?:mysql|mariadb|postgres(?:ql)?|mongodb|redis|mssql)(?:[+-][a-z0-9_-]{1,32})?://[^\s\ufeff"'<>]+""",
    re.IGNORECASE,
)
_PERSONAL_NUMBER = re.compile(
    r"(?<![a-z0-9])(?:(?:\+86[ -]?)?1[3-9][0-9]{9}|[1-9][0-9]{5}(?:18|19|20)[0-9]{9}[0-9X])(?![a-z0-9])",
    re.IGNORECASE | re.ASCII,
)
_AUTH_CREDENTIALS = re.compile(r"(?a:\b)(?:Bearer|Basic)[\s\ufeff]+[a-z0-9._~+/=-]+", re.IGNORECASE)
_JWT = re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.(?:[A-Za-z0-9_-]*\.){1,3}[A-Za-z0-9_-]*")
_EMAIL = re.compile(
    r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}", re.IGNORECASE | re.ASCII
)
_LOCATION = re.compile(r"[^\s\[\]:/\\\x00-\x1f\x7f\ud800-\udfff]{1,255}:[0-9]{1,10}")
_MAX_BYTES = 4096
_ESCAPES = {"\\": "\\\\", "|": "\\|", "=": "\\=", "\r": "\\r", "\n": "\\n", "\t": "\\t"}


def _escape(character: str) -> str:
    if character in _ESCAPES:
        return _ESCAPES[character]
    code = ord(character)
    if code < 0x20 or code in {0x7F, 0x85, 0x2028, 0x2029}:
        return f"\\u{code:04x}"
    return "\ufffd" if 0xD800 <= code <= 0xDFFF else character


def _scalar(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        if value == 0:
            return "0"
        significand, _, exponent = repr(value).partition("e")
        significand = significand.removesuffix(".0")
        if 1e-6 <= abs(value) < 1e21:
            return format(Decimal(repr(value)), "f").removesuffix(".0")
        return f"{significand}e{int(exponent):+d}" if exponent else significand
    return None


def _field_value(key: str, value: object) -> str | None:
    text = _scalar(value)
    if text is None:
        return None
    normalized_key = re.sub(r"[\s.-]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key))
    if not re.search(r"_(?:count|total|length|size|bytes)$", normalized_key, re.IGNORECASE):
        if _SENSITIVE_KEY.search(normalized_key):
            return _REDACTED

    if key == "_stack":
        text = re.sub(r"[\r\n]+", " ", text)
    if key in {"_msg", "_stack", "errmsg"}:
        text = _PERSONAL_NUMBER.sub(_REDACTED, text)
    if "://" in text:
        text = _DATABASE_URL.sub(_REDACTED, text)
    if "@" in text:
        text = _URL_CREDENTIALS.sub(r"\g<1>", text)
    text = _AUTH_CREDENTIALS.sub(_REDACTED, text)
    if ":" in text or "=" in text:
        text = _SECRET_ASSIGNMENT.sub(rf"\g<1>{_REDACTED}", text)
    if "eyJ" in text:
        text = _JWT.sub(_REDACTED, text)
    return _EMAIL.sub(_REDACTED, text) if "@" in text else text


def render_log(
    level: str,
    timestamp: datetime,
    location: str,
    tag: str = "_undef",
    fields: Mapping[str, object] | None = None,
) -> str:
    """将级别、时间、来源及结构化字段编码成有字节上限的单行日志，统一使用零时区数字偏移并转义控制字符。"""
    upper_level = level.upper()
    resolved_level = (
        upper_level if upper_level in _LEVELS else _LEVEL_ALIASES.get(upper_level, "NOTICE")
    )
    resolved_tag = tag if tag in _TAGS else "_undef"
    caller = location if _LOCATION.fullmatch(location) else ""
    instant = (
        timestamp.replace(tzinfo=timezone.utc)
        if timestamp.tzinfo is None
        else timestamp.astimezone(timezone.utc)
    )
    formatted = instant.isoformat(timespec="milliseconds").replace("+00:00", "+0000")
    parts = [f"[{resolved_level}][{formatted}][{caller}] {resolved_tag}"]
    size = len(parts[0].encode())
    for key, raw in (fields or {}).items():
        value = _field_value(key, raw)
        if not key or value is None:
            continue

        field = "||" + "".join(map(_escape, key)) + "="
        field_size = len(field.encode())
        if size + field_size + 3 > _MAX_BYTES:
            break
        parts.append(field)
        size += field_size
        for character in value:
            escaped = _escape(character)
            byte_count = len(escaped.encode())
            if size + byte_count + 3 > _MAX_BYTES:
                return "".join(parts) + "…"
            parts.append(escaped)
            size += byte_count

    return "".join(parts) if len(parts) > 1 else parts[0] + "||"
