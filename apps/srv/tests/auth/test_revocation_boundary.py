"""使用真实 HTTP 和事务证明本人撤销参与安装护栏，并且仅成功提交后才清除浏览器会话。"""

import asyncio

import pytest
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError

from veriq_server.handlers import account
from veriq_server.service import Problem, lock_installation
from test_auth import login, setup


async def test_revoke_own_waits_for_installation_boundary(site):
    """另一事务持有安装锁时本人撤销必须排队，释放后才提交撤销；旧凭据重新发送仍被拒绝，成功响应清除浏览器会话。"""
    client, db = site
    await setup(client)
    await login(client)
    original = client.cookies.get("veriq_session")
    attempted = asyncio.Event()

    def observe(statement, **_context):
        """只观察实际驱动开始执行的安装行锁查询，以等待信号确定请求已进入数据库护栏，不用固定睡眠猜测调度顺序。"""
        if "veriq_installation" in statement and "FOR UPDATE" in statement:
            attempted.set()

    async with db.sessions.begin() as writer:
        await lock_installation(writer)
        event.listen(db.engine.sync_engine, "before_cursor_execute", observe, named=True)
        request = asyncio.create_task(client.post("/api/v1/account/sessions/revoke", json={}))
        waiting = asyncio.create_task(attempted.wait())
        try:
            async with asyncio.timeout(5):
                done, _ = await asyncio.wait(
                    {request, waiting}, return_when=asyncio.FIRST_COMPLETED
                )
            assert request not in done, "Revocation bypassed the installation lock"
        finally:
            event.remove(db.engine.sync_engine, "before_cursor_execute", observe)
            waiting.cancel()
            await asyncio.gather(waiting, return_exceptions=True)
    response = await request
    assert response.status_code == 200
    assert 'veriq_session=""' in response.headers["set-cookie"]
    assert client.cookies.get("veriq_session") is None
    assert (
        await client.get("/api/v1/auth/session", headers={"Cookie": f"veriq_session={original}"})
    ).status_code == 401


@pytest.mark.parametrize("operation", ["password", "sessions/revoke"])
async def test_self_revocation_clears_cookie_only_after_commit(site, monkeypatch, operation):
    """注入事务内失败时保留原会话及 Cookie；成功提交时两个入口均撤销旧会话并清除 Cookie。"""
    client, _ = site
    await setup(client)
    await login(client)
    original = client.cookies.get("veriq_session")
    body = (
        {"currentPassword": "Long password 123!", "newPassword": "Changed password 123!"}
        if operation == "password"
        else {}
    )

    def reject_commit(_session):
        """在真正提交阶段拒绝事务，使测试能区分审计后提前清 Cookie 与提交后清 Cookie。"""
        raise Problem(409, "CONFLICT", "Transaction could not complete")

    original_audit = account.audit

    def audit_then_reject(session, *args):
        """审计正常加入同一事务，只为这次业务 Session 登记一次提交故障，不影响测试服务的其他事务。"""
        original_audit(session, *args)
        event.listen(session.sync_session, "before_commit", reject_commit, once=True)

    with monkeypatch.context() as injection:
        injection.setattr(account, "audit", audit_then_reject)
        failed = await client.post(f"/api/v1/account/{operation}", json=body)
    assert failed.status_code == 409
    assert "set-cookie" not in failed.headers
    assert client.cookies.get("veriq_session") == original
    assert (await client.get("/api/v1/auth/session")).status_code == 200
    successful = await client.post(f"/api/v1/account/{operation}", json=body)
    assert successful.status_code == 200
    assert 'veriq_session=""' in successful.headers["set-cookie"]
    assert client.cookies.get("veriq_session") is None
    assert (
        await client.get("/api/v1/auth/session", headers={"Cookie": f"veriq_session={original}"})
    ).status_code == 401


async def test_non_account_integrity_error_has_generic_private_response(site, monkeypatch):
    """非建号事务的完整性异常走真实错误处理器，只公开通用冲突，不含账户专用含义或底层私密文本。"""
    client, _ = site
    await setup(client)
    await login(client)

    def fail(*_args):
        """在真实业务事务内注入带合成私密标记的数据库完整性异常，验证公开错误映射不包含底层文本或账户专属含义。"""
        raise IntegrityError("SYNTHETIC_SQL_SECRET", {}, Exception("SYNTHETIC_DB_SECRET"))

    monkeypatch.setattr(account, "audit", fail)
    response = await client.post("/api/v1/account/sessions/revoke", json={})
    assert response.status_code == 409
    assert response.json()["code"] == "CONFLICT"
    assert response.json()["message"] == "Request conflicts with existing data"
    assert "SYNTHETIC" not in response.text
    assert (await client.get("/api/v1/auth/session")).status_code == 200
