"""服务端编译结果必须对应冻结快照、实际文件和批准库存，测试覆盖内容寻址校验的可观察拒绝结果。"""

import asyncio
import json
from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from test_publish import CATALOG
from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.contracts import canonical_bytes
from veriq_server.db import (
    Attempt,
    Base,
    Database,
    Job,
    ValidationReceipt,
    Workspace,
    WorkspaceMember,
)
from veriq_server.recovery import require_quiescent
from veriq_server.service import Problem, initialize, lock_installation, now
from veriq_server.services.jobs import database_time
from veriq_server.services.resource import ResourceService
from veriq_server.services import server_compilation
from veriq_server.services.server_compilation import _claim, _finalize, verify_compiled_output
from veriq_server.settings import Settings

_ENGINE_IDENTITY = {
    "engineVersion": "0.1.0",
    "compilerVersion": "0.1.0",
    "runnerSdkVersion": "0.1.0",
    "dependencies": [
        {"name": "@veriq/runner-sdk", "version": "0.1.0", "integrity": "sha256-test-release"}
    ],
}


def descriptor(path, content):
    """按实际二进制构造测试描述符，修改一个文件后可以独立验证长度和散列是否仍受编译结果约束。"""
    return {"path": path, "sizeBytes": len(content), "sha256": sha256(content).hexdigest()}


def _bundle(source, engine, files):
    """按冻结源码和实际文件字节生成测试用描述符，使用正式输出校验器检查文件清单后再断言围栏和回执。"""
    return {
        **{key: value for key, value in engine.items() if key != "files"},
        "schemaVersion": "1.0",
        "sourceHash": source["sourceHash"],
        "entrypoints": [],
        "validationOnly": True,
        "files": [
            descriptor(path, content)
            for path, content in files.items()
            if path != "engine/compiler.tgz"
        ],
    }


def test_compilation_output_binds_approved_files_and_frozen_source():
    """相同输入生成的元数据、源码和批准发行字节应完整接纳，任何可见文件内容变化都使核验失败。"""
    source = {"sourceHash": "a" * 64, "entryCaseVersionIds": [], "engineVersion": "0.1.0"}
    files = {
        "source/asset-snapshot.json": canonical_bytes(source),
        "metadata/expected-plans.json": canonical_bytes({"schemaVersion": "1.0", "cases": []}),
        "validation.ts": b"export const validationOnly = true;\n",
        "package.json": b"{}",
        "engine/compiler.tgz": b"compiler bytes",
    }
    approved = [descriptor(path, files[path]) for path in ("package.json", "engine/compiler.tgz")]
    engine = {
        **_ENGINE_IDENTITY,
        "files": approved,
    }
    bundle = _bundle(source, engine, files)
    verify_compiled_output(source, engine, canonical_bytes(bundle), files, connected=False)
    tampered = {**files, "validation.ts": b"export const validationOnly = true; "}
    with pytest.raises(Problem, match="file bytes"):
        verify_compiled_output(source, engine, canonical_bytes(bundle), tampered, connected=False)
    foreign = deepcopy(bundle)
    foreign["sourceHash"] = "b" * 64
    with pytest.raises(Problem, match="frozen source"):
        verify_compiled_output(source, engine, canonical_bytes(foreign), files, connected=False)


@pytest.fixture
async def queued_validation(site, tmp_path):
    """在独立工作区授予编辑权限并通过正式资源服务创建草稿，首个校验作业与预览返回的源码摘要绑定。"""
    _, db = site
    actor = await initialize(
        db,
        {
            "installationSecret": "operator-secret",
            "email": "@".join(("server-compiler", "example.invalid")),
            "displayName": "Administrator",
            "password": "Long password 123!",
        },
    )
    settings = _settings(tmp_path)
    scope = WorkspaceScope(str(uuid4()))
    async with db.sessions.begin() as session:
        await lock_installation(session)
        session.add(
            Workspace(
                id=scope.workspace_id,
                key="compile",
                name="Compile",
                archived=False,
                created_at=now(),
            )
        )
        await session.flush()
        session.add(
            WorkspaceMember(
                workspace_id=scope.workspace_id, user_id=actor.id, role="OWNER", status="ACTIVE"
            )
        )
        await session.flush()
        resources = ResourceService(session, actor, settings=settings)
        resource = await resources.create(
            scope,
            {"key": "catalog", "name": "Catalog", "kind": CATALOG["kind"], "content": CATALOG},
        )
        preview = await resources.preview(scope, resource["id"])
        job = await resources.validate(
            scope, resource["id"], preview["revision"], preview["sourceHash"]
        )

    return db, actor, settings, scope, resource, job


@pytest.mark.asyncio
async def test_expired_server_compiler_cannot_finish_or_create_receipt(queued_validation):
    """分两次领取同一作业以验证过期围栏不能提交结果，随后撤销请求者权限并检查当前围栏也不能签发回执。"""
    db, actor, settings, scope, _, job = queued_validation
    first = await _claim(db, settings)
    assert first is not None and first.job_id == job["id"]
    assert await _claim(db, settings) is None
    async with db.engine.connect() as connection:
        with pytest.raises(ValueError, match="ACTIVE_STATE_REQUIRES_RECONCILIATION"):
            await require_quiescent(connection, Base.metadata)
    async with db.sessions.begin() as session:
        row = await session.get(Job, first.job_id)
        assert row is not None
        row.server_compile_expires_at = await database_time(session) - timedelta(seconds=1)
    async with db.engine.connect() as connection:
        await require_quiescent(connection, Base.metadata)
    await _finalize(db, settings, first, None, {"errorCode": "STALE_RESULT"})

    # 过期的领取不能抢先写 ERROR，新领取必须获取新身份并拒绝旧进程携带的所谓成功产物。
    second = await _claim(db, settings)
    assert second is not None and second.compilation_id != first.compilation_id
    await _finalize(db, settings, first, (b"stale bundle", {}), None)
    async with db.sessions.begin() as session:
        member = await session.get(WorkspaceMember, (scope.workspace_id, actor.id))
        assert member is not None
        member.role = "VIEWER"
    await _finalize(db, settings, second, (b"claimed before permission change", {}), None)
    async with db.sessions() as session:
        row = await session.get(Job, first.job_id)
        assert row is not None
        assert row.server_compilation_id == second.compilation_id
        assert row.server_compile_expires_at is None
        assert (row.state, row.outcome) == ("FINISHED", "ERROR")
        assert row.server_compile_result == {"errorCode": "REQUESTER_REVOKED"}
        assert await session.scalar(select(func.count()).select_from(Attempt)) == 0
        assert await session.scalar(select(func.count()).select_from(ValidationReceipt)) == 0


@pytest.mark.parametrize("new_first", [True, False])
async def test_disjoint_workers_issue_one_receipt_per_engine(
    queued_validation, tmp_path, monkeypatch, new_first
):
    """两个节点各自只具备一份批准发行，交换领取顺序后核对目录失效和重复提交都不会破坏回执的唯一性。"""
    db, actor, settings, scope, resource, job = queued_validation
    # 另一节点只具备新发行，轮询时不能消耗旧作业的围栏，加入新作业后它应当能够跨过不兼容的队首。
    next_version = "0.2.0"
    newer = tmp_path / "newer"
    newer.mkdir()
    newer_settings = _settings(newer, next_version)
    inventory_path = tmp_path / "inventory.json"
    inventory = json.loads(inventory_path.read_bytes())
    inventory["engines"] += json.loads((newer / "inventory.json").read_bytes())["engines"]
    inventory_path.write_bytes(canonical_bytes(inventory))
    newer_settings.approved_engine_inventory_path = str(inventory_path)
    assert await _claim(db, newer_settings) is None
    async with db.sessions.begin() as session:
        await lock_installation(session)
        row = await session.get(Job, job["id"])
        assert (row.state, row.server_compilation_id) == ("QUEUED", None)
        resources = ResourceService(
            session, actor, settings=newer_settings, engine_version=next_version
        )
        preview = await resources.preview(scope, resource["id"])
        new_job = await resources.validate(
            scope, resource["id"], preview["revision"], preview["sourceHash"]
        )
    # 保留登记的版本号与目录名并替换实际发行字节，恢复批准字节后同一任务应当重新具备领取条件。
    member = newer / "engine/compiler.tgz"
    approved_bytes = member.read_bytes()
    member.write_bytes(b"wrong release")
    assert await _claim(db, newer_settings) is None
    member.write_bytes(approved_bytes)

    async def release_lost(*args, **kwargs):
        raise server_compilation.ServerCompileError("ENGINE_RELEASE_UNAVAILABLE")

    with monkeypatch.context() as patch:
        patch.setattr(server_compilation, "compile_snapshot", release_lost)
        assert not await server_compilation.compile_next(db, newer_settings)
    async with db.sessions() as session:
        row = await session.get(Job, new_job["id"])
        assert (row.state, row.server_compile_expires_at, row.outcome) == ("QUEUED", None, None)

    workers = [(settings, tmp_path, job), (newer_settings, newer, new_job)]
    if new_first:
        workers.reverse()
    for worker, root, expected in workers:
        claim = await _claim(db, worker)
        assert claim is not None and claim.job_id == expected["id"]
        files = {
            entry["path"]: (root / entry["path"]).read_bytes() for entry in claim.engine["files"]
        }
        files.update(
            {
                "source/asset-snapshot.json": canonical_bytes(claim.snapshot),
                "metadata/expected-plans.json": canonical_bytes(
                    {"schemaVersion": "1.0", "cases": []}
                ),
                "validation.ts": b"export const validationOnly = true;",
            }
        )
        output = canonical_bytes(_bundle(claim.snapshot, claim.engine, files)), files
        verify_compiled_output(claim.snapshot, claim.engine, *output, connected=False)
        await _finalize(db, worker, claim, output, None)
        await _finalize(db, worker, claim, output, None)
        assert await _claim(db, worker) is None
    async with db.sessions() as session:
        receipts = list(await session.scalars(select(ValidationReceipt)))
        assert sorted((r.job_id, r.engine_version) for r in receipts) == sorted(
            [(job["id"], "0.1.0"), (new_job["id"], next_version)]
        )


def _settings(tmp_path, version="0.1.0"):
    """构造经过批准库存读取器校验的临时发行描述，工具夹具仅用于路径就绪检查且永远不会被启动。"""
    inventory = tmp_path / "inventory.json"
    fixed = ("package.json", "package-lock.json", "dependencies.json", "engine/compiler.tgz")
    files = []
    for name in fixed:
        path = tmp_path / name
        path.parent.mkdir(exist_ok=True, parents=True)
        data = (version + "/" + name).encode()
        path.write_bytes(data)
        files.append(descriptor(name, data))
    engine = {**_ENGINE_IDENTITY, "engineVersion": version, "files": files}
    inventory.write_bytes(canonical_bytes({"schemaVersion": "1.0", "engines": [engine]}))
    return Settings(
        database_url="mysql+asyncmy://unused@localhost/veriq_test",
        public_url="https://veriq.example",
        master_key="a" * 64,
        signing_key="b" * 64,
        approved_engine_inventory_path=str(inventory),
        server_compiler_release_dirs={version: str(tmp_path)},
        server_compiler_node_path=str(inventory),
        server_compiler_npm_cli_path=str(inventory),
        server_compiler_tsx_path=str(inventory),
    )


@pytest.mark.asyncio
async def test_server_compile_loop_recovers_from_disconnected_database(tmp_path, monkeypatch):
    """模拟单次 MySQL 连接中断，引导常驻进程等待后继续领取，并确认同样故障使单次执行直接报告失败。"""
    stop = asyncio.Event()
    settings = _settings(tmp_path)
    db = Database(settings)
    calls = 0

    async def interrupted_claim(*_args):
        """首次模拟数据库主动关闭连接，随后进入下一轮领取再发送停止信号，以确认是轮询恢复而不是退出。"""
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OperationalError(None, None, RuntimeError(2006, "connection lost"))
        stop.set()
        return False

    monkeypatch.setattr(server_compilation, "compile_next", interrupted_claim)
    try:
        await asyncio.wait_for(server_compilation.serve_compiler(db, settings, stop, once=False), 5)
        assert calls == 2
        calls = 0
        stop.clear()
        with pytest.raises(OperationalError):
            await server_compilation.serve_compiler(db, settings, stop, once=True)
        assert calls == 1
    finally:
        await db.close()
