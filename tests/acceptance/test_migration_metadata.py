"""
通过真实迁移图验证排队校验任务迁移的英文描述仍可被 Alembic 读取，并用发布审计检查同一源码的中文说明。
"""

from collections.abc import Callable
import functools
import io
import logging
import pathlib
import shutil
from typing import cast

from alembic import command, config, script
from alembic.runtime import migration
import pytest

from tests.acceptance import comment_audit_support

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_MIGRATION_PATH = pathlib.Path("apps/srv/src/veriq_server/migrations/versions/0006_execution.py")
_DESCRIPTION = "Existing queued VALIDATE jobs retain their bytes and identity."
_REVISION = "0006_execution"
_PARENT = "0005_runtimes"
repository_fixture = comment_audit_support.repository_fixture


class _MigrationBoundaryReachedError(RuntimeError):
    """
    在离线日志写出后终止迁移步骤，确保版本记录更新以及原有升级和降级函数均没有机会运行。
    """


@pytest.fixture(name="migration_config")
def create_migration_config(tmp_path: pathlib.Path) -> config.Config:
    """
    只复制实际迁移版本文件以解析真实前后关系，脚本目录不含服务环境入口，也无需读取部署配置或凭据。
    """
    script_root = tmp_path / "migrations"
    versions = script_root / "versions"
    versions.mkdir(parents=True)
    for revision_path in (_ROOT / _MIGRATION_PATH.parent).glob("*.py"):
        shutil.copyfile(revision_path, versions / revision_path.name)

    settings = config.Config()
    settings.set_main_option("script_location", str(script_root))
    settings.set_main_option("revision_environment", "false")
    return settings


def test_migration_description_preserves_alembic_consumers(
    migration_config: config.Config, tmp_path: pathlib.Path
) -> None:
    """
    从真实脚本及版本历史核对既有英文描述，同时确认详细当前版本展示共用的格式没有改变迁移边或摘要。
    """
    directory = script.ScriptDirectory.from_config(migration_config)
    loaded = directory.get_revision(_REVISION)
    assert loaded is not None
    assert (loaded.revision, loaded.down_revision) == (_REVISION, _PARENT)
    assert loaded.module.branch_labels is None
    assert loaded.module.depends_on is None
    assert (loaded.module.__doc__, loaded.doc, loaded.longdoc) == (_DESCRIPTION,) * 3

    output = io.StringIO()
    migration_config.stdout = output
    revision_range = f"{_REVISION}:{_REVISION}"
    command.history(migration_config, revision_range, verbose=False, indicate_current=False)
    assert output.getvalue() == f"{_PARENT} -> {_REVISION}, {_DESCRIPTION}\n"

    output.seek(0)
    output.truncate()
    command.history(migration_config, revision_range, verbose=True, indicate_current=False)
    copied_path = tmp_path / "migrations" / "versions" / _MIGRATION_PATH.name
    detail = f"Rev: {_REVISION}\nParent: {_PARENT}\nPath: {copied_path}\n\n    {_DESCRIPTION}\n"
    assert output.getvalue() == detail + "\n"
    assert loaded.cmd_format(verbose=True) == detail


@pytest.mark.parametrize(
    ("direction", "starting_revision", "destination_revision"),
    [("upgrade", _PARENT, _REVISION), ("downgrade", _REVISION, _PARENT)],
)
def test_migration_description_reaches_offline_step_log(
    migration_config: config.Config,
    caplog: pytest.LogCaptureFixture,
    direction: str,
    starting_revision: str,
    destination_revision: str,
) -> None:
    """
    使用真实离线上下文记录两个方向的迁移描述，在原迁移函数入口立即中止以避免执行任何表结构操作。
    """
    directory = script.ScriptDirectory.from_config(migration_config)
    loaded = directory.get_revision(_REVISION)
    assert loaded is not None
    step = migration.RevisionStep(directory.revision_map, loaded, is_upgrade=direction == "upgrade")
    original = cast(Callable[[], None], step.migration_fn)
    assert original is getattr(loaded.module, direction)

    @functools.wraps(original)
    def stop_before_ddl() -> None:
        raise _MigrationBoundaryReachedError

    step.migration_fn = stop_before_ddl

    def select_step(
        heads: tuple[str, ...], context: migration.MigrationContext
    ) -> tuple[migration.RevisionStep, ...]:
        assert context.as_sql
        assert heads == (starting_revision,)
        return (step,)

    offline = migration.MigrationContext.configure(
        dialect_name="mysql",
        opts={
            "as_sql": True,
            "starting_rev": starting_revision,
            "output_buffer": io.StringIO(),
            "fn": select_step,
        },
    )
    logger = "alembic.runtime.migration"
    with caplog.at_level(logging.INFO, logger), pytest.raises(_MigrationBoundaryReachedError):
        offline.run_migrations()
    assert (
        logger,
        logging.INFO,
        f"Running {direction} {starting_revision} -> {destination_revision}, {_DESCRIPTION}",
    ) in caplog.record_tuples


def test_migration_description_passes_prose_audit(repository: pathlib.Path) -> None:
    """
    将当前迁移原样交给发布审计，确认两处中文说明通过正文检查且英文运行描述只增加一行代码计数。
    """
    name = _MIGRATION_PATH.as_posix()
    migration_source = (_ROOT / _MIGRATION_PATH).read_bytes().decode("utf-8")
    comment_audit_support.write_source(repository, name, migration_source)

    report = comment_audit_support.audit(repository)
    assert report["unsupportedPaths"] == []
    assert report["violations"] == []
    # 原迁移包含两行说明和四百零九行代码，显式运行元数据只应增加一行代码并保留原说明计数。
    assert report["files"] == [{"path": name, "commentLines": 2, "codeLines": 410}]
