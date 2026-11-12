"""分页游标用签名 Cookie 绑定列表作用域与 last 键，防止跨 Workspace 或筛选条件复用游标以及篡改翻页位置。

Page.read 校验 limit∈[1,100]，并用 cookie_secret 解码 veriq_list_v1；scope 必须字节级等于当前列表过滤。
next() 在 has_more 时签发新游标，过期窗口一天；boolean_filter 仅接受字面 true/false。
"""

import json
from dataclasses import dataclass
from typing import Any

from tornado.web import RequestHandler, create_signed_value, decode_signed_value

from .service import Problem


@dataclass
class Page:
    """已解析的列表分页状态：包含 limit、可选 last 游标键、绑定 scope 以及签名所用密钥，Page 的失败路径返回稳定错误。
    Page 实现于 apps/srv/src/veriq_server/pagination.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    limit: int
    last: tuple[str, str] | None
    scope: dict[str, Any]
    secret: str

    @classmethod
    def read(cls, handler: RequestHandler, scope: dict[str, Any], secret: str) -> "Page":
        """从查询串解析 limit 与 cursor；游标失效、过期或 scope 不匹配时统一返回 INVALID_CURSOR。
        read 实现于 apps/srv/src/veriq_server/pagination.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        try:
            limit = int(handler.get_query_argument("limit", "25"))
        except ValueError:
            raise Problem(
                400, "INVALID_LIMIT", "Page limit must be an integer from 1 to 100"
            ) from None
        if not 1 <= limit <= 100:
            raise Problem(400, "INVALID_LIMIT", "Page limit must be an integer from 1 to 100")
        cursor = handler.get_query_argument("cursor", None)
        last = None
        if cursor is not None:
            try:
                if not cursor or len(cursor) > 4096:
                    raise ValueError
                decoded = decode_signed_value(
                    secret, "veriq_list_v1", cursor, max_age_days=1, min_version=2
                )
                if decoded is None:
                    raise ValueError
                value = json.loads(decoded)
                if (
                    not isinstance(value, dict)
                    or set(value) != {"scope", "last"}
                    or value["scope"] != scope
                ):
                    raise ValueError
                keys = value["last"]
                if (
                    not isinstance(keys, list)
                    or len(keys) != 2
                    or not all(isinstance(key, str) and 0 < len(key) <= 254 for key in keys)
                ):
                    raise ValueError
                last = (keys[0], keys[1])
            except (ValueError, TypeError, UnicodeError):
                raise Problem(
                    400,
                    "INVALID_CURSOR",
                    "List cursor is invalid, expired or belongs to another list/filter",
                ) from None
        return cls(limit, last, scope, secret)

    def next(self, last: tuple[str, str], has_more: bool) -> str | None:
        """若仍有后续页则签发绑定当前 scope 的签名游标，否则返回 None 以结束翻页，Page.next 的失败路径返回稳定错误。
        next 实现于 apps/srv/src/veriq_server/pagination.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if not has_more:
            return None
        value = json.dumps(
            {"scope": self.scope, "last": list(last)}, separators=(",", ":"), ensure_ascii=False
        )
        return create_signed_value(self.secret, "veriq_list_v1", value, version=2).decode()


def boolean_filter(handler: RequestHandler, name: str) -> bool | None:
    """读取可选布尔查询参数；缺省为 None，遇到非法字面量时抛出 INVALID_FILTER，boolean_filter 的失败路径返回稳定错误。
    boolean_filter 实现于 apps/srv/src/veriq_server/pagination.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    value = handler.get_query_argument(name, None)
    if value is None:
        return None
    if value not in {"true", "false"}:
        raise Problem(400, "INVALID_FILTER", f"{name} must be true or false")
    return value == "true"
