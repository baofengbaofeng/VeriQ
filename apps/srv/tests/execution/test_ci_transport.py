"""CI 传输边界使用隔离本地 HTTP 服务模拟两次读取之间的门禁变化，验证客户端不会忽略最后下载的 JUnit 失败；
该协议测试不代替真实服务账号、已发布套件和 Agent 的组合验收。
"""

from concurrent.futures import ThreadPoolExecutor
import contextlib
import http.client
import http.server
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4
from xml.etree.ElementTree import fromstring, SubElement, tostring

import pytest

from veriq_server.handlers.trigger import sanitized_junit

from scripts.veriq_ci import Client, _publish_junit

_TRIGGER_RUN_ID = str(uuid4())


def _ci_report(run_id, *outcomes):
    """构造客户端消费的安全摘要和每个用例的独立执行身份，为状态、摘要及最终 JUnit 提供一致的对照。"""
    return {
        "run": {"id": run_id, "state": "FINISHED", "outcome": "PASSED"},
        "gatePassed": True,
        "cases": [
            {"id": str(uuid4()), "state": "FINISHED", "outcome": outcome} for outcome in outcomes
        ],
    }


def _assert_ci_result(tmp_path, status, report, xml, code):
    """用独立子进程和真实 HTTP 响应执行门禁，逐次检查退出码、交付的文件和临时文件的清理。"""

    class Handler(BaseHTTPRequestHandler):
        """通过回环服务向真实客户端交付独立的终态、摘要和最终下载响应，以便单独改变其中一个响应。"""

        def log_message(self, format, *args):
            """关闭临时 HTTP 服务的访问日志，协议断言读取子进程退出码和磁盘上最终留下的完整报告。"""
            del format, args

        def handle_trigger(self):
            """每次调用的触发回执均返回预定的运行标识，使状态与摘要响应能够独立提供一个错误的标识。"""
            self.send_response(202)
            self.end_headers()
            self.wfile.write(json.dumps({"data": {"runId": _TRIGGER_RUN_ID}}).encode())

        def handle_read(self):
            """分别从对应端点提供每个测试指定的状态、摘要和最终 XML，保留协议错误场景中的原始字节。"""
            self.send_response(200)
            self.end_headers()
            if self.path.endswith("/junit"):
                self.wfile.write(xml)
            else:
                data = report if self.path.endswith("/ci-report") else status
                self.wfile.write(json.dumps({"data": data}).encode())

        do_POST = handle_trigger
        do_GET = handle_read

    output = tmp_path / "junit.xml"
    output.write_bytes(b"previous report")
    with _status_listener(Handler) as server:
        process = subprocess.run(
            [
                sys.executable,
                "scripts/veriq_ci.py",
                "--server",
                f"http://127.0.0.1:{server.server_port}",
                "--workspace",
                str(uuid4()),
                "--plan",
                str(uuid4()),
                "--key",
                str(uuid4()),
                "--junit",
                str(output),
            ],
            env={**os.environ, "VERIQ_CI_TOKEN": "synthetic-protocol-token"},
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    assert process.returncode == code, process.stdout + process.stderr
    if code == 2:
        assert output.read_bytes() == b"previous report"
    else:
        assert tostring(fromstring(output.read_bytes())) == tostring(fromstring(xml))
    assert list(tmp_path.iterdir()) == [output]


@pytest.mark.parametrize(
    ("outcome", "cases", "gates", "code"),
    [
        ("PASSED", ["PASSED", "PASSED"], (True, True), 0),
        ("PASSED", ["PASSED"], (True, False), 1),
        ("PASSED", ["PASSED"], (False, True), 1),
        ("FAILED", ["PASSED", "FAILED"], (False, False), 1),
        ("SKIPPED", [], (False, False), 1),
    ],
)
def test_ci_publishes_final_junit_for_business_results(tmp_path, outcome, cases, gates, code):
    """以生产 JUnit 生成函数投影不同业务结果，终态授权可随时间改变，用例顺序不影响身份核对。"""
    summary_gate, final_gate = gates
    report = _ci_report(_TRIGGER_RUN_ID, *cases)
    report["run"]["outcome"] = outcome
    report["gatePassed"] = summary_gate
    suite = fromstring(sanitized_junit({**report, "gatePassed": final_gate}))
    suite[:] = list(reversed(suite))
    _assert_ci_result(tmp_path, report["run"], report, tostring(suite), code)


@pytest.mark.parametrize(
    ("part", "patch"),
    [
        ("status", {"id": str(uuid4())}),
        ("status", {"state": "UNKNOWN"}),
        ("run", {"id": str(uuid4())}),
        ("run", {"outcome": "CANCELLED"}),
        ("report", {"gatePassed": "false"}),
        ("report", {"cases": {"id": str(uuid4())}}),
        ("case", {"id": 123}),
        ("case", {"state": "RUNNING"}),
        ("case", {"outcome": "FAILED"}),
    ],
)
def test_ci_rejects_inconsistent_summary_fields(tmp_path, part, patch):
    """逐项改变门禁消费的协议字段，确保跨运行数据、结果不一致和错误类型均不会覆盖已有报告。"""
    report = _ci_report(_TRIGGER_RUN_ID, "PASSED")
    xml = sanitized_junit(report)
    status = report["run"].copy()
    sections = {
        "status": status,
        "report": report,
        "run": report["run"],
        "case": report["cases"][0],
    }
    sections[part].update(patch)
    _assert_ci_result(tmp_path, status, report, xml, 2)


def test_ci_rejects_duplicate_summary_case(tmp_path):
    """当摘要与 JUnit 以不同大小写重复同一用例 UUID 时，大小完全一致的两个集合仍不构成有效证据。"""
    report = _ci_report(_TRIGGER_RUN_ID, "PASSED", "PASSED")
    report["cases"][1]["id"] = report["cases"][0]["id"].upper()
    _assert_ci_result(tmp_path, report["run"], report, sanitized_junit(report), 2)


@pytest.mark.parametrize(
    "change",
    [
        pytest.param(lambda s: s.set("id", str(uuid4())), id="other-run"),
        pytest.param(lambda s: s[0].set("name", str(uuid4())), id="other-case"),
        pytest.param(lambda s: s[0].set("name", s[1].get("name")), id="duplicate-case"),
        pytest.param(lambda s: s.set("failures", "1"), id="false-failure-count"),
        pytest.param(lambda s: s[0].set("name", "veriq-run-gate"), id="false-gate-case"),
        pytest.param(lambda s: SubElement(s[0], "skipped"), id="skipped-child"),
    ],
)
def test_ci_rejects_inconsistent_junit(tmp_path, change):
    """即使用例计数正确仍须核对每一项身份和执行结果，畸形或不一致的门禁报告保留原文件。"""
    report = _ci_report(_TRIGGER_RUN_ID, "PASSED", "PASSED")
    suite = fromstring(sanitized_junit(report))
    change(suite)
    _assert_ci_result(tmp_path, report["run"], report, tostring(suite), 2)


@pytest.mark.parametrize(
    "xml", [b"<testsuite", b'<?xml version="1.0" encoding="unknown"?><testsuite/>']
)
def test_ci_rejects_unreadable_junit(tmp_path, xml):
    """下载到的字节必须先解析成有效 XML 才可进入发布；编码或标记错误均须原样保留旧产物。"""
    report = _ci_report(_TRIGGER_RUN_ID, "PASSED")
    _assert_ci_result(tmp_path, report["run"], report, xml, 2)


def test_concurrent_junit_publications_use_independent_temporary_files(tmp_path, monkeypatch):
    """在两个下载都已暂存、均未发布时同步写入者，检查独立文件身份以及最终产物完整来自其中一次写入。"""
    output = tmp_path / "shared.xml"
    barrier = threading.Barrier(2, timeout=5)
    sources = []
    replace = os.replace

    def publish_together(source, destination):
        """等另一个发布者也在同一目录内准备好完整文件才继续替换，稳定复现共享临时路径会导致的竞争。"""
        sources.append(source)
        barrier.wait()
        replace(source, destination)

    monkeypatch.setattr(os, "replace", publish_together)
    reports = [sanitized_junit(_ci_report(str(uuid4()), "PASSED")) for _ in range(2)]
    client = Client("https://localhost", "test", time.monotonic() + 10)
    with ThreadPoolExecutor(max_workers=2) as pool:
        writes = [pool.submit(_publish_junit, client, output, fromstring(xml)) for xml in reports]
        for future in writes:
            future.result()
    assert len(set(sources)) == 2
    assert output.read_bytes() in reports
    assert list(tmp_path.iterdir()) == [output]


@pytest.mark.parametrize(
    "scenario", ["fast", "cumulative", "trickle", "status-trickle", "report-trickle", "retry"]
)
def test_ci_absolute_deadline_covers_terminal_download_and_trigger_retries(tmp_path, scenario):
    """真实 CLI 子进程必须共享触发重试、终态读取与报告下载的总预算，连续小块数据不能把套接字空闲超时变成无限续期；
    快速有效结果仍通过，超时则非零并只对已知运行执行单独有界的取消。
    """
    run_id = str(uuid4())
    report = _ci_report(run_id, "PASSED")
    stopped = threading.Event()
    requests = []
    trigger_keys = []

    class Handler(BaseHTTPRequestHandler):
        """本地协议服务按指定场景延迟多个成功响应或持续发送小块正文，精确暴露总时间与单次空闲超时的区别；
        所有秘密和运行标识都是隔离测试数据，不写入平台数据库或代替真实执行验收。
        """

        def log_message(self, format, *args):
            """临时 HTTP 服务不输出访问日志与路径，只把接收到的操作保存在测试内存供断言使用；实际 CLI
            的标准输出和错误仍捕获在失败信息中，避免使用静默异常处理掩盖产品失败。
            """
            return

        def respond(self, data, status=200, trickle=False):
            """可控延迟发生在服务响应阶段，正文分片间隔短于一秒以避免触发普通空闲超时；客户端达到总截止时间关闭连接时允
            许断管，该现象正是本测试需要观察的正常终止而非服务实现错误。
            """
            if scenario == "cumulative" and not self.path.endswith("/cancel"):
                stopped.wait(0.4)
            payload = data if isinstance(data, bytes) else json.dumps({"data": data}).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                if trickle:
                    for byte in payload:
                        if stopped.wait(0.05):
                            break
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                else:
                    self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_POST(self):
            """触发重试记录原始幂等键并在第一次返回可重试错误，第二次持续发送正文验证剩余预算不会重置；
            取消使用独立即时响应，因此测量不会被测试服务自身的取消延迟混淆。
            """
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append(self.path)
            if self.path.endswith("/cancel"):
                self.respond({})
                return
            trigger_keys.append(self.headers.get("Idempotency-Key"))
            if scenario == "retry" and len(trigger_keys) == 1:
                stopped.wait(0.65)
                self.respond({}, 503)
                return
            self.respond(
                {"runId": run_id, "decision": "ENQUEUED"},
                202,
                trickle=scenario == "retry",
            )

        def do_GET(self):
            """终态、摘要和 JUnit 都返回语义一致的真实协议形状，使失败只来自截止时间控制而不是无效响应；
            慢下载每隔极短间隔继续产生字节，因此仅设置套接字读取超时无法让这一场景及时结束。
            """
            requests.append(self.path)
            if self.path.endswith("/junit"):
                self.respond(
                    sanitized_junit(report),
                    trickle=scenario == "trickle",
                )
            elif self.path.endswith("/ci-report"):
                self.respond(
                    report,
                    trickle=scenario == "report-trickle",
                )
            else:
                self.respond(
                    report["run"],
                    trickle=scenario == "status-trickle",
                )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        started = time.monotonic()
        process = subprocess.run(
            [
                "python",
                "scripts/veriq_ci.py",
                "--server",
                f"http://127.0.0.1:{server.server_port}",
                "--workspace",
                str(uuid4()),
                "--plan",
                str(uuid4()),
                "--key",
                "same-deadline-key",
                "--timeout",
                "1",
                "--junit",
                str(tmp_path / "deadline.xml"),
            ],
            env={**os.environ, "VERIQ_CI_TOKEN": "synthetic-deadline-token"},
            capture_output=True,
            text=True,
            timeout=10,
        )
        elapsed = time.monotonic() - started
        assert process.returncode == (0 if scenario == "fast" else 2), (
            process.stdout + process.stderr
        )
        assert elapsed < 2, (scenario, elapsed, process.stdout, process.stderr)
        if scenario != "fast":
            assert "gate passed" not in process.stdout
            assert not (tmp_path / "deadline.xml").exists()
        if scenario in {"cumulative", "trickle", "status-trickle", "report-trickle"}:
            assert any(path.endswith("/cancel") for path in requests)
        if scenario == "retry":
            assert trigger_keys == ["same-deadline-key", "same-deadline-key"]
            assert not any(path.endswith("/cancel") for path in requests)
    finally:
        stopped.set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


@contextlib.contextmanager
def _status_listener(handler):
    """
    在独立回环端口逐个处理请求，退出时等待服务线程结束，让后续断言能观察已经排空的请求记录。
    """
    with http.server.HTTPServer(("127.0.0.1", 0), handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield server
        finally:
            server.shutdown()
            worker.join(timeout=2)
            assert not worker.is_alive()


@pytest.mark.parametrize(
    ("status", "attempts"), [(301, 1), (302, 1), (303, 1), (307, 1), (308, 1), (403, 1), (503, 3)]
)
def test_ci_retains_trigger_request_across_http_status_retries(tmp_path, status, attempts):
    """
    让真实脚本向回环服务触发计划，直接拒绝跳转和客户端错误，并用相同正文与幂等键重试服务端错误。
    """
    trigger_requests = []
    redirect_requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        """
        两个来源共用同一个响应处理器，分别记录触发正文与改向访问，目标端口也接受独立的正向探测。
        """

        def log_message(self, format, *args):
            """
            访问记录保存在测试列表供断言，关闭默认日志可避免输出临时来源地址和夹具的完整请求路径。
            """
            # 日志回调的格式及参数仅用于默认输出，协议断言读取保存的请求事实，因此此处不使用这些入参。
            del format, args

        def _respond(self):
            """
            对触发请求保存原始字节与请求头并返回指定状态，另一个来源记录目标收到的 GET 和 POST 请求。
            """
            if self.server is redirect:
                redirect_requests.append((self.command, self.path))
                self.send_response(204)
            else:
                trigger_requests.append(
                    (
                        self.command,
                        self.path,
                        self.headers.get("Idempotency-Key"),
                        self.rfile.read(int(self.headers.get("Content-Length", "0"))),
                    )
                )
                self.send_response(status)
                if status < 400:
                    self.send_header(
                        "Location", f"http://127.0.0.1:{redirect.server_port}/redirect"
                    )
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = _respond
        do_POST = _respond

    workspace, plan, key = (str(uuid4()) for _ in range(3))
    token = "synthetic-http-status-token"
    with _status_listener(Handler) as redirect, _status_listener(Handler) as trigger:
        target = http.client.HTTPConnection("127.0.0.1", redirect.server_port, timeout=2)
        try:
            target.request("GET", "/positive")
            with target.getresponse() as response:
                assert response.status == 204
        finally:
            target.close()
        process = subprocess.run(
            [
                sys.executable,
                "scripts/veriq_ci.py",
                "--server",
                f"http://127.0.0.1:{trigger.server_port}",
                "--workspace",
                workspace,
                "--plan",
                plan,
                "--key",
                key,
                "--build-sha",
                "f" * 40,
                "--junit",
                str(tmp_path / "rejected.xml"),
            ],
            env={**os.environ, "VERIQ_CI_TOKEN": token, "no_proxy": "127.0.0.1"},
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    assert redirect_requests == [("GET", "/positive")]
    assert process.returncode == 2
    assert token not in process.stderr
    assert process.stderr == f"VeriQ HTTP request failed ({status}); gate failed\n"
    assert not (tmp_path / "rejected.xml").exists()
    assert (
        trigger_requests
        == [
            (
                "POST",
                f"/api/v1/workspaces/{workspace}/execution-plans/{plan}/trigger",
                key,
                b'{"buildSha": "' + b"f" * 40 + b'"}',
            )
        ]
        * attempts
    )
