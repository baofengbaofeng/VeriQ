"""
VeriQ 停机备份以 MySQL 全局读锁固定所有表的同一状态，同时保存真实制品和生效密钥配置；恢复仅面向已经显式迁移的空目标，
版本、摘要、密钥和外键全部匹配才可解除失败标记。
"""

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator, Callable
from typing import TYPE_CHECKING, cast
from hashlib import sha256
import json
import os
from pathlib import Path

from alembic.migration import MigrationContext
import sqlalchemy
from sqlalchemy import MetaData, select, text, func, and_, exists
from sqlalchemy.ext.asyncio import AsyncConnection

from . import __version__
from .db import Base, Database, Installation
from .file_volume import check_volume
from .handlers.static import load_published_site
from .migrate import _migration_lock_name
from .outbound import s3_operation
from .readiness import packaged_heads
from .settings import Settings, operator_config_values
from .snapshot_io import (
    encode_value,
    decode_value,
    private_file,
    safe_snapshot_file,
    file_digest,
    inventory,
    copy_tree,
)

if TYPE_CHECKING:
    import mypy_boto3_s3.client


@asynccontextmanager
async def maintenance_connection(db: Database, *, freeze: bool) -> AsyncIterator[AsyncConnection]:
    """
    复用迁移命名锁阻止升级与恢复交错，备份额外持有全局读锁冻结真实数据库；命名锁失败或清理无法确认时直接失败，
    不自动重连伪造旧物理会话已经释放锁的结论。
    """
    async with db.engine.connect() as connection:
        database = (await connection.execute(text("SELECT DATABASE()"))).scalar_one()
        name = _migration_lock_name(database)
        acquired = (
            await connection.execute(text("SELECT GET_LOCK(:name, 0)"), {"name": name})
        ).scalar_one()
        if acquired != 1:
            raise ValueError("MAINTENANCE_BUSY")
        frozen = False
        try:
            if freeze:
                await connection.execute(text("SET SESSION lock_wait_timeout=60"))
                await connection.execute(text("FLUSH TABLES WITH READ LOCK"))
                frozen = True
            yield connection
        finally:
            try:
                if not connection.invalidated and not connection.closed:
                    if frozen:
                        await connection.execute(text("UNLOCK TABLES"))
                    released = (
                        await connection.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})
                    ).scalar_one()
                    if released != 1:
                        raise ValueError("MAINTENANCE_UNLOCK_UNCONFIRMED")
                else:
                    raise ValueError("MAINTENANCE_CONNECTION_LOST")
            finally:
                await connection.rollback()


async def installed_tables(connection: AsyncConnection) -> MetaData:
    """
    读取目标已安装的真实表及外键并要求与当前程序完整匹配，恢复不会执行 DDL 或忽略未知平台表；迁移头必须精确一致，
    避免把新数据库交给旧软件进行猜测式回滚。
    """
    version = str((await connection.execute(text("SELECT VERSION()"))).scalar_one())
    if not version.startswith("8.4.") or "mariadb" in version.lower():
        raise ValueError("MYSQL_VERSION_UNSUPPORTED")
    current = await connection.run_sync(
        lambda conn: MigrationContext.configure(
            conn, opts={"version_table": "veriq_alembic_version"}
        ).get_current_heads()
    )
    if len(packaged_heads()) != 1 or set(current) != set(packaged_heads()):
        raise ValueError("SCHEMA_VERSION_INCOMPATIBLE")
    metadata = MetaData()
    await connection.run_sync(lambda conn: metadata.reflect(bind=conn))
    if set(metadata.tables) != set(Base.metadata.tables) | {"veriq_alembic_version"}:
        raise ValueError("SCHEMA_TABLE_SET_INCOMPATIBLE")
    return metadata


async def require_quiescent(connection: AsyncConnection, metadata: MetaData) -> None:
    """
    停机声明之外再检查数据库中的在途任务、隔离容量、未完成发布和导出；这些状态可能仍有外部进程写入，因此无法仅靠暂停
    HTTP 服务证明制品已经稳定，遇到任何一个就拒绝备份。
    """
    checks: dict[str, Callable[[sqlalchemy.Table], sqlalchemy.ColumnElement[bool]]] = {
        "veriq_attempts": lambda t: (t.c.phase != "FINISHED") | (t.c.capacity_state != "RELEASED"),
        "veriq_resource_leases": lambda t: t.c.state != "RELEASED",
        # 活动编译围栏授权独立进程回写，只有已过期的领取可以随备份保留并在恢复后由新围栏重建。
        "veriq_jobs": lambda t: t.c.server_compile_expires_at > func.utc_timestamp(6),
        "veriq_artifact_publications": lambda t: t.c.state == "PENDING",
        "veriq_bundle_exports": lambda t: t.c.state == "IN_PROGRESS",
        "veriq_ai_generations": lambda t: t.c.status.in_(["RUNNING", "IN_PROGRESS", "PENDING"]),
    }
    for name, predicate in checks.items():
        table = metadata.tables[name]
        if (await connection.execute(select(table).where(predicate(table)).limit(1))).first():
            raise ValueError("ACTIVE_STATE_REQUIRES_RECONCILIATION")


def key_fingerprints(settings: Settings) -> dict[str, str]:
    """
    只为兼容比较计算生效密钥的摘要，完整配置仅写入私有备份载荷而不输出到日志；密钥标识与字节共同参与比较，
    防止同名密钥被错误替换后恢复出不可解密的数据库。
    """
    values = {**settings.previous_master_keys, settings.master_key_id: settings.master_key}
    return {
        key: sha256(bytes.fromhex(value.get_secret_value())).hexdigest()
        for key, value in values.items()
    }


def s3_client(settings: Settings) -> "mypy_boto3_s3.client.S3Client":
    """
    仅在备份中确实存在 S3 记录或恢复明确允许桶清单检查时创建真实客户端，操作使用既有 boto3 依赖与有界网络超时，
    不改变业务存储适配器或探测策略的权限默认值。

    工厂返回前已检查同一个配置对象的桶名，后续请求的类型转换只表达该检查建立的字符串约束。
    """
    import boto3
    from botocore.config import Config

    if not settings.artifact_s3_bucket:
        raise ValueError("S3_CONFIGURATION_REQUIRED")
    return boto3.client(
        "s3",
        endpoint_url=settings.artifact_s3_endpoint,
        region_name=settings.artifact_s3_region,
        config=Config(connect_timeout=5, read_timeout=30, retries={"total_max_attempts": 1}),
    )


async def backup(
    db: Database,
    settings: Settings,
    destination: Path,
    *,
    services_stopped: bool,
    configuration_path: Path,
) -> str:
    """
    操作员确认所有写入服务停止后，在同一全局读锁窗口流式导出全部真实表与外置字节并保存生效配置、签发私钥和引擎库存，
    只有所有载荷同步完成才写入完成清单并返回摘要。
    """
    if not services_stopped or not destination.is_absolute() or destination.exists():
        raise ValueError("BACKUP_REQUIRES_QUIESCENT_NEW_ABSOLUTE_DIRECTORY")
    artifact_root = Path(settings.artifact_directory).absolute()
    if artifact_root == destination or artifact_root in destination.parents:
        raise ValueError("BACKUP_DESTINATION_INSIDE_ARTIFACT_ROOT")
    destination.mkdir(mode=0o700, parents=False)
    async with maintenance_connection(db, freeze=True) as connection:
        metadata = await installed_tables(connection)
        await require_quiescent(connection, metadata)
        volume = await connection.scalar(
            select(Installation.file_volume_id).where(Installation.id == 1)
        )
        if volume:
            check_volume(artifact_root, volume)
        tables = {}
        for name, table in metadata.tables.items():
            path = destination / "tables" / (name + ".jsonl")
            path.parent.mkdir(mode=0o700, exist_ok=True)
            count = 0
            with os.fdopen(
                os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
            ) as stream:
                result = await connection.stream(select(table))
                async for row in result.mappings():
                    stream.write(
                        json.dumps(
                            {key: encode_value(value) for key, value in row.items()},
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
                    count += 1
                stream.flush()
                os.fsync(stream.fileno())
            tables[name] = {
                "file": path.relative_to(destination).as_posix(),
                "rows": count,
                "columns": list(table.c.keys()),
            }
        table_directory = os.open(destination / "tables", os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(table_directory)
        finally:
            os.close(table_directory)
        private_file(
            destination / "configuration.json",
            (json.dumps(operator_config_values(settings.model_dump()), indent=2) + "\n").encode(),
        )
        material = {}
        installation_secret = configuration_path.with_suffix(".installation-secret")
        if installation_secret.exists():
            if (
                installation_secret.is_symlink()
                or not installation_secret.is_file()
                or installation_secret.stat().st_size > 256
            ):
                raise ValueError("INSTALLATION_SECRET_UNSAFE")
            private_file(destination / "installation-secret", installation_secret.read_bytes())
            material["installation-secret"] = "installation-secret"
        for label, configured in (
            ("issuer", settings.bundle_issuer_path),
            ("engines", settings.approved_engine_inventory_path),
        ):
            if configured:
                source = Path(configured)
                if source.is_symlink() or not source.is_file():
                    raise ValueError("BACKUP_EXTERNAL_MATERIAL_UNSAFE")
                private_file(destination / (label + ".json"), source.read_bytes())
                material[label] = label + ".json"
        import asyncio

        if artifact_root.exists():
            if (artifact_root / ".veriq-restore-incomplete").exists():
                raise ValueError("RESTORE_INCOMPLETE")
            await asyncio.to_thread(copy_tree, artifact_root, destination / "file-artifacts")
        elif settings.artifact_backend == "FILE":
            raise ValueError("ARTIFACT_ROOT_MISSING")
        s3_objects = []
        artifacts = metadata.tables["veriq_artifacts"]
        rows = (
            await connection.execute(
                select(artifacts).where(
                    artifacts.c.storage_backend == "S3", artifacts.c.expired_at.is_(None)
                )
            )
        ).mappings()
        from .services.artifact import key, verify, MAX_FILE

        client: mypy_boto3_s3.client.S3Client | None = None
        try:
            for row in rows:
                if client is None:
                    client = await asyncio.to_thread(s3_client, settings)
                object_key = key(row["workspace_id"], row["sha256"], row["storage_incarnation"])
                with s3_operation("storage.get"):
                    response = await asyncio.to_thread(
                        client.get_object,
                        Bucket=cast(str, settings.artifact_s3_bucket),
                        Key=object_key,
                    )
                    try:
                        raw = await asyncio.to_thread(
                            response["Body"].read, min(row["size_bytes"], MAX_FILE) + 1
                        )
                        verify(raw, row["sha256"], row["size_bytes"])
                    finally:
                        response["Body"].close()
                file = "s3-artifacts/" + object_key
                private_file(destination / file, raw)
                s3_objects.append(
                    {
                        "key": object_key,
                        "file": file,
                        "sha256": row["sha256"],
                        "size": row["size_bytes"],
                    }
                )
        finally:
            if client:
                client.close()
        # 制品删除记录是防止迟到写入复活的权威，不能只备份当前存活对象；恢复在重新写入存活对象之前先重建这些零字节屏障，
        # 精确保留旧 incarnation 的拒绝事实。
        tombstones = []
        deletions = metadata.tables["veriq_artifact_deletions"]
        for row in (
            await connection.execute(select(deletions).where(deletions.c.storage_backend == "S3"))
        ).mappings():
            tombstones.append(key(row["workspace_id"], row["sha256"], row["storage_incarnation"]))
        site = load_published_site(settings)
        manifest = {
            "format": "veriq-backup-1",
            "serverVersion": __version__,
            "schemaHeads": list(packaged_heads()),
            "buildInfo": site.build_info if site else None,
            "tables": tables,
            "materials": material,
            "keyFingerprints": key_fingerprints(settings),
            "signingKeyFingerprint": sha256(
                bytes.fromhex(settings.signing_key.get_secret_value())
            ).hexdigest(),
            "artifactBackend": settings.artifact_backend,
            "s3Objects": s3_objects,
            "s3Tombstones": sorted(set(tombstones)),
            "files": await asyncio.to_thread(inventory, destination),
        }
        private_file(
            destination / "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode()
        )
        directory = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    return file_digest(destination / "manifest.json")


async def restore(
    db: Database,
    settings: Settings,
    source: Path,
    *,
    expected_digest: str,
    services_stopped: bool,
    allow_restore: bool,
    confirm_empty_target: bool,
    allow_s3_inventory: bool,
    configuration_path: Path,
) -> None:
    """
    恢复必须携带独立清单摘要和三项显式停机及空目标确认，拒绝任何版本或密钥不兼容；外部制品写入失败时保留不完整标记，
    禁止将部分恢复的目标自动报告为可用服务。
    """
    if (
        not services_stopped
        or not allow_restore
        or not confirm_empty_target
        or not source.is_absolute()
    ):
        raise ValueError("RESTORE_EXPLICIT_CONFIRMATION_REQUIRED")
    manifest_path = safe_snapshot_file(source, "manifest.json")
    if len(expected_digest) != 64 or file_digest(manifest_path) != expected_digest:
        raise ValueError("BACKUP_MANIFEST_DIGEST_MISMATCH")
    manifest = json.loads(manifest_path.read_text())
    site = load_published_site(settings)
    if (
        manifest["format"] != "veriq-backup-1"
        or manifest["serverVersion"] != __version__
        or manifest["schemaHeads"] != list(packaged_heads())
        or manifest["buildInfo"] != (site.build_info if site else None)
    ):
        raise ValueError("BACKUP_VERSION_INCOMPATIBLE")
    if (
        manifest["artifactBackend"] != settings.artifact_backend
        or manifest["keyFingerprints"] != key_fingerprints(settings)
        or manifest["signingKeyFingerprint"]
        != sha256(bytes.fromhex(settings.signing_key.get_secret_value())).hexdigest()
    ):
        raise ValueError("BACKUP_CONFIG_KEYS_INCOMPATIBLE")
    import asyncio

    for name, identity in manifest["files"].items():
        path = safe_snapshot_file(source, name)
        if (
            path.stat().st_size != identity["size"]
            or await asyncio.to_thread(file_digest, path) != identity["sha256"]
        ):
            raise ValueError("BACKUP_PAYLOAD_DIGEST_MISMATCH")
    actual = await asyncio.to_thread(inventory, source)
    if set(actual) != set(manifest["files"]) | {"manifest.json"}:
        raise ValueError("BACKUP_PAYLOAD_SET_MISMATCH")
    archived_settings = Settings.model_validate(
        json.loads(safe_snapshot_file(source, "configuration.json").read_text())
    )
    # 已确认的清单同时约束归档和目标的签名字节，避免私有配置与实际恢复使用的签名身份不一致。
    if (
        key_fingerprints(archived_settings) != manifest["keyFingerprints"]
        or sha256(bytes.fromhex(archived_settings.signing_key.get_secret_value())).hexdigest()
        != manifest["signingKeyFingerprint"]
    ):
        raise ValueError("BACKUP_KEY_MATERIAL_MISMATCH")
    version_entry = manifest["tables"]["veriq_alembic_version"]
    with safe_snapshot_file(source, version_entry["file"]).open() as version_stream:
        archived_heads = [decode_value(json.loads(line)["version_num"]) for line in version_stream]
    if len(archived_heads) != version_entry["rows"] or set(archived_heads) != set(
        manifest["schemaHeads"]
    ):
        raise ValueError("BACKUP_SCHEMA_PAYLOAD_MISMATCH")
    target = Path(settings.artifact_directory).absolute()
    if (
        target == source
        or source in target.parents
        or target in source.parents
        or target.is_symlink()
        or (target.exists() and (not target.is_dir() or any(target.iterdir())))
    ):
        raise ValueError("RESTORE_ARTIFACT_TARGET_NOT_EMPTY")
    for ancestor in target.parents:
        if ancestor.is_symlink():
            raise ValueError("RESTORE_ARTIFACT_TARGET_UNSAFE")
    material_targets = {}
    for label, configured in (
        ("issuer", settings.bundle_issuer_path),
        ("engines", settings.approved_engine_inventory_path),
        ("installation-secret", str(configuration_path.with_suffix(".installation-secret"))),
    ):
        if label in manifest["materials"]:
            if not configured:
                raise ValueError("RESTORE_EXTERNAL_MATERIAL_PATH_REQUIRED")
            path = Path(configured).absolute()
            raw = safe_snapshot_file(source, manifest["materials"][label]).read_bytes()
            if any(parent.is_symlink() for parent in (path, *path.parents)) or (
                path.exists() and (not path.is_file() or path.read_bytes() != raw)
            ):
                raise ValueError("RESTORE_EXTERNAL_MATERIAL_CONFLICT")
            material_targets[path] = raw
    client: mypy_boto3_s3.client.S3Client | None = None
    try:
        if manifest["s3Objects"] or manifest["s3Tombstones"]:
            if not allow_s3_inventory:
                raise ValueError("RESTORE_S3_LIST_PERMISSION_CONFIRMATION_REQUIRED")
            client = await asyncio.to_thread(s3_client, settings)
            with s3_operation("storage.list"):
                listing = await asyncio.to_thread(
                    client.list_objects_v2,
                    Bucket=cast(str, settings.artifact_s3_bucket),
                    MaxKeys=1,
                )
            if listing.get("KeyCount", 0) or listing.get("Contents") or listing.get("IsTruncated"):
                raise ValueError("RESTORE_S3_TARGET_NOT_EMPTY")
        async with maintenance_connection(db, freeze=False) as connection:
            metadata = await installed_tables(connection)
            if set(manifest["tables"]) != set(metadata.tables):
                raise ValueError("BACKUP_TABLE_SET_MISMATCH")
            for name, table in metadata.tables.items():
                if name == "veriq_alembic_version":
                    continue
                if name == "veriq_installation":
                    rows = (await connection.execute(select(table))).mappings().all()
                    if rows and (
                        len(rows) != 1
                        or rows[0]["id"] != 1
                        or rows[0]["initialized"]
                        or rows[0]["setup_secret_hash"]
                    ):
                        raise ValueError("RESTORE_DATABASE_NOT_EMPTY")
                elif (
                    await connection.execute(select(func.count()).select_from(table))
                ).scalar_one():
                    raise ValueError("RESTORE_DATABASE_NOT_EMPTY")
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            marker = target / ".veriq-restore-incomplete"
            private_file(marker, b"VeriQ restore is incomplete\n")
            if (source / "file-artifacts").exists():
                await asyncio.to_thread(
                    copy_tree, source / "file-artifacts", target, existing_target=True
                )
            if client:
                for object_key in manifest["s3Tombstones"]:
                    with s3_operation("storage.put"):
                        await asyncio.to_thread(
                            client.put_object,
                            Bucket=cast(str, settings.artifact_s3_bucket),
                            Key=object_key,
                            Body=b"",
                        )
                for item in manifest["s3Objects"]:
                    raw = safe_snapshot_file(source, item["file"]).read_bytes()
                    with s3_operation("storage.put"):
                        await asyncio.to_thread(
                            client.put_object,
                            Bucket=cast(str, settings.artifact_s3_bucket),
                            Key=item["key"],
                            Body=raw,
                        )
            # 循环外键无法简单按表排序恢复，因此仅在本恢复会话临时停用外键检查；全部写入之后逐条外键执行反向存在性校验，
            # 任一悬空引用都回滚，绝不以重新启用检查冒充已有数据已经验证。
            await connection.execute(text("SET FOREIGN_KEY_CHECKS=0"))
            try:
                await connection.execute(metadata.tables["veriq_installation"].delete())
                for name, table in metadata.tables.items():
                    if name == "veriq_alembic_version":
                        continue
                    entry = manifest["tables"][name]
                    if set(entry["columns"]) != set(table.c.keys()):
                        raise ValueError("BACKUP_COLUMNS_INCOMPATIBLE")
                    count = 0
                    with safe_snapshot_file(source, entry["file"]).open() as stream:
                        for line in stream:
                            row = json.loads(line)
                            if set(row) != set(table.c.keys()):
                                raise ValueError("BACKUP_ROW_COLUMNS_INVALID")
                            await connection.execute(
                                table.insert().values(
                                    **{key: decode_value(value) for key, value in row.items()}
                                )
                            )
                            count += 1
                    if count != entry["rows"]:
                        raise ValueError("BACKUP_ROW_COUNT_MISMATCH")
                for table in metadata.tables.values():
                    for constraint in table.foreign_key_constraints:
                        referenced = constraint.referred_table.alias()
                        nonnull = and_(
                            *(element.parent.is_not(None) for element in constraint.elements)
                        )
                        matched = and_(
                            *(
                                referenced.c[element.column.name] == element.parent
                                for element in constraint.elements
                            )
                        )
                        orphan = (
                            select(1)
                            .select_from(table)
                            .where(
                                nonnull, ~exists(select(1).select_from(referenced).where(matched))
                            )
                            .limit(1)
                        )
                        if (await connection.execute(orphan)).first():
                            raise ValueError("BACKUP_FOREIGN_KEY_INVALID")
            finally:
                await connection.execute(text("SET FOREIGN_KEY_CHECKS=1"))
            for path, raw in material_targets.items():
                if not path.exists():
                    private_file(path, raw)
            await connection.commit()
            marker.unlink()
            directory = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if client:
            client.close()
