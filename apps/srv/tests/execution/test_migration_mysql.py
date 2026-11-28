"""迁移测试先在真实旧版表结构写入受控源码和排队任务，再验证升级保留事实；当前非空制品的降级拒绝另作负例。

旧数据使用固定身份、时间和独立序列化输入，避免用新版接口生成含保留历史的制品后再尝试抹掉年龄列。
所有模式切换都沿用现有独占测试数据库，异常路径也必须经真实 Alembic 恢复当前版本。
"""

import argparse
import contextlib
import datetime
import hashlib
import json
import pathlib
import uuid

from alembic import command, config as alembic_config, script
import pytest
import sqlalchemy as sa

import test_auth
import test_workspace
import veriq_server
from veriq_server import cli, db as models


async def test_upgrade_preserves_0005_queued_validate_and_source(site):
    """只有空制品的当前安装才允许退到旧版，再于真实旧表创建待校验任务，验证升级完整保留源码、清单及任务身份。

    管理员会话和工作区先由正常接口创建，旧版期间不调用依赖新增列的接口。
    新版 ORM 只在升级完成后读回；旧表列检查同时证明 fixture 没有误用当前表结构。
    """
    client, database = site
    await test_auth.setup(client)
    await test_auth.login(client)
    workspace_id = await test_workspace.workspace(client)
    account = (await client.get("/api/v1/account")).json()["data"]
    resource, draft, artifacts, job = _legacy_rows(workspace_id, account["id"])
    async with _migration_connection(database) as (connection, change):
        assert (
            await connection.execute(sa.text("SELECT COUNT(*) FROM veriq_artifacts"))
        ).scalar_one() == 0
        await change("0005_runtimes", downgrade=True)

        def seed(sync):
            """只反射数据库实际存在的旧表列并执行受外键约束的插入，禁止借当前模型默认值替代旧版本的数据事实。

            创建时间与 fencing 列在旧版必须不存在；若 fixture 未真正进入旧版，这里立即失败。
            插入后的逐字段比较先证明受控输入已经持久化，然后才允许升级。
            """
            for name, rows in (
                ("veriq_resources", [resource]),
                ("veriq_resource_drafts", [draft]),
                ("veriq_artifacts", artifacts),
                ("veriq_jobs", [job]),
            ):
                table = sa.Table(name, sa.MetaData(), autoload_with=sync, resolve_fks=False)
                if name == "veriq_jobs":
                    assert "fence" not in table.c and "max_retries" not in table.c
                if name == "veriq_artifacts":
                    assert "created_at" not in table.c
                sync.execute(table.insert(), rows)
                actual = sync.execute(sa.select(table)).mappings().all()
                assert len(actual) == len(rows)
                for expected in rows:
                    assert expected in [{key: row[key] for key in expected} for row in actual]

        await connection.run_sync(seed)
        await connection.commit()
        clock = sa.text("SELECT UTC_TIMESTAMP(6)")
        before_upgrade = (await connection.execute(clock)).scalar_one()
        await change("head")
        after_upgrade = (await connection.execute(clock)).scalar_one()

    async with database.sessions() as session:
        upgraded = await session.get(models.Job, job["id"])
        assert {key: getattr(upgraded, key) for key in job} == job
        assert upgraded.state == "QUEUED" and upgraded.fence == 0 and upgraded.max_retries == 0
        assert upgraded.run_id is None and upgraded.case_execution_id is None
        assert upgraded.active_attempt_id is None and upgraded.outcome is None
        for expected in artifacts:
            actual = await session.get(models.Artifact, (workspace_id, expected["sha256"]))
            assert {key: getattr(actual, key) for key in expected} == expected
            assert hashlib.sha256(actual.content).hexdigest() == expected["sha256"]
            assert actual.created_at is not None and actual.storage_backend == "INLINE"
        actual_draft = await session.get(models.ResourceDraft, resource["id"])
        assert {key: getattr(actual_draft, key) for key in draft} == draft

    path = f"/api/v1/workspaces/{workspace_id}/resources/{resource['id']}"
    assert (await client.get(path)).json()["data"] == {
        "id": resource["id"],
        "workspaceId": workspace_id,
        "kind": resource["kind"],
        "key": resource["key"],
        "name": resource["name"],
        "status": "DRAFT",
    }
    assert (await client.get(path + "/draft")).json()["data"]["content"] == draft["document_json"]
    preview = (await client.get(path + "/validation-preview")).json()["data"]
    assert preview["sourceHash"] == json.loads(artifacts[0]["content"])["sourceHash"]
    queued = await client.post(
        path + "/validate",
        json={"revision": draft["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202, queued.text
    assert queued.json()["data"] == {
        "id": job["id"],
        "workspaceId": workspace_id,
        "kind": "VALIDATE",
        "state": "QUEUED",
    }
    updated_account = (await client.get("/api/v1/account")).json()["data"]
    created_at = datetime.datetime.fromisoformat(updated_account.pop("createdAt"))
    assert datetime.datetime.fromisoformat(account.pop("createdAt")) <= before_upgrade.replace(
        tzinfo=datetime.UTC
    )
    assert (
        before_upgrade <= created_at.astimezone(datetime.UTC).replace(tzinfo=None) <= after_upgrade
    )
    assert updated_account == account


async def test_nonempty_artifact_refuses_downgrade_and_retains_history(site):
    """当前版本的真实制品含不可丢弃的年龄历史，降级必须抛出指定拒绝错误并完整保留原始字节、时间和迁移版本。

    通过正常资源接口排队，覆盖现行校验入口；拒绝后比较所有制品列及任务字段，防止只检查状态而漏掉数据丢失。
    """
    client, database = site
    await test_auth.setup(client)
    await test_auth.login(client)
    workspace_id = await test_workspace.workspace(client)
    content = {
        "kind": "ELEMENT_CATALOG",
        "document": {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "veriqId", "value": "save"}}],
        },
    }
    response = await client.post(
        f"/api/v1/workspaces/{workspace_id}/resources",
        json={
            "kind": "ELEMENT_CATALOG",
            "key": "retention",
            "name": "Retention",
            "content": content,
        },
    )
    assert response.status_code == 201, response.text
    path = f"/api/v1/workspaces/{workspace_id}/resources/{response.json()['data']['id']}"
    preview = (await client.get(path + "/validation-preview")).json()["data"]
    queued = await client.post(
        path + "/validate",
        json={"revision": preview["revision"], "sourceHash": preview["sourceHash"]},
    )
    assert queued.status_code == 202, queued.text
    async with _migration_connection(database) as (connection, change):
        before = (
            await connection.execute(sa.text("SELECT * FROM veriq_artifacts ORDER BY sha256"))
        ).all()
        jobs = (await connection.execute(sa.text("SELECT * FROM veriq_jobs ORDER BY id"))).all()
        revision = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        assert len(before) == 2 and all(row.created_at is not None for row in before)
        with pytest.raises(
            RuntimeError, match="^Artifact retention history must be retained; downgrade refused$"
        ):
            await change("0005_runtimes", downgrade=True)
        await connection.rollback()
        assert (
            await connection.execute(sa.text("SELECT * FROM veriq_artifacts ORDER BY sha256"))
        ).all() == before
        assert (
            await connection.execute(sa.text("SELECT * FROM veriq_jobs ORDER BY id"))
        ).all() == jobs
        after_revision = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        assert await _has_copy_audit_column(connection)
        assert await _has_agent_tables(connection)
        assert after_revision == revision
        # 单步只移除没有复制记录的来源列，不会触碰制品年龄，原有制品无需先删除即可回退到上一版本。
        await change("0015_artifact_retention", downgrade=True)
        assert not await _has_copy_audit_column(connection)
        assert (
            await connection.execute(sa.text("SELECT * FROM veriq_artifacts ORDER BY sha256"))
        ).all() == before
        await change("head")
        assert await _has_copy_audit_column(connection)
    assert (await client.get(path)).status_code == 200
    assert (await client.get("/api/v1/account")).status_code == 200


async def test_copy_provenance_refuses_direct_downgrade(site):
    """即使只请求上一版本，有来源标识的审计事实也必须在原表中保留，验证失败不会删除列或修改复制关系。"""
    _, database = site
    source, target, event_id = (str(uuid.uuid4()) for _ in range(3))
    async with database.sessions.begin() as session:
        session.add(
            models.AuditLog(
                id=event_id,
                action="dataset.copied",
                target_id=target,
                source_version_id=source,
                created_at=datetime.datetime.now(datetime.UTC).replace(tzinfo=None),
            )
        )
    async with _migration_connection(database) as (connection, change):
        schema = sa.text(
            "SELECT table_name, ordinal_position, column_name, column_type "
            "FROM information_schema.columns WHERE table_schema = DATABASE() "
            "ORDER BY table_name, ordinal_position"
        )
        columns_before = (await connection.execute(schema)).all()
        before = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        with pytest.raises(
            RuntimeError, match="^Dataset copy provenance must be retained; downgrade refused$"
        ):
            await change("0015_artifact_retention", downgrade=True)
        await connection.rollback()
        assert await _has_copy_audit_column(connection)
        assert await _has_agent_tables(connection)
        after = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        assert (await connection.execute(schema)).all() == columns_before
        assert after == before
    async with database.sessions() as session:
        event = await session.get(models.AuditLog, event_id)
        assert (event.target_id, event.source_version_id) == (target, source)


async def test_upgrade_from_dataset_head_keeps_copy_provenance(site, tmp_path):
    """集成升级直接接受已部署数据集修订，来源审计继续可读，空对话表与唯一的新版本记录同时出现。"""
    _, database = site
    source, target, event_id = (str(uuid.uuid4()) for _ in range(3))
    async with _migration_connection(database) as (connection, change):
        initial_head = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        await change("0016_dataset_copy_audit", downgrade=True)
        assert await _has_copy_audit_column(connection)
        assert not await _has_agent_tables(connection)
        await connection.execute(
            sa.insert(models.AuditLog).values(
                id=event_id,
                action="dataset.copied",
                target_id=target,
                source_version_id=source,
                created_at=datetime.datetime.now(datetime.UTC).replace(tzinfo=None),
            )
        )
        await connection.commit()
        await change("0017_conversational_agent")
        revision = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        assert revision == "0017_conversational_agent"
        assert await _has_agent_tables(connection)
        await connection.commit()
        config_path = tmp_path / "operator.json"
        cli.secure_write(
            config_path,
            json.dumps(
                {
                    "database_url": database.engine.url.render_as_string(hide_password=False),
                    "environment": "development",
                    "public_url": "http://127.0.0.1:18889",
                    "master_key": "a" * 64,
                    "signing_key": "b" * 64,
                }
            ),
        )
        await cli.run(argparse.Namespace(config=config_path, command="migrate"))
        assert (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one() == initial_head
    async with database.sessions() as session:
        event = await session.get(models.AuditLog, event_id)
        assert (event.target_id, event.source_version_id) == (target, source)


async def test_bound_file_volume_refuses_relative_downgrade(site):
    """已绑定文件卷的安装不能回退到无法校验卷身份的架构，拒绝后需从数据库读回原绑定及未改变的迁移版本。"""
    _, database = site
    volume_id = str(uuid.uuid4())
    async with _migration_connection(database) as (connection, change):
        await change("0025_file_volume", downgrade=True)
        await connection.execute(
            sa.update(models.Installation)
            .where(models.Installation.id == 1)
            .values(file_volume_id=volume_id)
        )
        await connection.commit()
        with pytest.raises(
            RuntimeError, match="^Bound FILE volume identity must be retained; downgrade refused$"
        ):
            await change("-1", downgrade=True)
        await connection.rollback()
        assert (
            await connection.execute(sa.select(models.Installation.file_volume_id))
        ).scalar_one() == volume_id
        assert (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one() == "0025_file_volume"


async def test_form_receipt_prevents_downgrade_and_preserves_large_revision(site):
    """验证已有私有回执会阻止数据库回退，并从数据库读回原有实体标识及超出三十二位范围的修订号，避免历史丢失。"""
    client, database = site
    await test_auth.setup(client)
    await test_auth.login(client)
    workspace_id = await test_workspace.workspace(client)
    user_id = (await client.get("/api/v1/account")).json()["data"]["id"]
    session_id, turn_id, receipt_id = (str(uuid.uuid4()) for _ in range(3))
    created = datetime.datetime(2026, 11, 27)
    revision = 2**40
    async with database.sessions.begin() as session:
        session.add(
            models.AgentSession(
                id=session_id,
                user_id=user_id,
                workspace_id=workspace_id,
                title="Existing session",
                created_at=created,
                archived=False,
            )
        )
        await session.flush()
        session.add(
            models.AgentTurn(
                id=turn_id,
                session_id=session_id,
                request_id=turn_id,
                text="Open the fixture editor",
                status="COMPLETED",
                created_at=created,
                workspace_capability="FIXTURE",
            )
        )
        await session.flush()
        session.add(
            models.AgentFormReceipt(
                id=receipt_id,
                turn_id=turn_id,
                action="resource.draft_updated",
                target_id=str(uuid.uuid4()),
                revision=revision,
                created_at=created,
            )
        )
    async with _migration_connection(database) as (connection, change):
        before_revision = (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        before_schema = await connection.run_sync(_schema_shape)
        with pytest.raises(
            RuntimeError, match="Persisted Test Agent form receipts must be retained"
        ):
            await change("0026_agent_tasks", downgrade=True)
        assert (
            await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one() == before_revision
        assert await connection.run_sync(_schema_shape) == before_schema
    async with database.sessions() as session:
        saved = await session.get(models.AgentFormReceipt, receipt_id)
        assert saved is not None and saved.turn_id == turn_id and saved.revision == revision


def _schema_shape(connection):
    """从真实连接反射全部表的列、索引和约束，证明拒绝回退前没有已被 MySQL 隐式提交的结构变更残留。"""
    inspector = sa.inspect(connection)
    return {
        table: {
            "columns": [
                (
                    column["name"],
                    str(column["type"]),
                    column["nullable"],
                    column["default"],
                )
                for column in inspector.get_columns(table)
            ],
            "indexes": inspector.get_indexes(table),
            "primary_key": inspector.get_pk_constraint(table),
            "foreign_keys": inspector.get_foreign_keys(table),
            "unique_constraints": inspector.get_unique_constraints(table),
        }
        for table in inspector.get_table_names()
    }


async def _has_agent_tables(connection):
    """反射所有 Agent 表，确保降级拒绝后版本号和真实结构仍一致，不能依赖回滚撤销 MySQL 隐式提交。"""
    tables = await connection.run_sync(lambda sync: sa.inspect(sync).get_table_names())
    return {"veriq_agent_settings", "veriq_agent_sessions", "veriq_agent_turns"} <= set(tables)


async def _has_copy_audit_column(connection):
    """通过数据库实际反射检查来源列是否存在，以免仅凭回滚后的版本记录误判不可回滚的结构变更。"""
    return await connection.run_sync(
        lambda sync: any(
            col["name"] == "source_version_id"
            for col in sa.inspect(sync).get_columns("veriq_audit_logs")
        )
    )


async def test_legacy_schema_restores_head_after_test_body_failure(site):
    """旧版夹具中的断言异常也必须触发真实升级清理，通过独立连接读回版本证明不会把旧表结构遗留给后续测试。

    合成异常只控制测试体退出，升级和数据库连接保持真实，避免把清理路径的调用记录冒充完成的迁移。
    """
    client, database = site
    with pytest.raises(AssertionError, match="^controlled legacy fixture failure$"):
        async with _migration_connection(database) as (connection, change):
            original_head = (
                await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
            ).scalar_one()
            await change("0005_runtimes", downgrade=True)
            revision = (
                await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
            ).scalar_one()
            assert revision == "0005_runtimes"
            raise AssertionError("controlled legacy fixture failure")
    async with database.engine.connect() as observer:
        revision = (
            await observer.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
        ).scalar_one()
        assert revision == original_head
    assert (await client.get("/api/v1/setup")).status_code == 200


def _legacy_rows(workspace_id, user_id):
    """按旧版资源及任务表定义构造确定性输入，摘要直接来自受控 JSON 字节，不从迁移后的业务观察反推期望值。

    文档仅含整数、ASCII 字符和普通对象，排序紧凑 JSON 与规范字节一致。
    候选 UUID 绑定工作区、资源和修订；源码摘要只覆盖快照核心字段，清单再绑定任务身份。
    创建者与工作区由现行认证接口建立，其余业务事实都在降级完成后写入旧表。
    """
    resource_id = "00000000-0000-4000-8000-000000000005"
    job_id = "00000000-0000-4000-8000-000000000006"
    created_at = datetime.datetime(2024, 6, 1, 12)
    content = {
        "kind": "ELEMENT_CATALOG",
        "document": {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "veriqId", "value": "save"}}],
        },
    }
    document_hash = hashlib.sha256(_json_bytes(content)).hexdigest()
    candidate_id = str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"veriq:{workspace_id}:{resource_id}:1:{document_hash}")
    )
    snapshot = {
        "schemaVersion": "1.0",
        "workspaceId": workspace_id,
        "engineVersion": "0.1.0",
        "entryCaseVersionIds": [],
        "assets": [
            {
                "resourceId": resource_id,
                "versionId": candidate_id,
                "sha256": document_hash,
                **content,
            }
        ],
    }
    source_hash = hashlib.sha256(_json_bytes(snapshot)).hexdigest()
    snapshot.update(
        sourceHash=source_hash,
        validationTarget={
            "resourceId": resource_id,
            "versionId": candidate_id,
            "revision": 1,
        },
    )
    source = _json_bytes(snapshot)
    snapshot_hash = hashlib.sha256(source).hexdigest()
    manifest = _json_bytes(
        {
            "schemaVersion": "1.0",
            "workspaceId": workspace_id,
            "jobId": job_id,
            "snapshotSha256": snapshot_hash,
            "engineVersion": "0.1.0",
            "kind": "VALIDATE",
            "resourceId": resource_id,
            "revision": 1,
            "sourceHash": source_hash,
        }
    )
    manifest_hash = hashlib.sha256(manifest).hexdigest()
    resource = {
        "id": resource_id,
        "workspace_id": workspace_id,
        "kind": "ELEMENT_CATALOG",
        "key": "migration",
        "name": "Migration",
        "status": "DRAFT",
        "latest_version_id": None,
    }
    draft = {
        "resource_id": resource_id,
        "workspace_id": workspace_id,
        "revision": 1,
        "document_json": content,
        "updated_by": user_id,
        "updated_at": created_at,
    }
    artifacts = [
        {
            "workspace_id": workspace_id,
            "sha256": digest,
            "content": raw,
            "size_bytes": len(raw),
            "media_type": "application/json",
        }
        for digest, raw in ((snapshot_hash, source), (manifest_hash, manifest))
    ]
    job = {
        "id": job_id,
        "workspace_id": workspace_id,
        "kind": "VALIDATE",
        "subject_id": resource_id,
        "state": "QUEUED",
        "snapshot_hash": snapshot_hash,
        "manifest_hash": manifest_hash,
        "validation_key": hashlib.sha256(
            _json_bytes(
                {
                    "resourceId": resource_id,
                    "revision": 1,
                    "sourceHash": source_hash,
                }
            )
        ).hexdigest(),
        "required_capabilities": {"engineVersion": "0.1.0", "compileAssets": True},
        "active_attempt_id": None,
        "created_by": user_id,
        "created_at": created_at,
    }
    return resource, draft, artifacts, job


def _json_bytes(value):
    """受控夹具仅使用无需浮点或特殊 Unicode 规范化的 JSON 值，以独立标准库编码冻结输入及预期摘要。

    不调用资源领域的快照或摘要函数，避免生产构造器与测试同时发生同一种错误。
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


@contextlib.asynccontextmanager
async def _migration_connection(database):
    """复用受保护测试库连接执行真实版本切换，并以最终升级恢复当前表结构，保证异常退出不会污染下一个测试。

    此上下文不删除制品、不修改外键设置，也不绕过迁移保护。
    未提交的测试写入先回滚，已提交的旧版事实由正常升级保留。
    """
    config = alembic_config.Config()
    config.set_main_option(
        "script_location", str(pathlib.Path(veriq_server.__file__).parent / "migrations")
    )
    head = script.ScriptDirectory.from_config(config).get_current_head()
    async with database.engine.connect() as connection:

        async def change(revision, *, downgrade=False):
            """将当前真实物理连接交给 Alembic 执行选定方向，并显式提交版本记录以供后续应用连接正确读取。

            降级错误直接向上传播，只有负例本身捕获指定的保留历史拒绝。
            """

            def apply(sync):
                """在同步桥接中绑定现有连接运行原始迁移脚本，不建立额外数据库，也不替换迁移执行器或返回结果。

                方向由测试明确选择，所有实际表结构修改仍由仓库版本脚本负责。
                """
                config.attributes["connection"] = sync
                operation = command.downgrade if downgrade else command.upgrade
                operation(config, revision)

            await connection.run_sync(apply)
            await connection.commit()

        try:
            yield connection, change
        finally:
            await connection.rollback()
            await change("head")
            revision = (
                await connection.execute(sa.text("SELECT version_num FROM veriq_alembic_version"))
            ).scalar_one()
            assert revision == head
