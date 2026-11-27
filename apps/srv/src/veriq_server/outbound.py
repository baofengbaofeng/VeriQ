"""Result logging shared by the server's outbound transport boundaries."""

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
        """Record the terminal outcome once, including when a stream is later closed."""
        if self.finished:
            return
        self.finished = True
        fields: dict[str, Any] = {
            **self.fields,
            "cspanid": self.span.span_id,
            "proc_time": monotonic() - self.started,
        }
        # An unavailable log sink must never replace a transport's result.
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
    """Bind a child span during the operation and log the outcome on its parent."""
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
    """Capture an S3 operation, including a streamed body when read by the caller."""
    from botocore.exceptions import ClientError

    with outbound("http", event, uri=event) as call:
        try:
            yield
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if type(status) is int:
                call.status = status
            raise
