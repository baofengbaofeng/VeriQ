"""VeriQ controlled demo business + fixture HTTP service (SQLite persistence).

Run using the service Python environment. All tokens must be supplied externally.
No internal scheduler: external callers invoke authenticated /maintenance.
"""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
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
            if row["request_hash"] != digest or row["state"] != "OPEN":
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
                # A close tombstone prevents a delayed prepare from reopening this namespace.
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


class Handler(RequestHandler):
    def initialize(self, store, business_token, fixture_token, maintenance_token):
        self.store = store
        self.tokens = {
            "editor": business_token,
            "fixture-service": fixture_token,
            "maintenance": maintenance_token,
        }

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
        """Business validation extension point; committing rechecks namespace atomically."""
        if not isinstance(name, str) or not 1 <= len(name) <= 160:
            raise HTTPError(400)

    async def get(self):
        path = self.request.path
        if path == "/":
            self.set_header("Content-Type", "text/html")
            self.finish("""<!doctype html><title>VeriQ demo</title><label>Name<input data-testid="name"></label><button data-testid="save">Save</button><div data-testid="result"></div><script>
            document.querySelector('button').onclick=async()=>{const response=await fetch('/employees',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:new URL(location.href).searchParams.get('namespace'),name:document.querySelector('input').value})});const result=await response.json();document.querySelector('[data-testid=result]').textContent=result.status||result.code;};</script>""")
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
            rows = self.store.db.execute(
                "SELECT id,name FROM employees WHERE namespace=?",
                (self.get_query_argument("namespace"),),
            ).fetchall()
            self.finish({"items": [dict(r) for r in rows]})
        else:
            raise HTTPError(404)

    async def post(self):
        data = self.body()
        path = self.request.path
        if path == "/login":
            token = data.get("token", "")
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
            if any(
                not isinstance(data.get(k), str) or not data[k]
                for k in ["workspaceId", "caseExecutionId", "namespace", "idempotencyKey"]
            ):
                raise HTTPError(400)
            expected = f"{data['workspaceId']}:{data['caseExecutionId']}:{data.get('attemptNo')}"
            if data["idempotencyKey"] != expected or data.get("attemptNo") not in (1, 2):
                raise HTTPError(400)
            if path == "/prepare":
                if (
                    not isinstance(data.get("input"), dict)
                    or set(data["input"]) != {"name"}
                    or not isinstance(data["input"]["name"], str)
                    or not isinstance(data.get("ttlSeconds"), int)
                    or not 1 <= data["ttlSeconds"] <= 604800
                ):
                    raise HTTPError(400)
                self.finish(self.store.prepare(data))
            else:
                self.finish(
                    self.store.cleanup(
                        data["idempotencyKey"], data["namespace"], data.get("cleanupToken")
                    )
                )
        elif path == "/employees":
            self.require("editor")
            await self.validate_employee(data.get("name"))
            self.finish(self.store.create_employee(data.get("namespace"), data["name"]))
        elif path == "/maintenance":
            self.require("maintenance")
            limit = data.get("limit", 100)
            if not isinstance(limit, int) or not 1 <= limit <= 100:
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


def application(store, business_token, fixture_token, maintenance_token, handler=Handler):
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
                ),
            )
        ]
    )


async def main():
    store = Store(os.environ["VERIQ_DEMO_DATABASE"])
    app = application(
        store,
        os.environ["VERIQ_DEMO_BUSINESS_TOKEN"],
        os.environ["VERIQ_DEMO_FIXTURE_TOKEN"],
        os.environ["VERIQ_DEMO_MAINTENANCE_TOKEN"],
    )
    app.listen(int(os.environ.get("VERIQ_DEMO_PORT", "8090")), address="127.0.0.1")
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
