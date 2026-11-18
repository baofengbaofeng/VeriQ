"""真实恢复协议使用专用测试数据库与既有服务夹具验证普通登录和账户权限契约，独立节点进程只接收本例创建的测试凭据。

测试通过公开接口创建备用管理员并降权原账户，再调用网页测试的实际恢复辅助函数；不启动浏览器，不改生产接口或数据库权限。
"""

import asyncio
import json
import pathlib

import httpx

from veriq_server import db, validation


async def _recover_by_node(options: dict[str, str]) -> None:
    """通过有界子进程执行网页真实恢复辅助函数，凭据只经过标准输入管道，所有失败输出均限制为预先定义的固定诊断。

    超时和取消都进入同一回收路径；节点进程使用锁定依赖，既不启动浏览器，也不读取专用测试数据库连接配置。
    """
    # 固定脚本只导入仓库实际辅助函数，认证参数从标准输入读取；异常原文不写入子进程输出，防止未来底层错误携带凭据。
    script = """
import { restoreTestAdmin } from './apps/web/tests/support/restore-test-admin.ts';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
    await restoreTestAdmin(JSON.parse(input));
    process.stdout.write('RECOVERY_OK');
} catch {
    process.stderr.write('RECOVERY_FAILED');
    process.exitCode = 1;
}
"""
    root = pathlib.Path(__file__).resolve().parents[4]
    process = await asyncio.create_subprocess_exec(
        "node",
        "--import",
        "./apps/web/node_modules/tsx/dist/loader.mjs",
        "--input-type=module",
        "--eval",
        script,
        cwd=root,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(25):
            stdout, stderr = await process.communicate(json.dumps(options).encode())
    finally:
        if process.returncode is None:
            process.kill()
            await asyncio.wait_for(process.wait(), timeout=5)
    if process.returncode != 0:
        assert stdout == b"" and stderr == b"RECOVERY_FAILED", "Unexpected recovery child failure"
    assert process.returncode == 0, "Recovery child failed"
    assert stdout == b"RECOVERY_OK" and stderr == b"", "Unexpected recovery child output"


async def test_web_recovery_uses_real_login_and_account_contract(
    site: tuple[httpx.AsyncClient, db.Database],
) -> None:
    """在真实登录用户不含管理员字段的前提下恢复已知目标，并验证原客户端会话仍属于同一账户，避免合成响应误导恢复结果。

    子进程参数不携带认证正文，输入只经管道传递；超时或取消后终止并回收子进程，失败诊断只使用固定英文消息。
    """
    client = site[0]
    password = "Recovery fixture password 123!"
    owner_email = "recovery-owner@example.test"
    backup_email = "recovery-backup@example.test"
    setup = await client.post(
        "/api/v1/setup",
        json={
            "installationSecret": "operator-secret",
            "email": owner_email,
            "displayName": "Recovery owner",
            "password": password,
        },
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"email": owner_email, "password": password}
    )
    assert login.status_code == 200
    session = login.json()["data"]
    validation.validate_api("SessionDTO", session)
    assert "systemAdmin" not in session["user"]
    assert session["user"]["disabled"] is False
    owner_id = session["user"]["id"]
    client.headers["X-CSRF-Token"] = session["csrfToken"]
    original_cookie = client.cookies.get("veriq_session")
    backup = await client.post(
        "/api/v1/admin/users",
        json={
            "email": backup_email,
            "displayName": "Recovery backup",
            "password": password,
            "systemAdmin": True,
        },
    )
    assert backup.status_code == 201
    assert backup.json()["data"]["systemAdmin"] is True
    demotion = await client.patch(f"/api/v1/admin/users/{owner_id}", json={"systemAdmin": False})
    assert demotion.status_code == 200
    assert demotion.json()["data"]["systemAdmin"] is False
    denied = await client.get("/api/v1/admin/users")
    assert denied.status_code == 403

    await _recover_by_node(
        {
            "origin": str(client.base_url).rstrip("/"),
            "targetId": owner_id,
            "targetEmail": owner_email,
            "backupEmail": backup_email,
            "backupPassword": password,
        }
    )
    account = await client.get("/api/v1/account")
    assert account.status_code == 200
    restored = account.json()["data"]
    validation.validate_api("AdminUserDTO", restored)
    assert restored["id"] == owner_id
    assert restored["email"] == owner_email
    assert restored["disabled"] is False
    assert restored["systemAdmin"] is True
    assert bool(client.cookies.get("veriq_session") == original_cookie)
    assert (await client.get("/api/v1/admin/users")).status_code == 200
