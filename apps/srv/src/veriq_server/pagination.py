"""Bounded keyset cursors, signed and scoped to the authorized list/filter."""

import json
from dataclasses import dataclass
from typing import Any

from tornado.web import RequestHandler, create_signed_value, decode_signed_value

from .service import Problem


@dataclass
class Page:
    limit: int
    last: tuple[str, str] | None
    scope: dict[str, Any]
    secret: str

    @classmethod
    def read(cls, handler: RequestHandler, scope: dict[str, Any], secret: str) -> "Page":
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
        if not has_more:
            return None
        value = json.dumps(
            {"scope": self.scope, "last": list(last)}, separators=(",", ":"), ensure_ascii=False
        )
        return create_signed_value(self.secret, "veriq_list_v1", value, version=2).decode()


def boolean_filter(handler: RequestHandler, name: str) -> bool | None:
    value = handler.get_query_argument(name, None)
    if value is None:
        return None
    if value not in {"true", "false"}:
        raise Problem(400, "INVALID_FILTER", f"{name} must be true or false")
    return value == "true"
