"""VeriQ 受控示例通过真实业务认证、SQLite 事务与独立夹具身份演示完整生命周期，数据仅写入显式配置的私有路径，禁止连接生产业务数据库。

示例沿用控制服务已有的 Tornado 环境，不增加框架或依赖锁。
令牌由外部环境注入，夹具准备与普通业务写入采用不同身份。
外部调用维护接口完成 TTL 补偿，进程内部不启动定时器。
"""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import stat
import time
from pathlib import Path
from uuid import uuid4

from tornado.web import Application, RequestHandler, HTTPError
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets


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
            if row["request_hash"] != digest or row["state"] != "OPEN" or row["expires"] <= time.time():
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
                # 清理先建立关闭墓碑，阻止尚未到达的准备请求重新打开这个命名空间；数据库唯一约束同时禁止其它幂等键取得既有命名空间的归属权，失败不提交事务。
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
        """把夹具公开输出的稳定业务代码解析为真实命名空间，保持既有严格输出 Schema 只含 code，并让可导入 DSL 无需假设运行时存在隐藏变量。
        此查询不返回 cleanupToken，关闭的命名空间仍交由事务内的写入检查拒绝。
        """
        if not isinstance(code, str) or not code:
            raise HTTPError(400)
        rows = self.db.execute("SELECT namespace,variables FROM fixtures").fetchall()
        for row in rows:
            if json.loads(row["variables"]).get("code") == code:
                return row["namespace"]
        raise HTTPError(404)


class Handler(RequestHandler):
    def initialize(self, store, business_token, fixture_token, maintenance_token, build_sha="development"):
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
        """业务名称在写入前执行正常类型和长度校验，子类可用于受控竞争测试阻塞请求，但真正提交时必须在同一事务重新检查命名空间，不能以先前的校验结果绕过清理围栏。
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
            self.finish(json.loads(Path(__file__).with_name("openapi.json").read_text(encoding="utf-8")))
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
            if data["idempotencyKey"] != expected or type(data.get("attemptNo")) is not int or data.get(
                "attemptNo") not in (1, 2):
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
                if "cleanupToken" in data and (not isinstance(data["cleanupToken"], str) or not data["cleanupToken"]):
                    raise HTTPError(400)
                self.finish(
                    self.store.cleanup(
                        data["idempotencyKey"], data["namespace"], data.get("cleanupToken")
                    )
                )
        elif path == "/employees":
            self.require("editor")
            if set(data) - {"namespace", "code", "name"} or ("namespace" in data) == ("code" in data):
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


def application(store, business_token, fixture_token, maintenance_token, handler=Handler, build_sha="development"):
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
        ]
    )


async def main():
    """示例服务只使用操作者明确配置的私有数据路径并从秘密环境读取独立令牌，启动前拒绝符号链接或公开文件；网络监听显式配置，不自动接入真实生产业务系统。
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
    app = application(
        store,
        os.environ["VERIQ_DEMO_BUSINESS_TOKEN"],
        os.environ["VERIQ_DEMO_FIXTURE_TOKEN"],
        os.environ["VERIQ_DEMO_MAINTENANCE_TOKEN"],
        build_sha=os.environ.get("VERIQ_DEMO_BUILD_SHA", "development"),
    )
    app.listen(
        int(os.environ.get("VERIQ_DEMO_PORT", "8090")),
        address=os.environ.get("VERIQ_DEMO_BIND", "127.0.0.1"),
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
