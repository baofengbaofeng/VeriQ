"""CI 传输边界使用隔离本地 HTTP 服务模拟两次读取之间的门禁变化，验证客户端不会忽略最后下载的 JUnit 失败；该协议测试不代替真实服务账号、已发布套件和 Agent 的组合验收。"""

import json
import os
import subprocess
import threading
import time
import pytest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4


def test_ci_never_reports_success_when_last_junit_observes_a_failed_gate(tmp_path):
    """运行摘要返回通过之后当前授权可能被撤回，最后下载的安全 JUnit 会带失败门禁；客户端必须将这份更新事实纳入退出码，而不能只凭更早的 JSON 快照返回成功，即使业务终态仍为 PASSED。"""
    run_id = str(uuid4())

    class Handler(BaseHTTPRequestHandler):
        """隔离服务只产生固定安全协议事实来重现摘要与 JUnit 之间的状态变化，不保存或伪造平台数据库记录，也不运行测试业务；真实执行成功证据由独立 Agent 组合用例提供。"""

        def log_message(self, format, *args):
            """测试服务器关闭默认访问日志以免让临时地址与请求路径淹没失败诊断，断言只检查退出码和输出文件；这里不隐藏产品异常，标准客户端的 stdout 和 stderr 仍完整保留在测试失败信息中。"""
            return

        def do_POST(self):
            """触发响应仅发出符合协议的测试运行 UUID，让实际 CI 子进程进入轮询流程；测试不把此回执视为真实执行证明，唯一断言目标是随后出现失败 JUnit 时不能退出零这一传输边界。"""
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.send_response(202)
            self.end_headers()
            self.wfile.write(
                json.dumps({"data": {"runId": run_id, "decision": "ENQUEUED"}}).encode()
            )

        def do_GET(self):
            """状态和摘要先返回通过，但终态 XML 明确记录当前门禁失败，模拟令牌仍可读而设备凭证投递许可刚被撤回；不包含任何业务断言或秘密值，从而只检验客户端使用最新失败事实的规则。"""
            self.send_response(200)
            self.end_headers()
            if self.path.endswith("/junit"):
                self.wfile.write(
                    b'<testsuite tests="2" failures="1"><testcase name="gate"><failure type="AUTHORITY_REVOKED" /></testcase></testsuite>'
                )
            elif self.path.endswith("/ci-report"):
                self.wfile.write(
                    json.dumps(
                        {"data": {"gatePassed": True, "cases": [{"id": str(uuid4())}]}}
                    ).encode()
                )
            else:
                self.wfile.write(
                    json.dumps({"data": {"state": "FINISHED", "outcome": "PASSED"}}).encode()
                )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
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
                str(uuid4()),
                "--junit",
                str(tmp_path / "race.xml"),
            ],
            env={**os.environ, "VERIQ_CI_TOKEN": "synthetic-protocol-token"},
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert process.returncode == 1, process.stdout + process.stderr
        assert b'failures="1"' in (tmp_path / "race.xml").read_bytes()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


@pytest.mark.parametrize(
    "scenario", ["fast", "cumulative", "trickle", "status-trickle", "report-trickle", "retry"]
)
def test_ci_absolute_deadline_covers_terminal_download_and_trigger_retries(tmp_path, scenario):
    """真实 CLI 子进程必须共享触发重试、终态读取与报告下载的总预算，连续小块数据不能把套接字空闲超时变成无限续期；快速有效结果仍通过，超时则非零并只对已知运行执行单独有界的取消。"""
    run_id = str(uuid4())
    stopped = threading.Event()
    requests = []
    trigger_keys = []

    class Handler(BaseHTTPRequestHandler):
        """本地协议服务按指定场景延迟多个成功响应或持续发送小块正文，精确暴露总时间与单次空闲超时的区别；所有秘密和运行标识都是隔离测试数据，不写入平台数据库或代替真实执行验收。"""

        def log_message(self, format, *args):
            """临时 HTTP 服务不输出访问日志与路径，只把接收到的操作保存在测试内存供断言使用；实际 CLI 的标准输出和错误仍捕获在失败信息中，避免使用静默异常处理掩盖产品失败。"""
            return

        def respond(self, data, status=200, trickle=False):
            """可控延迟发生在服务响应阶段，正文分片间隔短于一秒以避免触发普通空闲超时；客户端达到总截止时间关闭连接时允许断管，该现象正是本测试需要观察的正常终止而非服务实现错误。"""
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
            """触发重试记录原始幂等键并在第一次返回可重试错误，第二次持续发送正文验证剩余预算不会重置；取消使用独立即时响应，因此测量不会被测试服务自身的取消延迟混淆。"""
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
            """终态、摘要和 JUnit 都返回语义一致的真实协议形状，使失败只来自截止时间控制而不是无效响应；慢下载每隔极短间隔继续产生字节，因此仅设置套接字读取超时无法让这一场景及时结束。"""
            requests.append(self.path)
            if self.path.endswith("/junit"):
                self.respond(
                    b'<testsuite tests="1" failures="0"><testcase name="case" /></testsuite>',
                    trickle=scenario == "trickle",
                )
            elif self.path.endswith("/ci-report"):
                self.respond(
                    {"gatePassed": True, "cases": [{"id": "case"}]},
                    trickle=scenario == "report-trickle",
                )
            else:
                self.respond(
                    {"state": "FINISHED", "outcome": "PASSED"},
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
