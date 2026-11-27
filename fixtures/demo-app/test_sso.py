"""使用独立回环 HTTPS 监听验证员工 Demo 真实跳转和身份边界，所有账号、证书及数据库只属于当前测试实例。"""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import importlib.util
from ipaddress import IPv4Address
import json
from pathlib import Path
import secrets
import ssl
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin
from urllib.request import (
    HTTPSHandler,
    HTTPCookieProcessor,
    HTTPRedirectHandler,
    Request,
    build_opener,
)
from uuid import uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from pydantic import SecretStr
import pytest
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets


class NoRedirect(HTTPRedirectHandler):
    """让客户端逐次观察业务入口、身份系统与回调响应；每一跳通过真实套接字，自动重定向不会略去独立断言。"""

    def redirect_request(self, *args, **kwargs):
        """回传重定向响应的状态和位置供测试判定，保留 Cookie 处理并交给每个场景明确选择下一跳。"""
        del args, kwargs


def _request(client, url, data=None, headers=None):
    request = Request(url, data=data, headers=headers or {})
    try:
        response = client.open(request, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        return response.code, response.headers, response.read()


def _certificate(directory):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "VeriQ test fixture")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(minutes=15))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("localhost"), x509.IPAddress(IPv4Address("127.0.0.1"))]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    public_path = directory / "certificate.pem"
    private_path = directory / "private.pem"
    public_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private_path.chmod(0o600)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(public_path, private_path)
    return context, ssl.create_default_context(cafile=public_path)


def _load_fixture():
    spec = importlib.util.spec_from_file_location(
        "veriq_employee_demo", Path(__file__).with_name("app.py")
    )
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    return fixture


# 两个独立监听及各自的应用在同一作用域收尾，保留明确命名的站点资源便于核对跨站测试没有混用连接或数据库。
@asynccontextmanager
async def _sites(directory, expiry_clock=None, *, sso=True):  # pylint: disable=too-many-locals  # 两站共同收尾
    demo = _load_fixture()
    server_context, client_context = _certificate(directory)
    app_sockets = bind_sockets(0, address="127.0.0.1")
    idp_sockets = bind_sockets(0, address="127.0.0.1")
    app_origin = f"https://localhost:{app_sockets[0].getsockname()[1]}"
    idp_origin = f"https://127.0.0.1:{idp_sockets[0].getsockname()[1]}"
    business, fixture, maintenance = (secrets.token_urlsafe(24) for _ in range(3))
    password = SecretStr(secrets.token_urlsafe(24))
    storage = demo.Store(directory / "employees.sqlite")
    if sso:
        configuration = demo.DemoSso(
            app_origin, idp_origin, "employee-demo", password.get_secret_value(), expiry_clock
        )
        business_app, idp_app = demo.sso_applications(
            storage, (business, fixture, maintenance), configuration
        )
    else:
        business_app = idp_app = demo.application(storage, business, fixture, maintenance)
    app_server = HTTPServer(business_app, ssl_options=server_context)
    idp_server = HTTPServer(idp_app, ssl_options=server_context)
    app_server.add_sockets(app_sockets)
    idp_server.add_sockets(idp_sockets)
    try:
        yield app_origin, idp_origin, password, business, fixture, client_context
    finally:
        app_server.stop()
        idp_server.stop()
        await asyncio.gather(app_server.close_all_connections(), idp_server.close_all_connections())
        storage.db.close()


def _client(cert_context):
    return build_opener(HTTPSHandler(context=cert_context), HTTPCookieProcessor(), NoRedirect())


async def _login(client, app_origin, idp_origin, password):
    status, head, _ = await asyncio.to_thread(_request, client, app_origin + "/")
    assert status == 302
    assert head["Location"].startswith(idp_origin + "/sso/sign-in?")
    state = head["Location"].split("state=", 1)[1]
    status, _, page = await asyncio.to_thread(_request, client, head["Location"])
    assert status == 200
    assert b"Username" in page and b"Password" in page and b"Sign in" in page
    status, head, _ = await asyncio.to_thread(
        _request,
        client,
        idp_origin + "/sso/login",
        urlencode(
            {"state": state, "username": "employee-demo", "password": password.get_secret_value()}
        ).encode(),
        {"Origin": idp_origin},
    )
    assert status == 303
    assert head["Location"].startswith(app_origin + "/sso/callback?")
    return head["Location"]


# 在同一真实业务事务流程中展示准备、回跳、身份与员工回读各自的响应，使失败可以定位到实际协议边界。
@pytest.mark.asyncio
async def test_fresh_sso_attempts_reach_employee_operations(
    tmp_path,
):  # pylint: disable=too-many-locals  # 分别核对两次登录与员工操作
    """两次独立 Cookie 容器都必须实际经过登录页和回调，业务页面、身份接口及持久化员工操作依赖真实登录结果。"""
    async with _sites(tmp_path) as (app, idp, password, _, fixture_token, cert_context):
        client = _client(cert_context)
        namespace = str(uuid4())
        identifiers = {
            "workspaceId": str(uuid4()),
            "caseExecutionId": str(uuid4()),
            "attemptNo": 1,
            "namespace": namespace,
        }
        identifiers["idempotencyKey"] = (
            f"{identifiers['workspaceId']}:{identifiers['caseExecutionId']}:1"
        )
        prepared = await asyncio.to_thread(
            _request,
            client,
            app + "/prepare",
            json.dumps(
                dict(identifiers, input={"name": "Employee SSO test"}, ttlSeconds=60)
            ).encode(),
            {"Authorization": "Bearer " + fixture_token, "Content-Type": "application/json"},
        )
        assert prepared[0] == 200
        for name in ("First employee", "Second employee"):
            fresh = _client(cert_context)
            assert (await asyncio.to_thread(_request, fresh, app + "/me"))[0] == 401
            callback = await _login(fresh, app, idp, password)
            status, head, _ = await asyncio.to_thread(_request, fresh, callback)
            assert status == 303
            assert head["Location"] == "/"
            cookie = head.get_all("Set-Cookie")[-1]
            assert "Secure" in cookie and "HttpOnly" in cookie and "Domain" not in cookie
            assert (await asyncio.to_thread(_request, fresh, urljoin(app, head["Location"])))[
                0
            ] == 200
            identity = await asyncio.to_thread(_request, fresh, app + "/me")
            assert identity[0] == 200 and json.loads(identity[2]) == {"id": "editor"}
            created = await asyncio.to_thread(
                _request,
                fresh,
                app + "/employees",
                json.dumps({"namespace": namespace, "name": name}).encode(),
                {"Content-Type": "application/json"},
            )
            assert created[0] == 200
        employees = await asyncio.to_thread(
            _request, fresh, app + f"/employees?namespace={namespace}"
        )
        assert {row["name"] for row in json.loads(employees[2])["items"]} == {
            "First employee",
            "Second employee",
        }


@pytest.mark.asyncio
async def test_callback_rejects_foreign_browser_replay_and_expiry(tmp_path):
    """回调必须使用发起认证的浏览器状态，复制到其它会话、重复调用或等待签发态过期均不能建立新的业务会话。"""
    tick = 100.0

    def clock():
        return tick

    async with _sites(tmp_path, clock) as (app, idp, password, _, _, cert_context):
        client, foreign = _client(cert_context), _client(cert_context)
        callback = await _login(client, app, idp, password)
        assert (await asyncio.to_thread(_request, foreign, callback))[0] == 403
        assert (await asyncio.to_thread(_request, client, callback))[0] == 303
        assert (await asyncio.to_thread(_request, client, callback))[0] == 403
        assert (await asyncio.to_thread(_request, foreign, app + "/me"))[0] == 401

        expired = _client(cert_context)
        callback = await _login(expired, app, idp, password)
        tick += 61
        assert (await asyncio.to_thread(_request, expired, callback))[0] == 403
        assert (await asyncio.to_thread(_request, expired, app + "/me"))[0] == 401


@pytest.mark.asyncio
async def test_idp_rejects_unexpected_origin_and_invalid_credentials(tmp_path):
    """即使已看到有效登录页，跨来源提交或密码校验失败也不能获得回跳授权，仍须同来源完成当前表单的认证。"""
    async with _sites(tmp_path) as (app, idp, password, _, _, cert_context):
        client = _client(cert_context)
        status, head, _ = await asyncio.to_thread(_request, client, app + "/")
        assert status == 302
        state = head["Location"].split("state=", 1)[1]
        for origin, secret, expected_status in (
            (app, password, 403),
            (idp, SecretStr(secrets.token_urlsafe(24)), 401),
        ):
            status, head, _ = await asyncio.to_thread(
                _request,
                client,
                idp + "/sso/login",
                urlencode(
                    {
                        "state": state,
                        "username": "employee-demo",
                        "password": secret.get_secret_value(),
                    }
                ).encode(),
                {"Origin": origin},
            )
            assert status == expected_status
            assert head["Location"] is None
            assert (await asyncio.to_thread(_request, client, app + "/me"))[0] == 401


@pytest.mark.asyncio
async def test_default_demo_preserves_legacy_authentication(tmp_path):
    """默认 Demo 继续直接展示业务页，原有 Bearer 身份和 HTTP_SESSION 登录仍可消费相同的真实身份接口。"""
    async with _sites(tmp_path, sso=False) as (app, _, _, business_token, _, cert_context):
        client = _client(cert_context)
        assert (await asyncio.to_thread(_request, client, app + "/"))[0] == 200
        assert (await asyncio.to_thread(_request, client, app + "/me"))[0] == 401
        bearer = await asyncio.to_thread(
            _request, client, app + "/me", None, {"Authorization": "Bearer " + business_token}
        )
        assert json.loads(bearer[2]) == {"id": "editor"}
        login = await asyncio.to_thread(
            _request,
            client,
            app + "/login",
            json.dumps({"token": business_token}).encode(),
            {"Content-Type": "application/json"},
        )
        assert login[0] == 200
        cookie = await asyncio.to_thread(_request, client, app + "/me")
        assert cookie[0] == 200 and json.loads(cookie[2]) == {"id": "editor"}
