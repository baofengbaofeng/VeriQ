"""将服务端与 Python 依赖的日志经统一渲染器输出到现有诊断流。"""

from contextlib import nullcontext
from datetime import UTC, datetime
import logging
import os
import re
from typing import Any

from tornado.web import RequestHandler

from .log_format import render_log
from .logging_context import current_trace, use_trace

NOTICE = logging.INFO
STRACE = 27
TRACE = 15

_LEVELS = {
    "FATAL": logging.CRITICAL,
    "ERROR": logging.ERROR,
    "WARNING": logging.WARNING,
    "STRACE": STRACE,
    "NOTICE": NOTICE,
    "TRACE": TRACE,
    "DEBUG": logging.DEBUG,
}
_LEVEL_NAMES = {value: name for name, value in _LEVELS.items()}
_SENSITIVE_SOURCES = {
    "aiosmtplib",
    "alembic",
    "anthropic",
    "asyncmy",
    "boto3",
    "botocore",
    "httpcore",
    "httpx",
    "openai",
    "s3transfer",
    "sqlalchemy",
    "tornado",
    "urllib3",
}
_EVENT_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}(?:\.[a-z][a-z0-9_]{0,63}){0,3}")
_logger = logging.getLogger("veriq")
_logger.setLevel(NOTICE)


def _trace_fields() -> dict[str, str]:
    trace = current_trace()
    if trace is None:
        return {}
    fields = {"traceid": trace.trace_id, "spanid": trace.span_id}
    if trace.request_id is not None:
        fields["request_id"] = trace.request_id
    return fields


def log(tag: str, event: str, *, level: int = NOTICE, **fields: Any) -> None:
    """发出预先筛选过的结构化字段，并保留业务调用点作为源位置。"""
    if _logger.isEnabledFor(level):
        context = _trace_fields()
        for key in ("traceid", "spanid", "request_id"):
            fields.pop(key, None)
        child = fields.pop("cspanid", None)
        if child is not None:
            context["cspanid"] = child
        _logger.log(
            level,
            event,
            stacklevel=2,
            extra={"veriq_tag": tag, "veriq_fields": {**context, "event": event, **fields}},
        )


class LogFormatter(logging.Formatter):
    """以统一协议渲染业务日志，隔离第三方可能包含原始请求的诊断文本。"""

    def format(self, record: logging.LogRecord) -> str:
        level = _LEVEL_NAMES.get(record.levelno, "NOTICE")
        fields = getattr(record, "veriq_fields", None)
        if fields is None:
            fields = {**_trace_fields(), "source": record.name}
            if record.exc_info and record.exc_info[0]:
                fields["error_type"] = record.exc_info[0].__name__
            sensitive = record.name.partition(".")[0] in _SENSITIVE_SOURCES
            event = getattr(record, "event", None)
            if not sensitive and isinstance(event, str) and _EVENT_NAME.fullmatch(event):
                fields["event"] = event
            fields["_msg"] = (
                "dependency diagnostic" if sensitive else self._dependency_message(record)
            )
        return render_log(
            level,
            datetime.fromtimestamp(record.created, UTC),
            f"{record.filename}:{record.lineno}" if record.filename and record.lineno else "",
            getattr(record, "veriq_tag", "_undef"),
            fields,
        )

    @staticmethod
    def _dependency_message(record: logging.LogRecord) -> str:
        try:
            return record.getMessage()
        except (TypeError, ValueError):
            return "dependency diagnostic unavailable"


def configure_logging() -> None:
    """为独立服务进程启用单一 stderr 诊断输出，默认阈值为 NOTICE。"""
    level = _LEVELS.get(os.environ.get("LOG_LEVEL", "").strip().upper(), NOTICE)
    handler = logging.StreamHandler()
    handler.setLevel(level)
    handler.setFormatter(LogFormatter())
    logging.basicConfig(handlers=[handler], level=level, force=True)
    # 标准日志的调试错误输出会回显原始消息与参数，服务进程只允许经过渲染器的诊断。
    logging.raiseExceptions = False
    _logger.setLevel(level)
    # 导入时已有独立处理器的依赖也必须经过脱敏边界。
    # Dotted loggers can exist before their named parents and are absent from getChildren().
    for dependency in logging.Logger.manager.loggerDict.copy().values():
        if not isinstance(dependency, logging.Logger):
            continue
        for existing in dependency.handlers[:]:
            dependency.removeHandler(existing)
        dependency.propagate = True


def request_log(handler: RequestHandler) -> None:
    """记录 Tornado 的响应完成事件，路径使用路由动作而非请求 URI。"""
    trace = getattr(handler, "trace", None)
    with use_trace(trace) if trace is not None else nullcontext():
        log(
            "_com_request_out",
            "request.finished",
            uri=getattr(handler, "action", "") or "unknown",
            errno=handler.get_status(),
            proc_time=round(handler.request.request_time(), 6),
        )
