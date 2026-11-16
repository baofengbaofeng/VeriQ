"""标准库 HTTP 示例使用真实 editor 与 fixture-service 身份演示准备、查询、业务写入、独立持久化读取和 finally 清理，任何阶段失败都不输出令牌或完整业务响应。

本脚本同时适用于仓库 Python 服务和 Java Spring Boot 示例。未知写入不自动重发；重新执行会创建新 Attempt 与 namespace。清理失败使整个命令失败，不把业务通过当成完整生命周期通过。
"""

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """业务与夹具令牌不得跟随重定向传往新目标，即使响应来自可信目标也先明确失败，由操作者核对部署地址及认证代理后再调用正确的固定接口地址。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """阻止 urllib 默认的跳转重写与隐式第二次请求，使未知写入状态保持可见，不把 POST 变成 GET 或把认证头发送到响应 Location 指定的其它主机。
        """
        return None


class Client:
    """固定业务 origin 并限制单次响应体及超时，令牌仅从环境在内存读取，错误使用固定英文消息；requestId 与 build SHA 必须由实际被测服务返回而非脚本伪造。
    """

    def __init__(self, origin, build_sha):
        """只允许 HTTPS 或本机 HTTP origin，拒绝路径、用户信息、查询和片段；云端与容器必须配置 Runtime 真正可达的 TLS 业务入口，不能把开发机 localhost 当成远端服务。
        """
        parts = urllib.parse.urlsplit(origin)
        if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username is not None \
            or parts.path not in {"", "/"} or parts.query or parts.fragment:
            raise RuntimeError("Provide a target origin without credentials or path")
        if parts.scheme == "http" and parts.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Use HTTPS outside loopback")
        self.origin = origin.rstrip("/")
        self.build_sha = build_sha
        self.http = urllib.request.build_opener(NoRedirect())

    def call(self, method, path, token, data=None, expected=200):
        """请求始终带指定角色的正常 Bearer 身份，状态码、请求关联和目标构建版本都必须匹配；拒绝任何超限、错误媒体内容或意外状态，不自动重试写操作。

        响应只返回给调用栈，不作为日志或文件原样保存。403 可作为明确权限反例，但与网络错误严格区分。所有读取都在固定 origin 内，调用路径由脚本固定构造。
        """
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        request = urllib.request.Request(self.origin + path, body, headers, method=method)
        try:
            response = self.http.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError("Connection failed; query business state before retrying writes") from None
        with response:
            if response.code != expected:
                raise RuntimeError("Unexpected fixture or business HTTP status")
            if not response.headers.get("X-Request-Id") or response.headers.get("X-Build-Sha") != self.build_sha:
                raise RuntimeError("Missing request correlation or mismatched target build SHA")
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise RuntimeError("Response exceeded limit")
            return json.loads(raw)


def lifecycle(client, workspace, probe):
    """使用全新执行标识和 namespace 创建合成员工，同一准备参数精确重放且变更参数必须冲突，普通业务身份执行写入后再独立查询数据库结果，并始终执行所有权绑定清理。

    cleanupToken 只留在此调用栈，绝不打印或加入普通变量。丢失准备响应时仍能按稳定信封发起服务身份补偿。所有失败都保留失败结论，finally 清理不会伪造通过结果。
    """
    business = os.environ["VERIQ_DEMO_BUSINESS_TOKEN"]
    fixture = os.environ["VERIQ_DEMO_FIXTURE_TOKEN"]
    execution = str(uuid4())
    envelope = {"workspaceId": workspace, "caseExecutionId": execution, "attemptNo": 1,
                "namespace": "veriq-example-" + execution,
                "idempotencyKey": f"{workspace}:{execution}:1"}
    prepared = None
    if client.call("GET", "/me", business)["id"] != "editor":
        raise RuntimeError("Business role mismatch")
    if client.call("GET", "/me", fixture)["id"] != "fixture-service":
        raise RuntimeError("Fixture role mismatch")
    try:
        prepare = {**envelope, "input": {"name": "VeriQ synthetic employee"}, "ttlSeconds": 300}
        prepared = client.call("POST", "/prepare", fixture, prepare)
        replay = client.call("POST", "/prepare", fixture, prepare)
        if replay != prepared:
            raise RuntimeError("Prepare replay changed its result")
        query = "/query?" + urllib.parse.urlencode({"idempotencyKey": envelope["idempotencyKey"]})
        if client.call("GET", query, fixture)["state"] != "OPEN":
            raise RuntimeError("Prepared fixture is not open")
        if probe:
            changed = {**prepare, "input": {"name": "Changed input"}}
            client.call("POST", "/prepare", fixture, changed, expected=409)
            client.call("POST", "/employees", fixture,
                        {"namespace": envelope["namespace"], "name": "Denied fixture role"}, expected=403)
            client.call("POST", "/prepare", business, prepare, expected=403)
        created = client.call("POST", "/employees", business,
                              {"code": prepared["variables"]["code"], "name": "VeriQ synthetic employee"})
        employees = client.call("GET", "/employees?" + urllib.parse.urlencode({"namespace": envelope["namespace"]}),
            business)
        if created["status"] != "CREATED" or employees["items"] != [{"id": created["id"],
            "name": "VeriQ synthetic employee"}]:
            raise RuntimeError("Persisted business result differs")
    finally:
        cleanup = dict(envelope)
        if prepared is not None:
            cleanup["cleanupToken"] = prepared["cleanupToken"]
        receipt = client.call("POST", "/cleanup", fixture, cleanup)
        if receipt["status"] not in {"CLEANED", "ALREADY_CLEANED"}:
            raise RuntimeError("Fixture cleanup failed")
        repeated = client.call("POST", "/cleanup", fixture, cleanup)
        if repeated["status"] != "ALREADY_CLEANED":
            raise RuntimeError("Cleanup replay is not idempotent")
    remaining = client.call("GET", "/employees?" + urllib.parse.urlencode({"namespace": envelope["namespace"]}),
        business)
    if remaining["items"]:
        raise RuntimeError("Owned employees survived cleanup")
    print("HTTP example completed with persisted read and idempotent cleanup")


def main():
    """提供无附加依赖的可运行接入入口，秘密只来自环境，命令参数仅含公开目标及 Workspace；probe-contract 会真正发送受控权限反例，应仅在独立示例环境执行。
    """
    parser = argparse.ArgumentParser(description="Exercise a controlled VeriQ HTTP fixture example")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--build-sha", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--probe-contract", action="store_true")
    args = parser.parse_args()
    lifecycle(Client(args.base_url, args.build_sha), args.workspace, args.probe_contract)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    except (ValueError, OSError, KeyError):
        raise SystemExit("HTTP example failed; check configuration without exposing secrets") from None
