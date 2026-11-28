"""在服务端下游传输边界共享结果日志和父子跨度关联，统一处理成功、异常及取消，并隔离诊断输出失败。"""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from logging import ERROR
import smtplib
from time import monotonic
from typing import Any, Literal

from .log import log
from .logging_context import TraceContext, child_span, current_trace, new_trace, use_trace

Transport = Literal["http", "mysql", "smtp"]


@dataclass
class OutboundCall:
    transport: Transport
    event: str
    fields: dict[str, str]
    failure_event: str | None = None
    status: int | None = None
    parent: TraceContext = field(init=False)
    span: TraceContext = field(init=False)
    started: float = field(default_factory=monotonic, init=False)
    finished: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self.parent = current_trace() or new_trace()
        with use_trace(self.parent):
            self.span = child_span()

    def finish(self, error: BaseException | None = None) -> None:
        """以幂等方式记录下游调用的最终结果和耗时，使用父跨度关联子调用标识，重复结束或流关闭不会重复记录。"""
        if self.finished:
            return
        self.finished = True
        fields: dict[str, Any] = {
            **self.fields,
            "cspanid": self.span.span_id,
            "proc_time": monotonic() - self.started,
        }
        # 日志输出不可用时必须保留传输调用原有的结果或异常，因此在父跨度作用域内忽略诊断输出自身的错误。
        with suppress(Exception), use_trace(self.parent):
            if error is not None or (self.status is not None and self.status >= 300):
                error_type = type(error).__name__ if error is not None else "HTTPStatusError"
                code: int | str = error_type
                if self.status is not None and self.status >= 300:
                    code = self.status
                elif isinstance(error, smtplib.SMTPResponseException):
                    code = error.smtp_code
                elif self.transport == "mysql" and error is not None and error.args:
                    if type(error.args[0]) is int:
                        code = error.args[0]
                log(
                    f"_com_{self.transport}_failure",
                    self.failure_event or self.event,
                    level=ERROR,
                    errno=code,
                    errmsg=error_type,
                    **fields,
                )
            else:
                log(f"_com_{self.transport}_success", self.event, **fields)


@contextmanager
def outbound(
    transport: Transport,
    event: str,
    *,
    failure_event: str | None = None,
    **fields: str,
) -> Iterator[OutboundCall]:
    """下游操作期间绑定独立子跨度，退出时在父跨度上记录一次结果；异常和异步取消记录后仍向调用方传播。"""
    call = OutboundCall(transport, event, fields, failure_event)
    try:
        with use_trace(call.span):
            yield call
    except (Exception, asyncio.CancelledError) as error:
        call.finish(error)
        raise
    else:
        call.finish()


@contextmanager
def s3_operation(event: str) -> Iterator[None]:
    """围住对象存储调用及调用方在作用域内读取响应流的过程，将服务错误中的状态码交给统一下游结果日志。"""
    from botocore.exceptions import ClientError

    with outbound("http", event, uri=event) as call:
        try:
            yield
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if type(status) is int:
                call.status = status
            raise
