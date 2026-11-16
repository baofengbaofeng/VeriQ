"""示例导入器仅通过员工会话与真实控制服务交互，所有写操作携带同源和 CSRF，拒绝重定向以防止 Cookie、口令或凭据在意外目标上继续发送。

Cookie 只保存在当前进程内存，不落入导入进度文件。
失败仅显示服务端稳定错误码，不输出正文、密码或认证头。
此客户端不调用设备回执或数据库接口，也不会代替受信 Runtime 编译。
"""

import http.cookiejar
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁止员工认证及凭据创建请求被重定向到另一地址，即便代理或配置返回同源重定向也明确失败，要求操作者修正实际公开服务地址后再重试导入。

    urllib 默认可能把原请求改为 GET，破坏写操作语义。
    返回 None 使调用路径转为受控 HTTP 错误而非追随跳转。
    """

    def redirect_request(self, req: Any, fp: Any, code: Any, msg: Any, headers: Any, newurl: Any) -> None:
        """所有重定向都留在当前失败路径，不构造第二个携带员工上下文的网络请求，错误信息由统一入口转换为固定诊断而不显示响应中的敏感正文。
        """
        return None


class Platform:
    """封装真实平台 JSON 信封与临时 Cookie 会话，调用者只能传入固定 API 前缀内的相对路径，避免把环境或示例资产中的任意地址当成控制平台请求执行。

    生产地址必须 HTTPS，HTTP 仅允许显式 loopback 开发。
    每次响应有体积上限，单次连接有超时，无隐式写入重试。
    员工 Cookie 与业务 fixture token 不属于同一认证协议。
    """

    def __init__(self, server: str) -> None:
        """校验平台公开 origin 并建立仅驻留内存的 CookieJar，路径、用户名和查询参数一律拒绝，保证 Origin 与后续请求始终使用同一授权目标。
        """
        parts = urllib.parse.urlsplit(server)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or parts.path not in {"", "/"}
            or parts.query
            or parts.fragment
            or (parts.scheme == "http" and parts.hostname not in {"127.0.0.1", "localhost", "::1"})
        ):
            raise ValueError("Server must be an HTTPS origin or loopback HTTP origin")
        self.server = server.rstrip("/")
        self.csrf: str | None = None
        self.client = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect()
        )

    def request(self, method: str, path: str, data: Any = None) -> Any:
        """发送有界 JSON 请求并解开真实平台信封；服务端拒绝、响应过大或非 JSON 均直接中止，禁止把 HTTP 接受或未知响应转换成导入成功记录。

        写请求携带当前 CSRF，登录后立即使用新返回值。
        网络异常不包含原始 URL、请求头或正文，便于安全共享诊断。
        未知写入结果由重新读取资源和进度恢复处理，不能盲目重发。
        """
        if not path.startswith("/api/v1/") or "#" in path:
            raise ValueError("Expected a platform API path")
        headers = {"Accept": "application/json", "Origin": self.server}
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.server + path, body, headers, method=method)
        try:
            with self.client.open(req, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError("Platform response exceeded limit")
                envelope = json.loads(raw)
        except urllib.error.HTTPError as exc:
            code = "HTTP_ERROR"
            try:
                candidate = json.loads(exc.read(65536)).get("code", "")
                if isinstance(candidate, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", candidate):
                    code = candidate
            except (ValueError, AttributeError):
                pass
            finally:
                exc.close()
            raise RuntimeError(f"Platform request failed: HTTP {exc.code} {code}") from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError("Platform connection failed; write acceptance may be unknown") from None
        if not isinstance(envelope, dict) or "data" not in envelope:
            raise RuntimeError("Invalid platform response envelope")
        result = envelope["data"]
        if isinstance(result, dict) and "csrfToken" in result:
            self.csrf = result["csrfToken"]
        return result

    def login(self, email: str, password: str) -> Any:
        """先读取安装态取得真实防伪 Cookie，再提交员工认证；本工具不自动初始化平台或提升用户权限，管理员和环境管理权限仍由现有平台服务判断。
        """
        setup = self.request("GET", "/api/v1/setup")
        if not setup["initialized"]:
            raise RuntimeError("Initialize VeriQ through the setup UI first")
        return self.request("POST", "/api/v1/auth/login", {"email": email, "password": password})

    def items(self, path: str) -> Iterator[dict[str, Any]]:
        """完整读取受服务端游标限制的列表，并将游标作为不透明参数编码后回传；不可只检查第一页后就把已有空间或资源误判成不存在并创建重复对象。
        """
        while True:
            page = self.request("GET", path)
            yield from page["items"]
            cursor = page.get("nextCursor")
            if not cursor:
                return
            parts = urllib.parse.urlsplit(path)
            query = dict(urllib.parse.parse_qsl(parts.query))
            query["cursor"] = cursor
            path = parts.path + "?" + urllib.parse.urlencode(query)
