"""VeriQ 就绪检查只在请求时检查关键依赖并复用短期结果，数据库、静态库存及存储探测分别限时，任何依赖失败都不会改变独立的
进程存活响应。
"""

import asyncio
import os
from pathlib import Path
import secrets
from hashlib import sha256
from time import monotonic
from collections.abc import Callable
from typing import Any

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from .db import Database, Installation
from .handlers.static import PublishedSite, load_published_site
from .settings import Settings


def packaged_heads() -> tuple[str, ...]:
    """从安装包旁的迁移目录读取精确版本头而非硬编码迁移文件名，备份恢复和就绪检查共享同一版本权威，
    遇到多头时由调用方明确拒绝兼容。
    """
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    return tuple(ScriptDirectory.from_config(config).get_heads())


def file_probe(root: str) -> bool:
    """通过逐级不跟随链接的目录描述符访问已有存储根，只写入独占随机探针并完整清除，既不自动创建根目录也不读取客户证据，
    从而检查真实读写及同步能力。
    """
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    name = ".veriq-readiness-" + secrets.token_hex(16)
    created = False
    try:
        for component in Path(os.path.abspath(root)).parts[1:]:
            next_directory = os.open(
                component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = next_directory
        try:
            os.stat(".veriq-restore-incomplete", dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            return False
        descriptor = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory,
        )
        created = True
        with os.fdopen(descriptor, "w+b") as stream:
            payload = b"VeriQ storage readiness\n"
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            stream.seek(0)
            valid = stream.read(len(payload) + 1) == payload
        os.unlink(name, dir_fd=directory)
        created = False
        os.fsync(directory)
        return valid
    finally:
        try:
            if created:
                os.unlink(name, dir_fd=directory)
                os.fsync(directory)
        finally:
            os.close(directory)


class ReadinessMonitor:
    """每个应用独占一个按需监视器，合并同时到达的就绪请求并保留一秒结果；阻塞工作超时后不再排队相同探针，
    防止故障依赖造成无限线程积累或过期成功复活。
    """

    def __init__(self, settings: Settings, db: Database, site: PublishedSite | None) -> None:
        """保存启动时已经校验的前端身份以及数据库句柄，后续磁盘检查必须匹配这个基线，不能把运行中的新库存自动当作同一已
        发布安装而静默接受。
        """
        self.settings, self.db, self.site = settings, db, site
        self._flight: asyncio.Task[dict[str, bool]] | None = None
        self._workers: dict[str, asyncio.Task[bool]] = {}
        self._database_worker: asyncio.Task[dict[str, bool]] | None = None
        self._result: dict[str, bool] | None = None
        self._completed = 0.0
        self._closed = False

    async def check(self) -> dict[str, bool]:
        """请求共享屏蔽取消的单次检查，只有完成时间一秒以内的结果可回用；单个客户端断开不会取消其他客户端使用的检查，
        关闭后的调用始终返回全部依赖不可用。
        """
        if self._closed:
            return dict.fromkeys(("database", "mysqlVersion", "schema", "static", "storage"), False)
        if self._result is not None and monotonic() - self._completed < 1:
            return dict(self._result)
        if self._flight is None or self._flight.done():
            self._flight = asyncio.create_task(self._check())
        return dict(await asyncio.shield(self._flight))

    async def _database(self) -> dict[str, bool]:
        result = {"database": False, "mysqlVersion": False, "schema": False}
        try:
            async with asyncio.timeout(1):
                async with self.db.engine.connect() as connection:
                    await connection.execute(text("SELECT 1"))
                    result["database"] = True
                    version = str((await connection.execute(text("SELECT VERSION()"))).scalar_one())
                    result["mysqlVersion"] = (
                        version.startswith("8.4.") and "mariadb" not in version.lower()
                    )
                    heads = packaged_heads()
                    current = await connection.run_sync(
                        lambda conn: MigrationContext.configure(
                            conn, opts={"version_table": "veriq_alembic_version"}
                        ).get_current_heads()
                    )
                    installed = (
                        await connection.execute(
                            select(Installation.id).where(Installation.id == 1)
                        )
                    ).first()
                    result["schema"] = (
                        len(heads) == 1 and set(heads) == set(current) and installed is not None
                    )
        except (SQLAlchemyError, TimeoutError):
            pass
        return result

    def _static(self) -> bool:
        if self.settings.environment == "development":
            return True
        current = load_published_site(self.settings)
        return (
            current is not None
            and self.site is not None
            and (
                current.build_info == self.site.build_info
                and current.public_files == self.site.public_files
            )
        )

    def _storage(self) -> bool:
        if (Path(self.settings.artifact_directory) / ".veriq-restore-incomplete").exists():
            return False
        if self.settings.artifact_backend == "FILE":
            return file_probe(self.settings.artifact_directory)
        config = self.settings
        if not config.artifact_s3_bucket or config.readiness_s3_strategy == "disabled":
            return False
        import boto3
        from botocore.config import Config as S3Config

        client = boto3.client(
            "s3",
            endpoint_url=config.artifact_s3_endpoint,
            region_name=config.artifact_s3_region,
            config=S3Config(
                connect_timeout=0.5, read_timeout=0.5, retries={"total_max_attempts": 1}
            ),
        )
        try:
            if config.readiness_s3_strategy == "head-bucket":
                client.head_bucket(Bucket=config.artifact_s3_bucket)
                return True
            # 读对象策略校验要求对象键；若绕过校验且键为 None，跳过对象请求并通过下方清理关闭客户端。
            object_key = config.readiness_s3_object_key
            if object_key is None:
                return False
            response = client.get_object(Bucket=config.artifact_s3_bucket, Key=object_key)
            body = response["Body"]
            try:
                payload = body.read(config.readiness_s3_object_size + 1)
                return (
                    len(payload) == config.readiness_s3_object_size
                    and sha256(payload).hexdigest() == config.readiness_s3_object_sha256
                )
            finally:
                body.close()
        finally:
            client.close()

    async def _blocking(self, name: str, function: Callable[[], bool]) -> bool:
        previous = self._workers.get(name)
        if previous is not None:
            if not previous.done():
                return False
            previous.result()

        async def work() -> bool:
            try:
                return bool(await asyncio.to_thread(function))
            except (OSError, ValueError):
                return False
            except Exception as error:
                from botocore.exceptions import BotoCoreError, ClientError

                if isinstance(error, (BotoCoreError, ClientError)):
                    return False
                raise

        worker = asyncio.create_task(work())
        self._workers[name] = worker
        try:
            async with asyncio.timeout(2):
                return await asyncio.shield(worker)
        except TimeoutError:
            return False

    async def _check(self) -> dict[str, bool]:
        defaults = {"database": False, "mysqlVersion": False, "schema": False}
        if self._database_worker is None or self._database_worker.done():
            if self._database_worker is not None:
                self._database_worker.result()
            self._database_worker = asyncio.create_task(self._database())
            database_task = self._database_worker
        else:
            database_task = None
        static_task = asyncio.create_task(self._blocking("static", self._static))
        storage_task = asyncio.create_task(self._blocking("storage", self._storage))
        tasks: set[asyncio.Task[Any]] = {static_task, storage_task}
        if database_task:
            tasks.add(database_task)
        done, pending = await asyncio.wait(tasks, timeout=3)
        database = database_task.result() if database_task in done else defaults
        static = static_task.result() if static_task in done else False
        storage = storage_task.result() if storage_task in done else False
        for task in pending:
            if task is not database_task:
                task.cancel()
        self._result = {**database, "static": static, "storage": storage}
        self._completed = monotonic()
        return self._result

    async def close(self) -> None:
        """停止接收新就绪检查并等待本应用已经拥有的检查和阻塞工作释放描述符，线程中的文件系统或凭据发现无法被强行终止，
        因此关闭过程不承诺硬终止内核调用。
        """
        self._closed = True
        if self._flight:
            await asyncio.gather(self._flight, return_exceptions=True)
        if self._database_worker:
            await asyncio.gather(self._database_worker, return_exceptions=True)
        await asyncio.gather(*self._workers.values(), return_exceptions=True)
