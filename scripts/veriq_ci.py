"""外部 CI 通过受限执行令牌触发一个固定计划并轮询权威结果，密钥只从环境变量读取；脚本使用标准 HTTP 客户端和服务端安全 JUnit，不解析业务证据或把 HTTP 接受状态当作门禁通过。"""

import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from xml.etree.ElementTree import fromstring, ParseError


class NoRedirect(HTTPRedirectHandler):
    """禁止自动跟随重定向以防受限令牌被代理或错误平台地址转发到其他来源，CI 只访问操作者配置的明确服务根地址；重定向属于配置错误并以非零退出，不携带凭证自动尝试新位置。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """所有重定向都返回拒绝结果，让标准 HTTP 栈抛出可控错误而不是把 Authorization 带到另一个地址；错误处理只打印状态码，不打印请求头、响应正文或可能包含敏感材料的服务 URL。"""
        return None


class Client:
    """薄 HTTP 客户端固定服务来源、每次请求超时和响应字节上限，Bearer 仅保存在内存；相同触发重试保留完全一致的正文和幂等键，网络错误不会导致生成新的运行请求。"""

    def __init__(self, server: str, token: str, timeout: float):
        """服务地址默认要求 HTTPS，仅允许回环地址使用 HTTP 供隔离开发验证，禁止内嵌凭证和查询参数；独立请求超时由剩余 CI 总预算限制，避免在服务不可用时无限等待或意外泄露令牌。"""
        parsed = urlsplit(server)
        if (
            parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
            or not parsed.hostname
        ):
            raise ValueError("Server must be an origin without credentials or query")
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        ):
            raise ValueError("HTTPS is required outside loopback development")
        self.server, self.token, self.timeout = server.rstrip("/"), token, timeout
        self.opener = build_opener(NoRedirect())

    def request(
        self, path: str, method: str = "GET", body=None, key: str | None = None, *, binary=False
    ):
        """路径由本脚本根据已验证 UUID 构造，不接收响应中的任意远端跳转地址；JSON 请求与安全 XML 下载共享限定响应大小，超出界限立即失败而不尝试把部分结果解释成完整成功报告。"""
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}
        if key:
            headers["Idempotency-Key"] = key
        request = Request(
            self.server + path,
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
            method=method,
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("Response exceeds CI limit")
        return data if binary else json.loads(data)["data"]


def main(argv=None) -> int:
    """触发、轮询和下载构成完整门禁流程，只有权威终态 PASSED 且当前和执行时门禁均通过才退出零；超时、取消、未知结果和认证丢失均非零，尽力取消不会覆盖原始失败或假称进程已停止。"""
    from uuid import UUID

    parser = argparse.ArgumentParser(description="Trigger a VeriQ plan and enforce its CI gate")
    parser.add_argument("--server", required=True)
    parser.add_argument("--workspace", type=lambda value: str(UUID(value)), required=True)
    parser.add_argument("--plan", type=lambda value: str(UUID(value)), required=True)
    parser.add_argument(
        "--key", required=True, help="Stable external invocation key; reuse on retry"
    )
    parser.add_argument("--build-sha")
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--poll-interval", type=float, default=2)
    parser.add_argument("--junit", type=Path, default=Path("veriq-junit.xml"))
    args = parser.parse_args(argv)
    token = os.environ.get("VERIQ_CI_TOKEN", "")
    if not token or not 1 <= args.timeout <= 86400 or not 0.1 <= args.poll_interval <= 60:
        print("A token and bounded timeout/poll interval are required", file=sys.stderr)
        return 2
    started = time.monotonic()
    run_path = None
    client = None
    body = {"buildSha": args.build_sha} if args.build_sha else {}
    try:
        client = Client(args.server, token, min(30, args.timeout))
        trigger_path = f"/api/v1/workspaces/{args.workspace}/execution-plans/{args.plan}/trigger"
        for attempt in range(3):
            try:
                receipt = client.request(trigger_path, "POST", body, args.key)
                break
            except (URLError, TimeoutError) as error:
                if isinstance(error, HTTPError) and error.code < 500:
                    raise
                if attempt == 2 or time.monotonic() - started >= args.timeout:
                    raise
        run_id = str(UUID(receipt["runId"]))
        run_path = f"/api/v1/workspaces/{args.workspace}/runs/{run_id}"
        print("VeriQ Run " + run_id)
        while True:
            remaining = args.timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError
            client.timeout = min(30, remaining)
            status = client.request(run_path)
            if status["state"] == "FINISHED":
                break
            time.sleep(min(args.poll_interval, remaining))
        report = client.request(run_path + "/ci-report")
        xml = client.request(run_path + "/junit", binary=True)
        args.junit.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.junit.with_suffix(args.junit.suffix + ".tmp")
        temporary.write_bytes(xml)
        temporary.replace(args.junit)
        # 安全 JUnit 是最后一次授权读取，必须纳入门禁判断；摘要与下载之间若发生凭证投递撤销，不能忽略刚收到的失败事实而使用更早的通过快照退出零。
        junit = fromstring(xml)
        passed = (
            status.get("outcome") == "PASSED"
            and report["gatePassed"]
            and bool(report["cases"])
            and junit.tag == "testsuite"
            and junit.get("failures") == "0"
            and junit.get("errors", "0") == "0"
            and junit.get("tests") == str(len(report["cases"]))
            and len(junit.findall("testcase")) == len(report["cases"])
            and not junit.findall(".//failure")
            and not junit.findall(".//error")
        )
        print("VeriQ gate " + ("passed" if passed else "failed"))
        return 0 if passed else 1
    except (KeyboardInterrupt, TimeoutError):
        if run_path and client:
            try:
                client.timeout = 10
                client.request(
                    run_path + "/cancel", "POST", {"reason": "CI interrupted or timed out"}
                )
            except (HTTPError, URLError, TimeoutError, ValueError, KeyError, TypeError, OSError):
                print("Cancellation could not be confirmed", file=sys.stderr)
        print("CI interrupted or timed out; gate failed", file=sys.stderr)
        return 2
    except HTTPError as error:
        print(f"VeriQ HTTP request failed ({error.code}); gate failed", file=sys.stderr)
        return 2
    except (URLError, OSError, ValueError, KeyError, TypeError, ParseError):
        print("VeriQ transport or response failed; gate failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
