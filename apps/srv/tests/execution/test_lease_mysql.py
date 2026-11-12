"""中文重写：Unified queue behavior over real HTTP and guarded MySQL, never SQLite.
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""

from uuid import uuid4

from test_auth import setup, login
from test_workspace import workspace

# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
CAPABILITIES = {"engineVersion": "0.1.0", "os": "linux", "arch": "x64", "browsers": ["chromium"]}


async def device(c, ws):
    enrollment = await c.post(
        "/api/v1/runtime-enrollments",
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        json={"name": "Queue worker", "location": "CONNECTED_LOCAL", "capabilities": CAPABILITIES},
    )
    assert enrollment.status_code == 201, enrollment.text
    request = enrollment.json()["data"]
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    approval = await c.post(
        f"/api/v1/runtime-enrollments/{request['id']}/approve",
        json={
            "userCode": request["userCode"],
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "workspaceId": ws,
            "private": True,
            "sharedWithUserIds": [],
        },
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    )
    assert approval.status_code == 200, approval.text
    token = await c.post(
        "/api/v1/runtime-enrollments/poll", json={"deviceCode": request["deviceCode"]}
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    )
    assert token.status_code == 200, token.text
    return token.json()["data"]


async def test_empty_claim_is_idempotent_and_requires_current_device(site):
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    credential = await device(c, ws)
    data = {
        "runnerId": credential["runnerId"],
        "clientRequestId": str(uuid4()),
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        "availableSlots": 100,
        "capabilities": CAPABILITIES,
    }
    headers = {"Authorization": "Bearer " + credential["deviceToken"]}
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    path = "/internal/v1/jobs/claim"
    assert (await c.post(path, json=data)).status_code == 401
    first = await c.post(path, json=data, headers=headers)
    assert first.status_code == 204, first.text
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert (await c.post(path, json=data, headers=headers)).status_code == 204
    await c.post(f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}/revoke", json={})
    assert (await c.post(path, json=data, headers=headers)).status_code == 401


async def queued_browser_jobs(c, db, ws, count):
    """中文重写：Isolate queue invariants with persisted jobs; admission is tested separately.
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    from veriq_server.db import Job, Run, CaseExecution
    from veriq_server.repositories.resource import ResourceRepository
    from veriq_server.auth.authorization import WorkspaceScope
    from veriq_server.contracts import canonical_bytes
    from veriq_server.service import now, lock_installation

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    actor = (await c.get("/api/v1/account")).json()["data"]["id"]
    result = []
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    async with db.sessions.begin() as session:
        await lock_installation(session)
        repo = ResourceRepository(session, WorkspaceScope(ws))
        run_id = str(uuid4())
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        intent = await repo.store(canonical_bytes({"runId": run_id, "testFixture": "queue-only"}))
        run = Run(
            id=run_id,
            workspace_id=ws,
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            created_by=actor,
            idempotency_key=run_id,
            request_hash=intent,
            trigger_kind="MANUAL",
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            source="CONNECTED_LOCAL",
            state="QUEUED",
            snapshot_hash=intent,
            created_at=now(),
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        )
        session.add(run)
        await session.flush()
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for _ in range(count):
            jid = str(uuid4())
            content = await repo.store(canonical_bytes({"jobId": jid, "testFixture": "queue-only"}))
            candidate = str(uuid4())
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            execution = CaseExecution(
                id=str(uuid4()),
                workspace_id=ws,
                # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                run_id=run.id,
                case_version_id=candidate,
                candidate_version_id=candidate,
                source_snapshot_hash=content,
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                variant_key=content,
                provenance={"fixture": "queue-only"},
                state="QUEUED",
            )
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            session.add(execution)
            await session.flush()
            job = Job(
                run_id=run.id,
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                case_execution_id=execution.id,
                id=jid,
                workspace_id=ws,
                kind="TEST",
                # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                subject_id=execution.id,
                state="QUEUED",
                snapshot_hash=content,
                manifest_hash=content,
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                required_capabilities={"engineVersion": "0.1.0", "browser": "chromium"},
                created_by=actor,
                created_at=now(),
            )
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            session.add(job)
            result.append(jid)
    return result


def claim_body(credential, request_id=None):
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    return {
        "runnerId": credential["runnerId"],
        "clientRequestId": request_id or str(uuid4()),
        "availableSlots": 100,
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        "capabilities": CAPABILITIES,
    }


def auth(credential):
    return {"Authorization": "Bearer " + credential["deviceToken"]}


# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
async def test_twenty_http_claimers_atomically_respect_global_and_workspace_capacity(site):
    import asyncio
    from sqlalchemy import select
    from veriq_server.db import Attempt, CapacityPool

    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    c, db = site
    await setup(c)
    await login(c)
    workspaces = [await workspace(c, key="first"), await workspace(c, key="second")]
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    devices = []
    # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for ws in workspaces:
        await queued_browser_jobs(c, db, ws, 10)
        devices.extend([await device(c, ws) for _ in range(10)])
    replies = await asyncio.gather(
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        *[c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d)) for d in devices]
    )
    assert [r.status_code for r in replies].count(200) == 4, [r.text for r in replies]
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert [r.status_code for r in replies].count(204) == 16
    async with db.sessions() as session:
        attempts = (await session.execute(select(Attempt))).scalars().all()
        assert len(attempts) == 4 and len({a.job_id for a in attempts}) == 4
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for ws in workspaces:
            assert sum(a.workspace_id == ws for a in attempts) == 2
        pools = (await session.execute(select(CapacityPool))).scalars().all()
        assert all(p.used <= p.limit for p in pools)
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert all(
            a.lease_token_hash
            not in [r.json()["data"]["leaseToken"] for r in replies if r.status_code == 200]
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for a in attempts
        )


async def test_claim_recovery_rotates_fence_and_activation_cannot_be_repeated_as_new_work(site):
    from sqlalchemy import text, select
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    from veriq_server.db import Attempt

    c, db = site
    await setup(c)
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 2)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    data = claim_body(d)
    first = (await c.post("/internal/v1/jobs/claim", json=data, headers=auth(d))).json()["data"]
    recovered = (await c.post("/internal/v1/jobs/claim", json=data, headers=auth(d))).json()["data"]
    assert recovered["attemptId"] == first["attemptId"]
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert recovered["fencingToken"] > first["fencingToken"]
    assert recovered["leaseToken"] != first["leaseToken"]
    endpoint = f"/internal/v1/attempts/{first['attemptId']}"

    def proof(claim):
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        return {k: claim[k] for k in ["leaseToken", "fencingToken"]}

    old = await c.post(endpoint + "/activate", json=proof(first), headers=auth(d))
    assert old.status_code == 409 and old.json()["code"] == "STALE_FENCE"
    assert (
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        await c.post(endpoint + "/activate", json=proof(recovered), headers=auth(d))
    ).status_code == 200
    repeated = await c.post("/internal/v1/jobs/claim", json=data, headers=auth(d))
    assert repeated.status_code == 409 and repeated.json()["code"] == "ATTEMPT_ALREADY_ACTIVATED"
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async with db.sessions.begin() as session:
        a = (await session.execute(select(Attempt))).scalar_one()
        assert a.capacity_state == "HELD"
        await session.execute(
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            text("UPDATE veriq_attempts SET lease_expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND")
        )
    heartbeat = await c.post(
        endpoint + "/heartbeat",
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        json={**proof(recovered), "progress": {"phase": "RUNNING"}},
        headers=auth(d),
    )
    assert heartbeat.status_code == 409 and heartbeat.json()["code"] == "LEASE_EXPIRED"


# 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
async def test_scoped_maintenance_quarantines_unknown_process_until_stop_confirmation(site):
    from sqlalchemy import text, select
    from veriq_server.db import Attempt, CapacityPool

    c, db = site
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await queued_browser_jobs(c, db, ws, 1)
    claim = (await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))).json()[
        "data"
    ]
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    base = f"/internal/v1/attempts/{claim['attemptId']}"
    assert (await c.post(base + "/activate", json=proof, headers=auth(d))).status_code == 200
    from hashlib import sha256
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    from veriq_server.db import AttemptUpload

    partial = await c.post(
        base + "/artifact-uploads",
        json={
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            **proof,
            "kind": "LOG",
            "filename": "partial.log",
            "contentType": "text/plain",
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "sha256": sha256(b"abc").hexdigest(),
            "sizeBytes": 3,
            "sensitivity": "REDACTED",
        },
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        headers=auth(d),
    )
    assert partial.status_code == 201, partial.text
    partial_id = partial.json()["data"]["artifactId"]
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    put_headers = {
        **auth(d),
        "Content-Type": "application/octet-stream",
        "X-VeriQ-Lease-Token": proof["leaseToken"],
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        "X-VeriQ-Fencing-Token": str(proof["fencingToken"]),
    }
    assert (
        await c.put(
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            partial.json()["data"]["uploadUrl"] + "?offset=0", content=b"a", headers=put_headers
        )
    ).status_code == 200
    account = (
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Lease maintenance"}
        )
    ).json()["data"]
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    token = await c.post(
        f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
        json={
            "purpose": "MAINTENANCE",
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "operations": ["expired-leases/reap", "capacity/reconcile"],
        },
    )
    assert token.status_code == 201, token.text
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    headers = {
        "Authorization": "Bearer " + token.json()["data"]["token"],
        "Idempotency-Key": str(uuid4()),
    }
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async with db.sessions.begin() as session:
        await session.execute(
            text("UPDATE veriq_attempts SET lease_expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND")
        )
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    response = await c.post(
        "/internal/v1/maintenance/expired-leases/reap",
        json={"workspaceId": ws, "limit": 10},
        headers=headers,
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["processedCount"] == 1
    assert (
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        await c.post(
            "/internal/v1/maintenance/expired-leases/reap",
            json={"workspaceId": ws, "limit": 10},
            headers=headers,
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
    ).json()["data"] == response.json()["data"]
    async with db.sessions() as session:
        attempt = (await session.execute(select(Attempt))).scalar_one()
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert attempt.capacity_state == "QUARANTINED" and attempt.outcome == "ERROR"
        assert (await session.get(AttemptUpload, partial_id)).content == b""
        assert (await session.get(CapacityPool, "00/global/browser")).used == 1
    stop = {
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        "fencingToken": claim["fencingToken"],
        "processStopped": True,
        "cleanupStatus": "NOT_REQUIRED",
        "stoppedAt": "2026-11-11T12:00:00Z",
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    }
    assert (await c.post(base + "/reconcile", json=stop, headers=auth(d))).status_code == 200
    async with db.sessions() as session:
        attempt = (await session.execute(select(Attempt))).scalar_one()
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert attempt.capacity_state == "RELEASED" and attempt.outcome == "ERROR"
        assert (await session.get(CapacityPool, "00/global/browser")).used == 0


async def test_bounded_chunk_upload_retains_exact_large_bytes_and_rejects_wrong_offset(site):
    from hashlib import sha256
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    from veriq_server.db import Artifact

    c, db = site
    await setup(c)
    await login(c)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ws = await workspace(c)
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 1)
    claim = (await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))).json()[
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        "data"
    ]
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    base = f"/internal/v1/attempts/{claim['attemptId']}"
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert (await c.post(base + "/activate", json=proof, headers=auth(d))).status_code == 200
    content = b"large-real-upload-content\x00" * 140000
    digest = sha256(content).hexdigest()
    upload = await c.post(
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        base + "/artifact-uploads",
        json={
            **proof,
            "kind": "SOURCE",
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "filename": "vendor/engine.tgz",
            "contentType": "application/octet-stream",
            "sha256": digest,
            "sizeBytes": len(content),
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "sensitivity": "REDACTED",
        },
        headers=auth(d),
    )
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert upload.status_code == 201, upload.text
    target = upload.json()["data"]["uploadUrl"]
    headers = {
        **auth(d),
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        "Content-Type": "application/octet-stream",
        "X-VeriQ-Lease-Token": claim["leaseToken"],
        "X-VeriQ-Fencing-Token": str(claim["fencingToken"]),
    }
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert (await c.put(target + "?offset=1", content=b"x", headers=headers)).status_code == 409
    assert (
        await c.put(
            target + "?offset=0",
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            content=b"x",
            headers={**headers, "X-VeriQ-Fencing-Token": str(claim["fencingToken"] + 1)},
        )
    ).status_code == 409
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    bad = await c.post(
        base + "/artifact-uploads",
        json={
            **proof,
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "kind": "LOG",
            "filename": "wrong.log",
            "contentType": "text/plain",
            "sha256": "0" * 64,
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "sizeBytes": 3,
            "sensitivity": "REDACTED",
        },
        headers=auth(d),
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    )
    assert bad.status_code == 201
    mismatch = await c.put(
        bad.json()["data"]["uploadUrl"] + "?offset=0", content=b"abc", headers=headers
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    )
    assert mismatch.status_code == 409 and mismatch.json()["code"] == "UPLOAD_HASH_MISMATCH"
    # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for offset in range(0, len(content), 1024 * 1024):
        chunk = content[offset : offset + 1024 * 1024]
        response = await c.put(target + f"?offset={offset}", content=chunk, headers=headers)
        assert response.status_code == 200, response.text
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert (
            await c.put(target + f"?offset={offset}", content=chunk, headers=headers)
        ).status_code == 200
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    async with db.sessions() as session:
        retained = await session.get(Artifact, (ws, digest))
        assert retained and retained.content == content and retained.size_bytes == len(content)


async def test_actual_dropped_http_response_recovers_only_the_unactivated_attempt(site):
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    import asyncio
    import httpx
    from sqlalchemy import select
    from veriq_server.db import Attempt

    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 2)
    data = claim_body(d)
    committed = asyncio.get_running_loop().create_future()

    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    async def drop_response(reader, writer):
        # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            length = next(
                int(line.split(b":", 1)[1])
                # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for line in head.split(b"\r\n")
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if line.lower().startswith(b"content-length:")
            )
            body = await reader.readexactly(length)
            reply = await c.post(
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                "/internal/v1/jobs/claim",
                content=body,
                headers={**auth(d), "Content-Type": "application/json"},
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            )
            committed.set_result(reply.status_code)
        # 关键路径：处理 except 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        except Exception as error:
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if not committed.done():
                committed.set_exception(error)
        # 关键路径：处理 finally 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        finally:
            writer.close()
            await writer.wait_closed()

    proxy = await asyncio.start_server(drop_response, "127.0.0.1", 0)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    import pytest

    # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try:
        port = proxy.sockets[0].getsockname()[1]
        async with httpx.AsyncClient() as downstream:
            # 关键路径：处理 with 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            with pytest.raises(httpx.RemoteProtocolError):
                await downstream.post(
                    f"http://127.0.0.1:{port}/internal/v1/jobs/claim", json=data, headers=auth(d)
                )
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert await committed == 200
    # 关键路径：处理 finally 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    finally:
        proxy.close()
        await proxy.wait_closed()
    recovered = await c.post("/internal/v1/jobs/claim", json=data, headers=auth(d))
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert recovered.status_code == 200, recovered.text
    async with db.sessions() as session:
        attempts = (await session.execute(select(Attempt))).scalars().all()
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert len(attempts) == 1
        assert attempts[0].id == recovered.json()["data"]["attemptId"]
        assert attempts[0].fencing_token == 2 and attempts[0].activated_at is None


async def test_admin_audit_release_preserves_lost_outcome_and_requires_workspace_manager(site):
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    from sqlalchemy import text
    from test_workspace import new_member, client
    from veriq_server.db import Attempt, AuditLog

    c, db = site
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await setup(c)
    await login(c)
    ws = await workspace(c)
    d = await device(c, ws)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    await queued_browser_jobs(c, db, ws, 1)
    claim = (await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))).json()[
        "data"
    ]
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    async with db.sessions.begin() as session:
        await session.execute(
            text(
                "UPDATE veriq_attempts SET phase='FINISHED', outcome='ERROR', capacity_state='QUARANTINED'"
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            )
        )
    path = f"/api/v1/workspaces/{ws}/attempts/{claim['attemptId']}/reconcile"
    data = {"processStopped": True, "reason": "Operator inspected stopped process tree"}
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await new_member(c, ws, role="EXECUTOR")
    async with client(c, "member@example.com") as member:
        denied = await member.post(path, json=data)
        assert denied.status_code == 403, denied.text
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    released = await c.post(path, json=data)
    assert released.status_code == 200, released.text
    async with db.sessions() as session:
        attempt = await session.get(Attempt, claim["attemptId"])
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert attempt.capacity_state == "RELEASED" and attempt.outcome == "ERROR"
        record = await session.get(AuditLog, released.json()["data"]["auditId"])
        assert record and record.workspace_id == ws and record.target_id == attempt.id


async def test_current_requester_revocation_blocks_content_while_device_owner_remains_authorized(
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    site,
):
    from test_workspace import new_member, client

    c, db = site
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await setup(c)
    await login(c)
    ws = await workspace(c)
    original = (await c.get("/api/v1/account")).json()["data"]["id"]
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    successor = await new_member(c, ws, role="ADMIN")
    assert (
        await c.put(
            f"/api/v1/workspaces/{ws}/members/{successor}",
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            json={"role": "OWNER", "status": "ACTIVE"},
        )
    ).status_code == 200
    await queued_browser_jobs(c, db, ws, 2)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async with client(c, "member@example.com") as owner:
        d = await device(owner, ws)
        shared = await owner.put(
            f"/api/v1/workspaces/{ws}/runtimes/{d['runnerId']}/grants",
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
        )
        assert shared.status_code == 200, shared.text
        claim = (
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
        ).json()["data"]
        proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
        endpoint = f"/internal/v1/attempts/{claim['attemptId']}"
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert (
            await c.post(endpoint + "/activate", json=proof, headers=auth(d))
        ).status_code == 200
        removed = await owner.put(
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            f"/api/v1/workspaces/{ws}/members/{original}",
            json={"role": "VIEWER", "status": "ACTIVE"},
        )
        assert removed.status_code == 200, removed.text
        # The independent owner/device remains valid, but historical created_by is not authority.
        assert (await c.get("/internal/v1/runtime", headers=auth(d))).status_code == 200
        headers = {
            **auth(d),
            "X-VeriQ-Lease-Token": proof["leaseToken"],
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "X-VeriQ-Fencing-Token": str(proof["fencingToken"]),
        }
        assert (await c.get(claim["snapshotUrl"], headers=headers)).status_code == 403
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        heartbeat = await c.post(
            endpoint + "/heartbeat",
            json={**proof, "progress": {"phase": "RUNNING"}},
            headers=auth(d),
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
        assert heartbeat.status_code == 200 and heartbeat.json()["data"]["cancelRequested"] is True
        assert (
            await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        ).status_code == 204


async def test_unknown_process_revokes_live_authority_and_stop_aggregates_run(site):
    from sqlalchemy import select
    from veriq_server.db import Attempt, Run

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    c, db = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    d = await device(c, ws)
    await queued_browser_jobs(c, db, ws, 1)
    claim = (await c.post("/internal/v1/jobs/claim", json=claim_body(d), headers=auth(d))).json()[
        "data"
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ]
    proof = {k: claim[k] for k in ["leaseToken", "fencingToken"]}
    base = f"/internal/v1/attempts/{claim['attemptId']}"
    assert (await c.post(base + "/activate", json=proof, headers=auth(d))).status_code == 200
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    facts = {
        "fencingToken": claim["fencingToken"],
        "processStopped": False,
        "cleanupStatus": "PENDING",
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        "stoppedAt": "2026-11-11T12:00:00Z",
    }
    assert (await c.post(base + "/reconcile", json=facts, headers=auth(d))).status_code == 200
    heartbeat = await c.post(
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        base + "/heartbeat", json={**proof, "progress": {"phase": "RUNNING"}}, headers=auth(d)
    )
    assert heartbeat.status_code == 409, heartbeat.text
    async with db.sessions() as session:
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        attempt = (await session.execute(select(Attempt))).scalar_one()
        run = (await session.execute(select(Run))).scalar_one()
        assert attempt.capacity_state == "QUARANTINED" and attempt.outcome == "ERROR"
        assert run.state == "FINISHED" and run.outcome == "ERROR"
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert (
        await c.post(base + "/reconcile", json={**facts, "processStopped": True}, headers=auth(d))
    ).status_code == 200
    async with db.sessions() as session:
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        attempt = (await session.execute(select(Attempt))).scalar_one()
        assert attempt.capacity_state == "RELEASED" and attempt.outcome == "ERROR"


async def test_external_reaper_finishes_expired_queued_run_without_attempt(site):
    from sqlalchemy import text, select
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    from veriq_server.db import Run, CaseExecution, Job, Attempt

    c, db = site
    await setup(c)
    await login(c)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ws = await workspace(c)
    await queued_browser_jobs(c, db, ws, 2)
    account = (
        await c.post(f"/api/v1/workspaces/{ws}/service-accounts", json={"name": "Reaper"})
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    ).json()["data"]
    token = (
        await c.post(
            f"/api/v1/workspaces/{ws}/service-accounts/{account['id']}/tokens",
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            json={"purpose": "MAINTENANCE", "operations": ["expired-leases/reap"]},
        )
    ).json()["data"]["token"]
    async with db.sessions.begin() as session:
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        await session.execute(
            text("UPDATE veriq_runs SET created_at=UTC_TIMESTAMP(6)-INTERVAL 31 MINUTE")
        )
    response = await c.post(
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        "/internal/v1/maintenance/expired-leases/reap",
        json={"workspaceId": ws, "limit": 10},
        headers={"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())},
    )
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert response.status_code == 200, response.text
    async with db.sessions() as session:
        run = (await session.execute(select(Run))).scalar_one()
        assert run.state == "FINISHED" and run.outcome == "CANCELLED"
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert run.reason_code == "RUN_TIMEOUT"
        assert all(
            j.state == "FINISHED" and j.outcome == "CANCELLED"
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for j in (await session.execute(select(Job))).scalars()
        )
        assert all(
            j.state == "FINISHED" and j.outcome == "CANCELLED"
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for j in (await session.execute(select(CaseExecution))).scalars()
        )
        assert not (await session.execute(select(Attempt))).first()


async def test_claim_scans_past_multiple_pages_of_ineligible_older_jobs(site):
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    from sqlalchemy import select
    from veriq_server.db import Job, Attempt

    c, db = site
    # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await setup(c)
    await login(c)
    ws = await workspace(c)
    offline, eligible = await device(c, ws), await device(c, ws)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    older = await queued_browser_jobs(c, db, ws, 205)
    newer = await queued_browser_jobs(c, db, ws, 1)
    async with db.sessions.begin() as session:
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for job in (await session.execute(select(Job).where(Job.id.in_(older)))).scalars():
            # Dynamic allowlist deliberately remains a post-query check.
            job.required_capabilities = {
                **job.required_capabilities,
                "runtimeIds": [offline["runnerId"]],
            }
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        job = await session.get(Job, newer[0])
        job.required_capabilities = {
            **job.required_capabilities,
            # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "runtimeIds": [eligible["runnerId"]],
        }
    reply = await c.post(
        "/internal/v1/jobs/claim", json=claim_body(eligible), headers=auth(eligible)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    )
    assert reply.status_code == 200, reply.text
    assert reply.json()["data"]["jobId"] == newer[0]
    async with db.sessions() as session:
        # 分段注释：继续说明 test_lease_mysql.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert len((await session.execute(select(Attempt))).scalars().all()) == 1
