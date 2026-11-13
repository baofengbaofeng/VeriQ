import httpx
from sqlalchemy import select

from veriq_server.db import User, UserToken
from veriq_server.service import digest
from veriq_server.validation import validate_api


async def setup(c):
    return await c.post(
        "/api/v1/setup",
        json={
            "installationSecret": "operator-secret",
            "email": "admin@example.com",
            "displayName": "Administrator",
            "password": "Long password 123!",
        },
    )


async def login(c, email="admin@example.com", password="Long password 123!"):
    r = await c.post("/api/v1/auth/login", json={"email": email, "password": password})
    if r.status_code == 200:
        c.headers["X-CSRF-Token"] = r.json()["data"]["csrfToken"]
    return r


async def test_setup_guard_and_session_security(site):
    c, db = site
    bad = await c.post(
        "/api/v1/setup",
        json={
            "installationSecret": "wrong",
            "email": "a@example.com",
            "displayName": "A",
            "password": "Long password 123!",
        },
    )
    assert bad.status_code == 403
    import asyncio

    results = await asyncio.gather(setup(c), setup(c))
    assert sorted(r.status_code for r in results) == [201, 409]
    async with db.sessions() as s:
        user = (await s.execute(select(User))).scalar_one()
        assert user.password_hash.startswith("$argon2id$")
        assert "Long password" not in user.password_hash
    wrong = await login(c, password="bad")
    absent = await login(c, email="missing@example.com")
    assert wrong.status_code == absent.status_code == 401
    assert wrong.json()["message"] == absent.json()["message"]
    r = await login(c)
    assert r.status_code == 200

    validate_api("SessionDTO", r.json()["data"])
    assert "HttpOnly" in r.headers["set-cookie"] and "SameSite=Strict" in r.headers["set-cookie"]
    token = c.headers.pop("X-CSRF-Token")
    assert (await c.post("/api/v1/auth/logout", json={})).status_code == 403
    c.headers["X-CSRF-Token"] = token
    assert (await c.post("/api/v1/auth/logout", json={})).status_code == 200
    assert (await c.get("/api/v1/auth/session")).status_code == 401


async def test_admin_reset_disable_and_last_admin(site):
    c, db = site
    await setup(c)
    await login(c)
    assert (
        await c.patch(
            "/api/v1/admin/users/"
            + (await c.get("/api/v1/auth/session")).json()["data"]["user"]["id"],
            json={"disabled": True},
        )
    ).status_code == 409
    r = await c.post(
        "/api/v1/admin/users",
        json={
            "email": "user@example.com",
            "displayName": "User",
            "password": "Long password 123!",
            "systemAdmin": False,
        },
    )
    assert r.status_code == 201
    uid = r.json()["data"]["id"]
    link = await c.post(f"/api/v1/admin/users/{uid}/reset-link", json={})
    assert link.status_code == 200
    token = link.json()["data"]["url"].split("token=")[1]
    async with db.sessions() as s:
        stored = (await s.execute(select(UserToken))).scalar_one()
        assert stored.token_hash == digest(token) and stored.token_hash != token
    assert (
        await c.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": token, "newPassword": "Changed password 123!"},
        )
    ).status_code == 200
    assert (
        await c.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": token, "newPassword": "Changed password 123!"},
        )
    ).status_code == 400
    await login(c, "user@example.com", "Changed password 123!")
    assert (await c.get("/api/v1/admin/users")).status_code == 403
    assert (
        await c.post("/api/v1/auth/password-reset", json={"email": "missing@example.com"})
    ).json()["data"] == {}
    assert (await c.post("/api/v1/auth/password-reset", json={"email": "user@example.com"})).json()[
        "data"
    ] == {}
    await login(c)
    await c.patch(f"/api/v1/admin/users/{uid}", json={"disabled": True})
    assert (await login(c, "user@example.com", "Changed password 123!")).status_code == 401
    assert (await c.get("/api/v1/unknown")).status_code == 404
    malformed = await c.post(
        "/api/v1/auth/login", content="{", headers={"Content-Type": "application/json"}
    )
    assert malformed.status_code == 400 and set(malformed.json()) == {
        "code",
        "message",
        "details",
        "requestId",
    }


async def test_expiry_revoke_password_origin_and_safe_errors(site):
    from datetime import timedelta
    from sqlalchemy import update
    from veriq_server.db import UserSession
    from veriq_server.service import now

    c, db = site
    await setup(c)
    await login(c)
    uid = (await c.get("/api/v1/account")).json()["data"]["id"]
    session_cookie = c.cookies.get("veriq_session")
    async with db.sessions.begin() as s:
        await s.execute(update(UserSession).values(expires_at=now() - timedelta(seconds=1)))
    assert (await c.get("/api/v1/auth/session")).status_code == 401
    await login(c)
    async with db.sessions() as s:
        stored = (
            await s.execute(
                select(UserSession).where(
                    UserSession.token_hash == digest(c.cookies.get("veriq_session"))
                )
            )
        ).scalar_one()
        assert stored.token_hash != session_cookie
    assert (
        await c.post("/api/v1/auth/logout", json={}, headers={"Origin": "https://attacker.example"})
    ).status_code == 403
    link = (await c.post(f"/api/v1/admin/users/{uid}/reset-link", json={})).json()["data"]["url"]
    reset_token = link.split("token=")[1]
    async with db.sessions.begin() as s:
        await s.execute(update(UserToken).values(expires_at=now() - timedelta(seconds=1)))
    assert (
        await c.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": reset_token, "newPassword": "New password 123!"},
        )
    ).status_code == 400
    assert (
        await c.post(
            "/api/v1/account/password",
            json={"currentPassword": "wrong", "newPassword": "New password 123!"},
        )
    ).status_code == 400
    assert (
        await c.post(
            "/api/v1/account/password",
            json={"currentPassword": "Long password 123!", "newPassword": "New password 123!"},
        )
    ).status_code == 200
    assert (await c.get("/api/v1/auth/session")).status_code == 401
    assert (await login(c)).status_code == 401
    assert (await login(c, password="New password 123!")).status_code == 200
    assert (await c.post("/api/v1/account/sessions/revoke", json={})).status_code == 200
    assert (await c.get("/api/v1/auth/session")).status_code == 401
    # App-level body limit preserves the JSON error envelope (below transport hard limit).
    oversized = await c.post(
        "/api/v1/auth/login", content="x" * 65537, headers={"Content-Type": "application/json"}
    )
    assert oversized.status_code == 413 and oversized.json()["code"] == "BODY_TOO_LARGE"


async def test_concurrent_last_admin_and_disabled_session(site):
    import asyncio

    c, db = site
    await setup(c)
    await login(c)
    admin1 = (await c.get("/api/v1/account")).json()["data"]["id"]
    admin2 = (
        await c.post(
            "/api/v1/admin/users",
            json={
                "email": "second@example.com",
                "displayName": "Second",
                "password": "Long password 123!",
                "systemAdmin": True,
            },
        )
    ).json()["data"]["id"]
    # Two clients representing distinct administrators race to disable themselves.
    async with httpx.AsyncClient(
        base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
    ) as other:
        state = await other.get("/api/v1/setup")
        other.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        await login(other, "second@example.com")
        results = await asyncio.gather(
            c.patch(f"/api/v1/admin/users/{admin1}", json={"disabled": True}),
            other.patch(f"/api/v1/admin/users/{admin2}", json={"disabled": True}),
        )
        assert sorted(r.status_code for r in results) == [200, 409]
        disabled_client = c if results[0].status_code == 200 else other
        assert (await disabled_client.get("/api/v1/auth/session")).status_code == 401
    async with db.sessions() as s:
        enabled = (
            (
                await s.execute(
                    select(User).where(User.system_admin.is_(True), User.disabled.is_(False))
                )
            )
            .scalars()
            .all()
        )
        assert len(enabled) == 1


async def test_reset_and_admin_revoke_invalidate_another_browser(site):
    c, db = site
    await setup(c)
    await login(c)
    uid = (
        await c.post(
            "/api/v1/admin/users",
            json={
                "email": "session-user@example.com",
                "displayName": "Session User",
                "password": "Long password 123!",
                "systemAdmin": False,
            },
        )
    ).json()["data"]["id"]
    async with httpx.AsyncClient(
        base_url=str(c.base_url), headers={"Origin": str(c.base_url).rstrip("/")}
    ) as other:
        state = await other.get("/api/v1/setup")
        other.headers["X-CSRF-Token"] = state.json()["data"]["csrfToken"]
        await login(other, "session-user@example.com")
        assert (await other.get("/api/v1/auth/session")).status_code == 200
        reset = (
            (await c.post(f"/api/v1/admin/users/{uid}/reset-link", json={}))
            .json()["data"]["url"]
            .split("token=")[1]
        )
        assert (
            await c.post(
                "/api/v1/auth/password-reset/confirm",
                json={"token": reset, "newPassword": "Changed password 123!"},
            )
        ).status_code == 200
        assert (await other.get("/api/v1/auth/session")).status_code == 401
        await login(other, "session-user@example.com", "Changed password 123!")
        assert (
            await c.post(f"/api/v1/admin/users/{uid}/sessions/revoke", json={})
        ).status_code == 200
        assert (await other.get("/api/v1/auth/session")).status_code == 401
        await login(other, "session-user@example.com", "Changed password 123!")
        assert (
            await c.patch(f"/api/v1/admin/users/{uid}", json={"disabled": True})
        ).status_code == 200
        assert (await other.get("/api/v1/auth/session")).status_code == 401


async def test_production_cookie_and_database_shape(site, static_package):
    """生产 Cookie 检查继续使用真实数据库并提供有效包内静态库存，同时验证已有会话与深链接在同一应用协作；顶层健康别名遵守标准 DTO，而历史探针和数据库结构断言保持原有兼容。

    该客户端用 HTTP 替代外部 TLS 终结，所以显式传 Cookie 验证服务端会话。
    真正浏览器的 Secure Cookie 保存与发送由后面的 HTTPS 集成承担。
    计划页带查询参数刷新，仍必须返回 index 与 no-cache。
    缺少 CSRF 的登录不能因静态装配而放行。
    合法登录的会话应可读取真实账户邮箱。
    带有效 CSRF 但错误 Origin 的退出仍须拒绝。
    生产会话 Cookie 保留 Secure、HttpOnly 与 SameSite=Strict。
    canonical readiness 成功只证明实际数据库连接可用。
    最后的版本、事务隔离、迁移和列约束仍逐项检查。
    """
    from veriq_server.app import make_app
    from veriq_server.settings import Settings
    from tornado.httpserver import HTTPServer
    from sqlalchemy import text

    c, db = site
    await setup(c)
    # 生产测试继续通过真实 MySQL 校验登录和会话，只将外部 TLS 终结替换为本地 HTTP 传输；包内静态 fixture 提供完整库存，绝不通过降级开发环境绕过正式启动门禁。
    config = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url="https://veriq.example.com",
        master_key="a" * 64,
        signing_key="b" * 64,
    )
    server = HTTPServer(make_app(config, db))
    server.listen(18891, "127.0.0.1")
    try:
        async with httpx.AsyncClient(
            base_url="http://127.0.0.1:18891", headers={"Origin": config.public_url}
        ) as other:
            state = await other.get("/api/v1/setup")
            assert "Secure" in state.headers["set-cookie"]
            ready = await other.get("/health/ready")
            assert ready.status_code == 200
            validate_api("HealthDTOEnvelope", ready.json())
            assert ready.json()["data"] == {"status": "ok", "checks": {"database": True}}
            assert (await other.get("/api/v1/health/ready")).json()["data"] == {"ready": True}
            page = await other.get("/execution-plans?workspace=test")
            assert page.status_code == 200
            assert page.content == (static_package / "index.html").read_bytes()
            assert page.headers["cache-control"] == "no-cache"
            denied = await other.post("/api/v1/auth/login", json={})
            assert denied.status_code == 403
            validate_api("ErrorEnvelope", denied.json())
            response = await other.post(
                "/api/v1/auth/login",
                json={"email": "admin@example.com", "password": "Long password 123!"},
                headers={
                    "Cookie": "_xsrf=" + state.cookies["_xsrf"],
                    "X-CSRF-Token": state.json()["data"]["csrfToken"],
                },
            )
            assert response.status_code == 200
            session = await other.get(
                "/api/v1/account",
                headers={"Cookie": "veriq_session=" + response.cookies["veriq_session"]},
            )
            assert session.status_code == 200
            assert session.json()["data"]["email"] == "admin@example.com"
            wrong_origin = await other.post(
                "/api/v1/auth/logout",
                json={},
                headers={
                    "Origin": "https://another.example.com",
                    "Cookie": "_xsrf="
                    + state.cookies["_xsrf"]
                    + "; veriq_session="
                    + response.cookies["veriq_session"],
                    "X-CSRF-Token": state.json()["data"]["csrfToken"],
                },
            )
            assert wrong_origin.status_code == 403
            assert wrong_origin.json()["code"] == "ORIGIN_FORBIDDEN"
            assert all(
                flag in response.headers["set-cookie"]
                for flag in ["Secure", "HttpOnly", "SameSite=Strict"]
            )
    finally:
        server.stop()
        await server.close_all_connections()
    async with db.sessions() as s:
        assert str((await s.execute(text("SELECT VERSION()"))).scalar()).startswith("8.4.13")
        assert (await s.execute(text("SELECT @@session.time_zone"))).scalar() == "+00:00"
        assert (
            await s.execute(text("SELECT @@transaction_isolation"))
        ).scalar() == "READ-COMMITTED"
        assert (
            await s.execute(text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar() == "0014_execution_plans"
        assert (
            await s.execute(
                text(
                    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='veriq_artifacts' AND COLUMN_NAME='content'"
                )
            )
        ).scalar() == "YES"
        assert (
            await s.execute(
                text(
                    "SELECT DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='veriq_attempts' AND COLUMN_NAME='finished_at'"
                )
            )
        ).scalar() == 6
        columns = (
            await s.execute(
                text(
                    "SELECT TABLE_NAME,COLUMN_NAME,DATETIME_PRECISION,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()"
                )
            )
        ).all()
        for table, column, precision, collation in columns:
            if column in {"id", "user_id"} and table != "veriq_installation":
                assert collation == "ascii_bin"
            if column in {"created_at", "expires_at"}:
                assert precision == 6


async def test_production_https_browser_uses_built_frontend(site, static_package, tmp_path):
    """实际 Vite 前端通过生产 HTTPS Tornado 完成浏览器登录与计划页刷新，不运行开发代理或替代鉴权；测试库存只在临时包目录生成，正式打包脚本和干净 wheel 安装仍由后续发行任务负责。

    现有 site fixture 负责专用数据库清理、迁移和初始化密钥。
    setup 创建真实管理员，浏览器随后通过正常登录获取会话。
    生产 Application 仍与开发 fixture 共享同一真实 Database。
    只有 package resources 定位边界被指向临时安装目录。
    前端必须先执行正常的 pnpm build。
    dist 缺失直接失败，不使用默认跳过或替代 HTML。
    将完整 dist 复制到临时包目录，包含 Vite 实际输出 worker。
    测试库存列出该目录中的全部普通文件。
    每个文件记录真实 SHA-256 与字节长度。
    Vite 模块图也属于完整库存。
    两个身份元数据后写入，排除自引用哈希。
    commit 与 buildId 明确为测试身份。
    此测试不证明正式 CI 的源版本真实性。
    证书使用已有 cryptography 生成临时 EC 密钥。
    SAN 只允许当前回环 IP，不创建外部域名凭证。
    有效期限定一小时，私钥仅写在 pytest 临时目录。
    私钥权限限制为当前用户可读写。
    TLS 由 Tornado HTTPServer 直接终结。
    不需要额外反向代理、Vite 进程或 Node 服务。
    监听使用随机端口，防止与 5173 开发源冲突。
    public_url 使用实际 HTTPS 监听源。
    浏览器因而必须按真实规则保存 Secure Cookie。
    Browser 驱动是测试子进程，控制服务本身仍是 Python。
    子进程连接同一 HTTPS 应用，负责可见表单和页面断言。
    不使用固定 sleep、重试到绿或强制点击。
    子进程退出码是最终成功依据。
    捕获输出只在失败时显示，合成账号之外没有私有配置参数。
    九十秒超时是整个浏览器测试上限，不改变产品请求逻辑。
    finally 始终关闭监听与仍存连接。
    数据库最终释放仍由现有 site fixture 管理。
    """
    import asyncio
    from datetime import datetime, timedelta, timezone
    import hashlib
    from ipaddress import ip_address
    import json
    from pathlib import Path
    import shutil
    import ssl

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    from tornado.httpserver import HTTPServer
    from tornado.netutil import bind_sockets
    from veriq_server import __version__
    from veriq_server.app import make_app
    from veriq_server.settings import Settings

    c, db = site
    await setup(c)
    # 当前测试必须使用真实构建输出而不是小型静态 fixture 的占位入口，先检查模块图再复制全部文件；若构建未执行应明确失败，不能自动调用发行流水线或默默跳过浏览器验收。
    # 复制目的地仅为此测试的 tmp_path 包目录。
    # 已有 source/static/dist 不会被创建或清理。
    built = Path("apps/web/dist")
    assert (built / ".vite/manifest.json").is_file(), (
        "Run pnpm --filter @veriq/web build before production browser tests"
    )
    shutil.rmtree(static_package)
    shutil.copytree(built, static_package)
    # 测试库存只为观察服务端完整性门禁准备输入，逐个文件读取精确内容并记录稳定的相对路径；正式库存 writer、阶段原子性和清理旧输出的发布职责仍由 T18 单独实现与验证。
    # 此时目录里只有 Vite 构建产物。
    # 两个身份文件尚不存在，因此不会进入自己的库存。
    inventory = {
        "schemaVersion": "1.0",
        "files": [
            {
                "path": path.relative_to(static_package).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "sizeBytes": path.stat().st_size,
            }
            for path in sorted(static_package.rglob("*"))
            if path.is_file()
        ],
    }
    raw = json.dumps(inventory).encode()
    (static_package / "static-manifest.json").write_bytes(raw)
    (static_package / "build-info.json").write_text(
        json.dumps(
            {
                "version": __version__,
                "commit": "f21e0d7648717534d77234f59808da36d5fefeae",
                "buildId": "t17-browser-fixture",
                "staticManifestHash": hashlib.sha256(raw).hexdigest(),
            }
        )
    )
    # 为真实 Secure Cookie 场景提供短期回环 TLS 证书，复用现有密码学依赖生成测试密钥；不通过改成 HTTP 或手工向浏览器塞 Cookie 来绕过生产会话的正常使用条件。
    # 浏览器只忽略这个临时证书的信任链错误。
    # 服务器端的 HTTPS public_url 和 Origin 校验仍然生效。
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(hours=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ip_address("127.0.0.1"))]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / "tls.crt", tmp_path / "tls.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)
    # 私钥写盘后设置最小文件权限，再交给标准 SSLContext 和 Tornado 使用；证书与监听都只存在于此次隔离测试，不注册任何系统 CA 或修改用户浏览器的全局信任配置。
    # SAN 绑定回环地址，避免域名解析依赖。
    # 不关闭 TLS 校验相关的产品配置项。
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert_path, key_path)
    # 在构造生产配置前先绑定随机套接字，保证 public_url 与浏览器访问的实际源完全一致；这让表单请求的 Origin 由浏览器自然产生，不需要在测试里重写或伪造成功登录头。
    # 服务沿用唯一 make_app 工厂。
    # 原有 API、静态适配和应用控制插槽都在同一实例内。
    sockets = bind_sockets(0, "127.0.0.1")
    origin = f"https://127.0.0.1:{sockets[0].getsockname()[1]}"
    config = Settings(
        database_url=db.engine.url.render_as_string(hide_password=False),
        public_url=origin,
        master_key="a" * 64,
        signing_key="b" * 64,
    )
    server = HTTPServer(make_app(config, db), ssl_options=tls)
    server.add_sockets(sockets)
    try:
        # Node 仅运行 Playwright 测试驱动，收到的唯一命令参数是本地 HTTPS 源；服务端已经由 Python 在当前事件循环运行，等待子进程期间继续处理真实页面与 API 请求。
        # stdout 与 stderr 合并捕获以便定位断言失败。
        # 不传递 test-env 内容、会话或密钥到命令行。
        process = await asyncio.create_subprocess_exec(
            "node",
            "apps/web/tests/production-static.mjs",
            origin,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout=90)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        # 子进程中的 UI、Cookie、缓存和 404 断言必须全部成功才接受测试，失败输出保留原文以便报告；测试不会因只看到登录成功而忽略后续刷新或安全门禁错误。
        # 标准输出中的固定英文成功句不是单独的通过依据。
        # returncode 检查覆盖浏览器启动失败与脚本异常。
        assert process.returncode == 0, output.decode()
    finally:
        server.stop()
        await server.close_all_connections()
