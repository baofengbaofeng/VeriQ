"""通过任务本地上下文在入站请求、业务日志及下游调用之间传递链路与跨度标识，避免并发请求互相污染。"""

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
    """不可变上下文携带链路和当前跨度标识，入站请求还保存公开请求编号，使后续子调用能够继续关联原请求。"""

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
    """读取当前异步任务已绑定的请求或后台关联上下文，未进入绑定作用域时返回空值，交由调用方决定是否新建。"""
    return _current_trace.get()


def new_trace() -> TraceContext:
    """为独立后台工作新建非零的十六进制链路和跨度标识，不附加公开请求编号，供没有入站请求的调用使用。"""
    return TraceContext(_identifier("", 32), _identifier("", 16))


def inbound_trace(headers: Mapping[str, str], request_id: str) -> TraceContext:
    """分别验证入站链路和跨度的长度及非零十六进制格式，无效字段独立重新生成，并附加服务端公开请求编号。"""
    return TraceContext(
        _identifier(headers.get(_TRACE_HEADER, ""), 32),
        _identifier(headers.get(_SPAN_HEADER, ""), 16),
        request_id,
    )


@contextmanager
def use_trace(trace: TraceContext) -> Iterator[None]:
    """进入作用域时将链路上下文绑定到当前异步任务，使用令牌在正常结束或异常退出时恢复调用者原有上下文。"""
    token = _current_trace.set(trace)
    try:
        yield
    finally:
        _current_trace.reset(token)


def child_span() -> TraceContext:
    """为下游调用创建独立跨度并继承现有链路和公开请求编号；没有父上下文时建立新的后台链路上下文。"""
    trace = current_trace()
    if trace is None:
        return new_trace()
    return TraceContext(trace.trace_id, _identifier("", 16), trace.request_id)


def trace_headers(trace: TraceContext) -> dict[str, str]:
    """将已确认的链路和跨度标识映射成固定的请求头字段，供入站响应和下游请求复用，不输出公开请求编号。"""
    return {_TRACE_HEADER: trace.trace_id, _SPAN_HEADER: trace.span_id}
