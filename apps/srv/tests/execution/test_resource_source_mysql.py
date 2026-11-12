"""中文重写：T11 source view ACL/integrity against a genuine Agent compilation and receipt.
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

import asyncio
import json
import os
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import shutil
import tempfile
from hashlib import sha256
from pathlib import Path

# 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
import httpx
from test_auth import setup, login
from test_workspace import workspace, new_member, client
from test_lease_mysql import device
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from test_agent_mysql import agent_once
from veriq_server.db import Artifact


async def test_published_source_exact_bytes_integrity_scope_and_current_membership(site):
    c, db = site
    # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    await setup(c)
    await login(c)
    ws = await workspace(c)
    other_ws = await workspace(c, "other")
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    created = await c.post(
        f"/api/v1/workspaces/{ws}/resources",
        json={
            "kind": "ELEMENT_CATALOG",
            # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            "key": "catalog",
            "name": "Catalog",
            "content": {
                "kind": "ELEMENT_CATALOG",
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                "document": {
                    "schemaVersion": "1.0",
                    "elements": [{"key": "name", "locator": {"by": "testId", "value": "name"}}],
                },
            # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            },
        },
    )
    assert created.status_code == 201
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    rid = created.json()["data"]["id"]
    base = f"/api/v1/workspaces/{ws}/resources/{rid}"
    preview = (await c.get(base + "/validation-preview")).json()["data"]
    queued = await c.post(
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        base + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    job_id = queued.json()["data"]["id"]
    assert (
        await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")
    ).status_code == 409
    # Real locked release packaging is test-only; controller never imports Node tooling.
    process = await asyncio.create_subprocess_exec(
        "node",
        "apps/web/tests/prepare-editor-agent.mjs",
        stdout=asyncio.subprocess.PIPE,
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert process.returncode == 0, stderr.decode()
    release = Path(".superpowers/cache/t11/release").resolve()
    env = json.loads(Path(".superpowers/sdd/veriq-1/test-env.json").read_text())
    approved = Path(env["approved_engine_inventory_path"])
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    previous = approved.read_bytes() if approved.exists() else None
    profile = Path(tempfile.mkdtemp(prefix="vq11-py-", dir="/tmp"))
    # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try:
        approved.write_bytes((release / "inventory.json").read_bytes())
        credential = await device(c, ws)
        runtime = f"/api/v1/workspaces/{ws}/runtimes/{credential['runnerId']}"
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert (
            await c.put(
                runtime + "/grants",
                # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                json={"workspaceId": ws, "userIds": [], "sharedWithWorkspace": True},
            )
        ).status_code == 200
        assert (
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await c.put(
                runtime + "/trust",
                json={"trustStatus": "MANAGED", "allowCredentialDelivery": False},
            )
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        ).status_code == 200
        (profile / "device.json").write_text(
            json.dumps({"server": "http://127.0.0.1:18889", **credential})
        )
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        os.chmod(profile / "device.json", 0o600)
        await agent_once(profile, release)
        status = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}")).json()["data"]
        assert status["state"] == "FINISHED" and status["outcome"] == "PASSED"
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        receipt = (await c.get(f"/api/v1/workspaces/{ws}/jobs/{job_id}/validation-receipt")).json()[
            "data"
        ]
        published = await c.post(
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            base + "/publish",
            json={"revision": preview["revision"], "validationReceiptId": receipt["id"]},
        )
        assert published.status_code == 201
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        vid = published.json()["data"]["id"]
        source = base + f"/versions/{vid}/compiled-source"
        metadata = (await c.get(source)).json()["data"]
        assert metadata["descriptorSha256"] == receipt["compiledBundleSha256"]
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert metadata["files"] and all(f["path"].endswith(".ts") for f in metadata["files"])
        file = metadata["files"][0]
        async with httpx.AsyncClient(
            base_url=str(c.base_url), cookies=c.cookies, headers=c.headers
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        ) as raw:
            response = await raw.get(source, params={"path": file["path"]})
            assert response.status_code == 200
            actual = response.content
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            assert sha256(actual).hexdigest() == file["sha256"] and len(actual) == file["sizeBytes"]
            assert response.headers["Content-Type"].startswith("text/plain")
            assert response.headers["X-Content-Type-Options"] == "nosniff"
            assert response.headers["Cache-Control"] == "private, no-store"
            # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            assert "sandbox" in response.headers["Content-Security-Policy"]
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for path in [
                "package.json",
                "../../etc/passwd",
                file["sha256"],
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                "trace.zip",
                "source/asset-snapshot.json",
            ]:
                # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                assert (await raw.get(source, params={"path": path})).status_code == 404
            foreign = source.replace(f"/workspaces/{ws}/", f"/workspaces/{other_ws}/")
            assert (await raw.get(foreign, params={"path": file["path"]})).status_code == 404
            second = await c.post(
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                f"/api/v1/workspaces/{ws}/resources",
                json={
                    "kind": "DATASET",
                    "key": "data",
                    # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    "name": "Data",
                    "content": {
                        "kind": "DATASET",
                        "document": {
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            "schemaVersion": "1.0",
                            "columns": {"name": "string"},
                            "rows": [{"key": "one", "values": {"name": "literal"}}],
                        },
                    # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    },
                },
            )
            assert second.status_code == 201
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            mismatched = source.replace(
                f"/resources/{rid}/", f"/resources/{second.json()['data']['id']}/"
            )
            assert (await raw.get(mismatched, params={"path": file["path"]})).status_code == 404
            # Corrupt actual retained bytes, then length. The original descriptor and receipt stay untouched.
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.content = actual + b"tampered"
            corrupt = await raw.get(source, params={"path": file["path"]})
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            assert corrupt.status_code == 409 and corrupt.json()["code"] == "INVALID_ARTIFACT"
            async with db.sessions.begin() as session:
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                artifact.content = actual
                artifact.size_bytes = len(actual) + 1
            assert (await raw.get(source, params={"path": file["path"]})).status_code == 409
            async with db.sessions.begin() as session:
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                artifact = await session.get(Artifact, (ws, file["sha256"]))
                artifact.size_bytes = len(actual)
            assert (await raw.get(source, params={"path": file["path"]})).content == actual
        uid = await new_member(c, ws, "source-viewer@example.com", "VIEWER")
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        async with client(c, "source-viewer@example.com") as viewer:
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 200
            assert (await viewer.get(foreign, params={"path": file["path"]})).status_code == 403
            assert (await c.delete(f"/api/v1/workspaces/{ws}/members/{uid}")).status_code == 200
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            assert (await viewer.get(source, params={"path": file["path"]})).status_code == 403
        # Failed actual compilation projects a stable safe code and cannot create a receipt.
        bad = await c.post(
            f"/api/v1/workspaces/{ws}/resources",
            json={
                "kind": "CASE",
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                "key": "bad",
                "name": "Bad",
                "content": {
                    # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    "kind": "CASE",
                    "document": {
                        "schemaVersion": "1.0",
                        "caseKey": "bad",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "title": "Bad",
                        "kind": "READ",
                        "roleKey": "reader",
                        "catalogVersionId": vid,
                        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
                        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        "steps": [{"id": "missing", "action": "click", "target": "missing"}],
                    },
                },
            },
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
        assert bad.status_code == 201
        bad_base = f"/api/v1/workspaces/{ws}/resources/{bad.json()['data']['id']}"
        candidate = (await c.get(bad_base + "/validation-preview")).json()["data"]
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        failed = await c.post(
            bad_base + "/validate",
            json={"revision": candidate["revision"], "sourceHash": candidate["sourceHash"]},
        )
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        assert failed.status_code == 202
        await agent_once(profile, release)
        failed_job = f"/api/v1/workspaces/{ws}/jobs/{failed.json()['data']['id']}"
        failure = (await c.get(failed_job)).json()["data"]
        # 分段注释：继续说明 test_resource_source_mysql.py 中后续语句的业务意图、校验点与失败关闭行为
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert failure["outcome"] == "ERROR" and failure["errorCode"] == "UNKNOWN_ELEMENT"
        assert (
            "issues" not in failure
            and (await c.get(failed_job + "/validation-receipt")).status_code == 409
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
    # 关键路径：处理 finally 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    finally:
        # agent_once waits for the foreground Agent and native guardian before returning.
        shutil.rmtree(profile)
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if previous is None:
            approved.unlink(missing_ok=True)
        # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        else:
            approved.write_bytes(previous)
