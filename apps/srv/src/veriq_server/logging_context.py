"""通过任务本地上下文在入站请求、业务日志及下游调用之间传递关联标识。"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import re
import secrets

_TRACE_HEADER = "x-trace-id"
_SPAN_HEADER = "x-cspanid"


@dataclass(frozen=True, slots=True)
class TraceContext:
    """携带有效的链路和当前跨度标识，HTTP 请求额外携带公开请求编号。"""

    trace_id: str
    span_id: str
    request_id: str | None = None


_current_trace: ContextVar[TraceContext | None] = ContextVar("veriq_trace", default=None)


def _identifier(value: str, width: int) -> str:
    if len(value) == width and re.fullmatch("[0-9a-fA-F]+", value) and int(value, 16):
        return value.lower()
    generated = secrets.token_hex(width // 2)
    while generated == "0" * width:
        generated = secrets.token_hex(width // 2)
    return generated


def current_trace() -> TraceContext | None:
    """读取当前任务的请求或后台关联上下文。"""
    return _current_trace.get()


def new_trace() -> TraceContext:
    """为独立的后台工作建立关联上下文。"""
    return TraceContext(_identifier("", 32), _identifier("", 16))


def inbound_trace(headers: Mapping[str, str], request_id: str) -> TraceContext:
    """验证入站标识，每个缺失或不合法的标识由服务端单独生成。"""
    return TraceContext(
        _identifier(headers.get(_TRACE_HEADER, ""), 32),
        _identifier(headers.get(_SPAN_HEADER, ""), 16),
        request_id,
    )


@contextmanager
def use_trace(trace: TraceContext) -> Iterator[None]:
    """仅在当前作用域内绑定标识，退出时恢复调用者上下文。"""
    token = _current_trace.set(trace)
    try:
        yield
    finally:
        _current_trace.reset(token)


def child_span() -> TraceContext:
    """为下游调用分配跨度，保留已存在的链路和公开请求编号。"""
    trace = current_trace()
    if trace is None:
        return new_trace()
    return TraceContext(trace.trace_id, _identifier("", 16), trace.request_id)


def trace_headers(trace: TraceContext) -> dict[str, str]:
    """生成 HTTP 边界使用的关联请求和响应头。"""
    return {_TRACE_HEADER: trace.trace_id, _SPAN_HEADER: trace.span_id}
