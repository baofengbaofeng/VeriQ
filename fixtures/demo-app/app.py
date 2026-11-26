"""VeriQ 受控示例通过真实业务认证、SQLite 事务与独立夹具身份演示完整生命周期，数据仅写入显式配置的私有路径，
禁止连接生产业务数据库。

示例沿用控制服务已有的 Tornado 环境，不增加框架或依赖锁。令牌由外部环境注入，夹具准备与普通业务写入采用不同身份。
外部调用维护接口完成 TTL 补偿，进程内部不启动定时器。
"""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import ssl
import stat
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from tornado.web import Application, RequestHandler, HTTPError

_SSO_STATE_COOKIE = "__Host-veriq_sso_state"
_SSO_SESSION_COOKIE = "__Host-veriq_sso_session"
_SSO_ATTEMPT_TTL = 60
_SSO_SESSION_TTL = 1800
_SSO_RECORD_LIMIT = 1024
_SSO_PASSWORD_HASHER = PasswordHasher()


def _loopback_https_origin(origin):
    parts = urlsplit(origin)
    host = parts.hostname
    if not host or (host not in {"localhost", "127.0.0.1"} and not host.endswith(".localhost")):
        raise ValueError("Only loopback site names are allowed")
    if not parts.port or origin != f"https://{host}:{parts.port}":
        raise ValueError("Expected a canonical loopback HTTPS origin with explicit port")
    return parts


class DemoSso:
    """使用进程内一次性记录把本地应用的发起浏览器与身份站授权关联，两个站点之间不共享登录 Cookie 或浏览器配置。

    站点来源只在启动时确定，回调位置由业务站配置生成；登录表单输入只可用于证明该示例的合成测试身份。
    时间和容量限制适用于每种临时记录，退出实例后不恢复任何会话。
    """

    def __init__(self, app_origin, idp_origin, username, password, clock=None):
        """初始化两个真实回环来源和专用合成账号，保留密码哈希而非密码原文，后续比较时沿用成熟的验证实现。"""
        app = _loopback_https_origin(app_origin)
        idp = _loopback_https_origin(idp_origin)
        if app.hostname == idp.hostname or app.port == idp.port:
            raise ValueError("Application and IdP require distinct loopback hosts and ports")
        if not 1 <= len(username) <= 120 or not 24 <= len(password) <= 256:
            raise ValueError("Expected a dedicated synthetic login and a strong password")
        self.app_origin = app_origin
        self.idp_origin = idp_origin
        self.username = username
        self.password_hash = _SSO_PASSWORD_HASHER.hash(password)
        self.clock = clock if clock is not None else time.monotonic
        self.attempts = {}
        self.sessions = {}

    def _reserve(self, records):
        for token, record in tuple(records.items()):
            if record[0] <= self.clock():
                del records[token]
        if len(records) >= _SSO_RECORD_LIMIT:
            raise HTTPError(503)

    def start(self):
        """为当前业务入口分配不可预测的状态，浏览器收到的发起标记下次只能在本实例对应的短期记录中找到。"""
        self._reserve(self.attempts)
        state = secrets.token_urlsafe(32)
        self.attempts[state] = (self.clock() + _SSO_ATTEMPT_TTL, None)
        return state

    def pending(self, state):
        """只允许未签发授权码且仍在期内的状态进入登录表单，过期尝试或已经提交过的表单必须重新发起。"""
        record = self.attempts.get(state)
        if record is None or record[0] <= self.clock() or record[1] is not None:
            raise HTTPError(403)
        return record[0]

    def authorize(self, state, username, password):
        """身份站只有在表单仍待处理且账号密码验证通过时才签发回跳码，每个业务入口状态至多获发一个授权码。"""
        expires = self.pending(state)
        if username != self.username or not 1 <= len(password) <= 256:
            raise HTTPError(401)
        try:
            _SSO_PASSWORD_HASHER.verify(self.password_hash, password)
        except VerificationError:
            raise HTTPError(401) from None
        code = secrets.token_urlsafe(32)
        self.attempts[state] = (expires, code)
        return code

    def finish(self, state, code, browser_state):
        """业务回调同时核验发起 Cookie、一次性码和时限，成功前不建立会话，其他浏览器的错误提交也不会消耗记录。"""
        record = self.attempts.get(state)
        if (
            state != browser_state
            or record is None
            or record[0] <= self.clock()
            or record[1] != code
        ):
            raise HTTPError(403)
        self._reserve(self.sessions)
        del self.attempts[state]
        session = secrets.token_urlsafe(32)
        self.sessions[session] = (self.clock() + _SSO_SESSION_TTL,)
        return session

    def session_active(self, session):
        """仅把本实例签发且仍在有效期内的业务 Cookie 判为普通员工身份，应用 API 不读取或依赖身份站 Cookie。"""
        record = self.sessions.get(session)
        return record is not None and record[0] > self.clock()


def _ignore_sso_access_log(handler):
    # 本地两站跳转查询携带短期授权材料；停用框架默认访问摘要以免记录请求地址及其完整回跳参数。
    del handler


# Tornado 默认先收齐表单正文，该处理器没有使用流式接收装饰器，因而不会通过框架调用 data_received。
class DemoIdpHandler(RequestHandler):  # pylint: disable=abstract-method
    """独立身份站只展示一份同页登录表单和固定提交接口，回跳地址来自业务实例配置，不接收浏览器提供的目标。"""

    @property
    def sso(self):
        """从应用配置读取同一实例的短期记录，身份站处理器不持有员工数据库，不能直接建立应用的浏览器会话。"""
        return self.settings["sso"]

    def prepare(self):
        """在读取表单前核对请求到达登记的身份站 HTTPS 来源，拒绝不匹配的主机名或协议进入身份站处理路径。"""
        if f"{self.request.protocol}://{self.request.host}" != self.sso.idp_origin:
            raise HTTPError(403)
        self.set_header("Cache-Control", "no-store")
        self.set_header("Referrer-Policy", "same-origin")

    def get(self, path):
        """登录页只接受唯一、服务器已登记的待登录状态，验证后嵌入随机状态令牌以关联随后提交的账号密码。"""
        if path != "sign-in":
            raise HTTPError(405)
        states = self.get_query_arguments("state")
        if len(states) != 1:
            raise HTTPError(400)
        state = states[0]
        self.sso.pending(state)
        self.set_header("Content-Type", "text/html; charset=utf-8")
        self.finish(
            "<!doctype html><html lang='en'><title>Employee demo identity</title>"
            "<h1>Employee demo sign in</h1><form method='post' action='/sso/login'>"
            f"<input type='hidden' name='state' value='{state}'>"
            "<label>Username <input name='username' autocomplete='username' required></label>"
            "<label>Password <input name='password' type='password' autocomplete='current-password' required></label>"
            "<button type='submit'>Sign in</button></form></html>"
        )

    def post(self, path):
        """拒绝其它来源或重复表单字段，验证合成凭据后使用固定业务回调地址发起浏览器跳转，而非重送登录正文。"""
        if path != "login":
            raise HTTPError(405)
        if self.request.headers.get("Origin") != self.sso.idp_origin:
            raise HTTPError(403)
        arguments = self.request.body_arguments
        if set(arguments) != {"state", "username", "password"} or any(
            len(values) != 1 for values in arguments.values()
        ):
            raise HTTPError(400)
        state = self.get_body_argument("state")
        code = self.sso.authorize(
            state, self.get_body_argument("username"), self.get_body_argument("password")
        )
        self.redirect(
            self.sso.app_origin + "/sso/callback?" + urlencode({"state": state, "code": code}),
            status=303,
        )


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS fixtures (
          fixture_id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, namespace TEXT UNIQUE NOT NULL,
          request_hash TEXT NOT NULL, cleanup_token TEXT NOT NULL, state TEXT NOT NULL,
          expires REAL NOT NULL, variables TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS employees (
          id TEXT PRIMARY KEY, namespace TEXT NOT NULL, name TEXT NOT NULL);
        """)

    def prepare(self, data):
        digest = hashlib.sha256(
            json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        row = self.db.execute(
            "SELECT * FROM fixtures WHERE key=?", (data["idempotencyKey"],)
        ).fetchone()
        if row:
            if (
                row["request_hash"] != digest
                or row["state"] != "OPEN"
                or row["expires"] <= time.time()
            ):
                raise HTTPError(409)
            return self.context(row)
        fixture_id = str(uuid4())
        variables = {"code": "employee-" + fixture_id}
        try:
            self.db.execute(
                "INSERT INTO fixtures VALUES(?,?,?,?,?,?,?,?)",
                (
                    fixture_id,
                    data["idempotencyKey"],
                    data["namespace"],
                    digest,
                    secrets.token_urlsafe(32),
                    "OPEN",
                    time.time() + data["ttlSeconds"],
                    json.dumps(variables),
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPError(409) from None
        return self.context(
            self.db.execute("SELECT * FROM fixtures WHERE fixture_id=?", (fixture_id,)).fetchone()
        )

    @staticmethod
    def context(row):
        return {
            "fixtureId": row["fixture_id"],
            "namespace": row["namespace"],
            "cleanupToken": row["cleanup_token"],
            "variables": json.loads(row["variables"]),
        }

    def cleanup(self, key, namespace, token=None):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT * FROM fixtures WHERE key=? AND namespace=?", (key, namespace)
            ).fetchone()
            if row is None:
                # 清理先建立关闭墓碑，阻止尚未到达的准备请求重新打开这个命名空间；数据库唯一约束同时禁止其它幂等键取得既
                # 有命名空间的归属权，失败不提交事务。
                self.db.execute(
                    "INSERT INTO fixtures VALUES(?,?,?,?,?,?,?,?)",
                    (str(uuid4()), key, namespace, "closed", "", "CLOSED", time.time(), "{}"),
                )
                result = {"status": "ALREADY_CLEANED"}
            else:
                if token is not None and not hmac.compare_digest(str(token), row["cleanup_token"]):
                    raise HTTPError(403)
                self.db.execute("UPDATE fixtures SET state='CLOSED' WHERE key=?", (key,))
                self.db.execute("DELETE FROM employees WHERE namespace=?", (namespace,))
                result = {
                    "status": "ALREADY_CLEANED" if row["state"] == "CLOSED" else "CLEANED",
                    "fixtureId": row["fixture_id"],
                }
            self.db.execute("COMMIT")
            return result
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def create_employee(self, namespace, name):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT state,expires FROM fixtures WHERE namespace=?", (namespace,)
            ).fetchone()
            if row is None or row["state"] != "OPEN" or row["expires"] <= time.time():
                raise HTTPError(409)
            employee_id = str(uuid4())
            self.db.execute("INSERT INTO employees VALUES(?,?,?)", (employee_id, namespace, name))
            self.db.execute("COMMIT")
            return {"id": employee_id, "status": "CREATED"}
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def namespace_for_code(self, code):
        """把夹具公开输出的稳定业务代码解析为真实命名空间，保持既有严格输出 Schema 只含 code，并让可导入 DSL
        无需假设运行时存在隐藏变量。此查询不返回 cleanupToken，

        关闭的命名空间仍交由事务内的写入检查拒绝。

        """
        if not isinstance(code, str) or not code:
            raise HTTPError(400)
        rows = self.db.execute("SELECT namespace,variables FROM fixtures").fetchall()
        for row in rows:
            if json.loads(row["variables"]).get("code") == code:
                return row["namespace"]
        raise HTTPError(404)


class Handler(RequestHandler):
    def initialize(
        self, store, business_token, fixture_token, maintenance_token, build_sha="development"
    ):
        self.store = store
        self.tokens = {
            "editor": business_token,
            "fixture-service": fixture_token,
            "maintenance": maintenance_token,
        }
        self.build_sha = build_sha
        self.set_header("X-Request-Id", str(uuid4()))
        self.set_header("X-Build-Sha", build_sha)

    def set_default_headers(self):
        self.set_header("Cache-Control", "no-store")
        self.set_header("X-Content-Type-Options", "nosniff")

    def identity(self):
        token = self.request.headers.get("Authorization", "").removeprefix("Bearer ")
        cookie = self.get_cookie("demo_session")
        for identity, expected in self.tokens.items():
            if token and hmac.compare_digest(token, expected):
                return identity
            if cookie and hmac.compare_digest(
                cookie, hashlib.sha256(expected.encode()).hexdigest()
            ):
                return identity
        raise HTTPError(401)

    def require(self, expected):
        if self.identity() != expected:
            raise HTTPError(403)

    def body(self):
        try:
            value = json.loads(self.request.body)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, TypeError):
            raise HTTPError(400) from None

    def write_error(self, status_code, **kwargs):
        self.finish(
            {
                "code": {
                    409: "NAMESPACE_CLOSED_OR_CONFLICT",
                    403: "FORBIDDEN",
                    401: "UNAUTHORIZED",
                }.get(status_code, "INVALID_REQUEST")
            }
        )

    async def validate_employee(self, name):
        """业务名称在写入前执行正常类型和长度校验，子类可用于受控竞争测试阻塞请求，但真正提交时必须在同一事务重新检查命
        名空间，不能以先前的校验结果绕过清理围栏。

        """
        if not isinstance(name, str) or not 1 <= len(name) <= 160:
            raise HTTPError(400)

    async def get(self):
        path = self.request.path
        if path == "/":
            self.set_header("Content-Type", "text/html")
            self.finish(Path(__file__).with_name("index.html").read_text(encoding="utf-8"))
        elif path == "/demo.js":
            self.set_header("Content-Type", "application/javascript; charset=utf-8")
            self.finish(Path(__file__).with_name("demo.js").read_text(encoding="utf-8"))
        elif path == "/build-info":
            self.finish({"buildSha": self.build_sha})
        elif path == "/openapi.json":
            self.finish(
                json.loads(Path(__file__).with_name("openapi.json").read_text(encoding="utf-8"))
            )
        elif path == "/me":
            self.finish({"id": self.identity()})
        elif path == "/query":
            self.require("fixture-service")
            row = self.store.db.execute(
                "SELECT * FROM fixtures WHERE key=?", (self.get_query_argument("idempotencyKey"),)
            ).fetchone()
            if not row:
                raise HTTPError(404)
            self.finish(
                {
                    "fixtureId": row["fixture_id"],
                    "namespace": row["namespace"],
                    "state": row["state"],
                }
            )
        elif path == "/employees":
            self.require("editor")
            namespace = self.get_query_argument("namespace", None)
            if namespace is not None and self.get_query_argument("code", None) is not None:
                raise HTTPError(400)
            if namespace is not None and not namespace:
                raise HTTPError(400)
            if namespace is None:
                namespace = self.store.namespace_for_code(self.get_query_argument("code"))
            rows = self.store.db.execute(
                "SELECT id,name FROM employees WHERE namespace=?",
                (namespace,),
            ).fetchall()
            self.finish({"items": [dict(r) for r in rows]})
        else:
            raise HTTPError(404)

    async def post(self):
        data = self.body()
        path = self.request.path
        if path == "/login":
            token = data.get("token", "")
            if set(data) != {"token"}:
                raise HTTPError(400)
            if not isinstance(token, str) or token not in self.tokens.values():
                raise HTTPError(401)
            self.set_cookie(
                "demo_session",
                hashlib.sha256(token.encode()).hexdigest(),
                httponly=True,
                samesite="Strict",
                secure=self.request.protocol == "https",
            )
            self.finish({"status": "AUTHENTICATED"})
        elif path in {"/prepare", "/cleanup"}:
            self.require("fixture-service")
            allowed = {"workspaceId", "caseExecutionId", "attemptNo", "namespace", "idempotencyKey"}
            allowed |= {"input", "ttlSeconds"} if path == "/prepare" else {"cleanupToken"}
            if set(data) - allowed:
                raise HTTPError(400)
            if any(
                not isinstance(data.get(k), str) or not data[k]
                for k in ["workspaceId", "caseExecutionId", "namespace", "idempotencyKey"]
            ):
                raise HTTPError(400)
            expected = f"{data['workspaceId']}:{data['caseExecutionId']}:{data.get('attemptNo')}"
            if (
                data["idempotencyKey"] != expected
                or type(data.get("attemptNo")) is not int
                or data.get("attemptNo") not in (1, 2)
            ):
                raise HTTPError(400)
            if path == "/prepare":
                if (
                    not isinstance(data.get("input"), dict)
                    or set(data["input"]) != {"name"}
                    or not isinstance(data["input"]["name"], str)
                    or not data["input"]["name"]
                    or type(data.get("ttlSeconds")) is not int
                    or not 1 <= data["ttlSeconds"] <= 604800
                ):
                    raise HTTPError(400)
                self.finish(self.store.prepare(data))
            else:
                if "cleanupToken" in data and (
                    not isinstance(data["cleanupToken"], str) or not data["cleanupToken"]
                ):
                    raise HTTPError(400)
                self.finish(
                    self.store.cleanup(
                        data["idempotencyKey"], data["namespace"], data.get("cleanupToken")
                    )
                )
        elif path == "/employees":
            self.require("editor")
            if set(data) - {"namespace", "code", "name"} or ("namespace" in data) == (
                "code" in data
            ):
                raise HTTPError(400)
            await self.validate_employee(data.get("name"))
            namespace = data.get("namespace")
            if "namespace" in data and (not isinstance(namespace, str) or not namespace):
                raise HTTPError(400)
            if namespace is not None and data.get("code") is not None:
                raise HTTPError(400)
            if namespace is None:
                namespace = self.store.namespace_for_code(data.get("code"))
            self.finish(self.store.create_employee(namespace, data["name"]))
        elif path == "/maintenance":
            self.require("maintenance")
            if set(data) - {"limit"}:
                raise HTTPError(400)
            limit = data.get("limit", 100)
            if type(limit) is not int or not 1 <= limit <= 100:
                raise HTTPError(400)
            rows = self.store.db.execute(
                "SELECT key,namespace FROM fixtures WHERE state='OPEN' AND expires<=? ORDER BY expires LIMIT ?",
                (time.time(), limit + 1),
            ).fetchall()
            for row in rows[:limit]:
                self.store.cleanup(row["key"], row["namespace"])
            self.finish({"processed": min(limit, len(rows)), "hasMore": len(rows) > limit})
        else:
            raise HTTPError(404)

    async def delete(self):
        if self.request.path != "/cleanup":
            raise HTTPError(405)
        await self.post()


# 业务站仍使用 Tornado 默认的完整正文接收方式，流式 data_received 不参与这里处理的页面、回调和 API 请求。
class SsoEmployeeHandler(Handler):  # pylint: disable=abstract-method
    """仅在显式启用的业务站保护页面入口和处理回跳，员工接口与隔离夹具继续使用既有事务及角色权限规则。"""

    @property
    def sso(self):
        """从当前业务站应用配置提取本实例的短期授权记录，独立 HTTP 夹具和默认员工站不会共享该注册表。"""
        return self.settings["sso"]

    def prepare(self):
        """业务站在任何身份或业务操作之前核对 HTTPS 来源，拒绝同一监听端口收到的不匹配主机名和协议。"""
        if f"{self.request.protocol}://{self.request.host}" != self.sso.app_origin:
            raise HTTPError(403)

    def identity(self):
        """把有效的业务站会话映射到现有普通员工角色，夹具和维护身份仍由原有凭据授权规则分别判定。"""
        if self.sso.session_active(self.get_cookie(_SSO_SESSION_COOKIE)):
            return "editor"
        return super().identity()

    async def get(self):
        """未登录的业务页面请求发起新的登录往返，回调和正常业务路由分别处理，并保留独立身份接口的 401。"""
        path = self.request.path
        if path == "/sso/callback":
            self._sso_callback()
        elif path == "/" and not self.sso.session_active(self.get_cookie(_SSO_SESSION_COOKIE)):
            self._start_sso()
        else:
            await super().get()

    def _start_sso(self):
        # 入口只接受当前业务来源并设置不含域属性的安全 Cookie；浏览器前往身份站时不会把业务状态 Cookie 一同发送。
        state = self.sso.start()
        self.set_cookie(
            _SSO_STATE_COOKIE, state, path="/", secure=True, httponly=True, samesite="Lax"
        )
        self.redirect(self.sso.idp_origin + "/sso/sign-in?" + urlencode({"state": state}))

    def _sso_callback(self):
        # 完成回调后立刻重定向至无授权参数的业务页面，成功响应仅签发该业务来源专属的短期会话 Cookie。
        self.set_header("Referrer-Policy", "no-referrer")
        states = self.get_query_arguments("state")
        codes = self.get_query_arguments("code")
        if len(states) != 1 or len(codes) != 1:
            raise HTTPError(400)
        session = self.sso.finish(states[0], codes[0], self.get_cookie(_SSO_STATE_COOKIE))
        self.clear_cookie(_SSO_STATE_COOKIE, path="/", secure=True, httponly=True, samesite="Lax")
        self.set_cookie(
            _SSO_SESSION_COOKIE, session, path="/", secure=True, httponly=True, samesite="Lax"
        )
        self.redirect("/", status=303)


def application(
    store,
    business_token,
    fixture_token,
    maintenance_token,
    handler=Handler,
    build_sha="development",
):
    if len({business_token, fixture_token, maintenance_token}) != 3 or any(
        len(t) < 24 for t in [business_token, fixture_token, maintenance_token]
    ):
        raise ValueError("Three distinct strong tokens are required")
    return Application(
        [
            (
                r"/.*",
                handler,
                dict(
                    store=store,
                    business_token=business_token,
                    fixture_token=fixture_token,
                    maintenance_token=maintenance_token,
                    build_sha=build_sha,
                ),
            )
        ],
    )


def sso_applications(store, tokens, sso, *, build_sha="development"):
    """创建两个单独监听的员工业务和测试身份站应用，独立夹具仍沿用原有令牌和接口，二者仅共享当前次受控的授权记录。"""
    business = application(store, *tokens, handler=SsoEmployeeHandler, build_sha=build_sha)
    business.settings.update(sso=sso, log_function=_ignore_sso_access_log)
    idp = Application(
        [(r"/sso/(sign-in|login)", DemoIdpHandler)],
        sso=sso,
        log_function=_ignore_sso_access_log,
    )
    return business, idp


def _tls_context(certificate, private_key):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, private_key)
    return context


def _listen_sso(store, tokens, build_sha):
    app_origin = os.environ["VERIQ_DEMO_SSO_APP_ORIGIN"]
    idp_origin = os.environ["VERIQ_DEMO_SSO_IDP_ORIGIN"]
    cert = os.environ["VERIQ_DEMO_SSO_CERT"]
    key = os.environ["VERIQ_DEMO_SSO_KEY"]
    # 本地 SSO 的回环绑定固定在启动器内，两个端口从各自的 HTTPS 来源读取，证书可以按独立站点配置。
    app_context = _tls_context(cert, key)
    idp_context = _tls_context(
        os.environ.get("VERIQ_DEMO_SSO_IDP_CERT", cert),
        os.environ.get("VERIQ_DEMO_SSO_IDP_KEY", key),
    )
    password = os.environ["VERIQ_DEMO_SSO_PASSWORD"]
    if password in tokens:
        raise ValueError("SSO password must differ from every demo API token")
    sso = DemoSso(app_origin, idp_origin, os.environ["VERIQ_DEMO_SSO_USERNAME"], password)
    business, idp = sso_applications(store, tokens, sso, build_sha=build_sha)
    business.listen(urlsplit(app_origin).port, address="127.0.0.1", ssl_options=app_context)
    idp.listen(
        urlsplit(idp_origin).port, address="127.0.0.1", ssl_options=idp_context, max_body_size=8192
    )
    if fixture_port := os.environ.get("VERIQ_DEMO_SSO_FIXTURE_PORT"):
        # 仅本地隔离验收可额外绑定独立 HTTP 夹具来源；该监听不运行身份站，也不提供员工页面或员工数据接口。
        fixture = Application(
            [
                (
                    r"/(?:me|prepare|query|cleanup|maintenance|build-info)",
                    Handler,
                    {
                        "store": store,
                        "business_token": tokens[0],
                        "fixture_token": tokens[1],
                        "maintenance_token": tokens[2],
                        "build_sha": build_sha,
                    },
                )
            ]
        )
        fixture.listen(int(fixture_port), address="127.0.0.1")


async def main():
    """示例服务只使用操作者明确配置的私有数据路径并从秘密环境读取独立令牌，启动前拒绝符号链接或公开文件；
    网络监听显式配置，不自动接入真实生产业务系统。

    """
    database = Path(os.environ["VERIQ_DEMO_DATABASE"]).absolute()
    if database.parent.stat().st_mode & 0o022:
        raise ValueError("Database directory must not be writable by group or others")
    if database.exists() or database.is_symlink():
        info = database.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("Database must be a private regular file")
    os.umask(0o077)
    store = Store(database)
    tokens = (
        os.environ["VERIQ_DEMO_BUSINESS_TOKEN"],
        os.environ["VERIQ_DEMO_FIXTURE_TOKEN"],
        os.environ["VERIQ_DEMO_MAINTENANCE_TOKEN"],
    )
    build_sha = os.environ.get("VERIQ_DEMO_BUILD_SHA", "development")
    if any(name.startswith("VERIQ_DEMO_SSO_") for name in os.environ):
        _listen_sso(store, tokens, build_sha)
    else:
        app = application(store, *tokens, build_sha=build_sha)
        app.listen(
            int(os.environ.get("VERIQ_DEMO_PORT", "8090")),
            address=os.environ.get("VERIQ_DEMO_BIND", "127.0.0.1"),
        )
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
