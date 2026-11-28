"""核对并发请求的链路隔离、下游跨度继承和响应头，并验证依赖日志及异常响应不会泄漏敏感请求内容。"""

import asyncio
from io import StringIO
import logging
import os
import re
import subprocess
import sys

from tornado.httpclient import AsyncHTTPClient, HTTPRequest
from tornado.testing import AsyncHTTPTestCase, gen_test
from tornado.web import Application

from veriq_server.handlers.base import API
from veriq_server.log import LogFormatter, NOTICE, log, request_log
from veriq_server.logging_context import child_span, current_trace, trace_headers, use_trace


class Probe(API):
    """通过异步等待让并发请求交错记录日志，按查询参数触发含敏感消息的异常，供响应和诊断脱敏断言使用。"""

    async def get(self):
        await asyncio.sleep(0.01)
        log("_undef", "probe.running")
        if self.get_query_argument("fail", None):
            raise RuntimeError("private@example.test")
        self.respond({})


class TestRequestLogging(AsyncHTTPTestCase):
    def get_app(self):
        return Application(
            [(r"/probe", Probe, {"config": None, "db": None, "action": "probe"})],
            log_function=request_log,
        )

    @gen_test
    async def test_request_lifecycle(self):
        output = StringIO()
        sink = logging.StreamHandler(output)
        sink.setFormatter(LogFormatter())
        logger = logging.getLogger("veriq")
        previous = logger.level
        logger.setLevel(NOTICE)
        logger.addHandler(sink)
        try:
            client = AsyncHTTPClient()
            trace, span = "a" * 32, "b" * 16
            requests = [
                HTTPRequest(
                    self.get_url("/probe"),
                    headers={
                        "X-Trace-Id": trace.upper(),
                        "X-Cspanid": span,
                    },
                ),
                HTTPRequest(
                    self.get_url("/probe?fail=private-input"),
                    headers={
                        "X-Trace-Id": "0" * 32,
                        "X-Cspanid": "bad",
                    },
                ),
            ]
            ok, error = await asyncio.gather(
                *(client.fetch(request, raise_error=False) for request in requests)
            )
        finally:
            logger.removeHandler(sink)
            logger.setLevel(previous)
        assert ok.code == 200
        assert error.code == 500
        assert ok.headers["X-Trace-Id"] == trace
        assert ok.headers["X-Cspanid"] == span
        assert re.fullmatch("[0-9a-f]{32}", error.headers["X-Trace-Id"])
        assert error.headers["X-Trace-Id"] != "0" * 32
        lines = output.getvalue().splitlines()
        for response in (ok, error):
            local_trace = response.headers["X-Trace-Id"]
            local_span = response.headers["X-Cspanid"]
            request_id = response.headers["X-Request-Id"]
            records = [line for line in lines if f"||traceid={local_trace}" in line]
            assert sum("_com_request_in||" in line for line in records) == 1
            assert sum("_com_request_out||" in line for line in records) == 1
            assert sum("probe.running" in line for line in records) == 1
            assert all(f"||spanid={local_span}" in line for line in records)
            assert all(f"||request_id={request_id}" in line for line in records)
            assert f"||errno={response.code}" in records[-1]
        assert "private" not in output.getvalue()
        assert current_trace() is None


def test_trace_scope():
    parent = child_span()
    with use_trace(parent):
        child = child_span()
        assert current_trace() is parent
        assert child.trace_id == parent.trace_id
        assert child.span_id != parent.span_id
        assert trace_headers(child) == {"x-trace-id": child.trace_id, "x-cspanid": child.span_id}
        with use_trace(child):
            assert current_trace() is child
        assert current_trace() is parent
    assert current_trace() is None


def test_untrusted_dependency_diagnostics():
    formatter = LogFormatter()
    record = logging.LogRecord(
        "sqlalchemy.engine",
        logging.ERROR,
        "/deps/base.py",
        4,
        "private=%s",
        ("private-input",),
        None,
    )
    rendered = formatter.format(record)
    assert "_undef||" in rendered
    assert "base.py:4" in rendered
    assert "sqlalchemy.engine" in rendered
    assert "private" not in rendered


def test_safe_dependency_message_without_trace():
    record = logging.LogRecord(
        "dependency.scheduler",
        logging.WARNING,
        "/deps/base.py",
        8,
        "draining %s workers",
        (3,),
        None,
    )
    rendered = LogFormatter().format(record)
    assert "source=dependency.scheduler" in rendered
    assert "_msg=draining 3 workers" in rendered
    assert "||traceid=" not in rendered
    assert "||spanid=" not in rendered


def test_dependency_event_retains_only_approved_extra():
    record = logging.LogRecord(
        "dependency.scheduler", logging.WARNING, "/deps/base.py", 8, "finished", (), None
    )
    record.event = "dependency.job_finished"
    record.private_note = "private-input"
    formatter = LogFormatter()
    assert "||event=dependency.job_finished" in formatter.format(record)
    assert "private-input" not in formatter.format(record)
    record.event = "untrusted text"
    assert "||event=" not in formatter.format(record)


def test_configure_logging_uses_single_safe_stderr_sink():
    script = """
import logging
from veriq_server.log import configure_logging, log

dependency = logging.getLogger("httpcore.wire")
dependency.addHandler(logging.StreamHandler())
dependency.propagate = False
configure_logging()
log("_undef", "probe.notice")
dependency.warning("private-wire-input")
log("_undef", "probe.warning", level=logging.WARNING)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "LOG_LEVEL": "WARNING"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout == ""
    assert "probe.notice" not in result.stderr
    assert "private-wire-input" not in result.stderr
    assert result.stderr.count("httpcore.wire") == 1
    assert result.stderr.count("probe.warning") == 1
    assert len(result.stderr.splitlines()) == 2


def test_dependency_info_uses_notice_and_existing_handler_is_removed():
    script = """
import logging
from veriq_server.log import configure_logging

dependency = logging.getLogger("partner_package.worker")
dependency.addHandler(logging.StreamHandler())
dependency.propagate = False
configure_logging()
dependency.info("Queue received")
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "LOG_LEVEL": "NOTICE"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout == ""
    assert result.stderr.startswith("[NOTICE]")
    assert result.stderr.count("Queue received") == 1
    assert "||source=partner_package.worker||" in result.stderr
    assert len(result.stderr.splitlines()) == 1
