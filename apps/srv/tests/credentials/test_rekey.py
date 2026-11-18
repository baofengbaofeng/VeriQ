"""
通过专用数据库验证历史主密钥重封装的批次回执与持久化结果，密钥和业务明文均使用合成输入。
"""

from collections.abc import AsyncIterator, Iterator
import contextlib
import dataclasses
import datetime
import json
import os
import pathlib
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from typing import TypeAlias

from cryptography import exceptions
import httpx
import pydantic
import pytest
import sqlalchemy
from sqlalchemy import orm
from sqlalchemy.ext import asyncio as sqlalchemy_asyncio

from veriq_server import db, rekey, settings
from veriq_server.credentials import crypto, service as credential_service
from veriq_server.services import ai

_Site: TypeAlias = tuple[httpx.AsyncClient, db.Database]
_EncryptedRow: TypeAlias = db.SecretVersion | db.AiProvider
_WORKSPACE_A = "00000000-0000-4000-8000-000000000001"
_WORKSPACE_B = "00000000-0000-4000-8000-000000000002"
_SECRET_REF = "synthetic-rekey-ref"
_IDENTITY = "00000000-0000-4000-8000-000000000003"
_SECRET_IDS = (
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
    "00000000-0000-4000-8000-000000000013",
    "00000000-0000-4000-8000-000000000014",
)
_PROVIDER_IDS = (
    "00000000-0000-4000-8000-000000000021",
    "00000000-0000-4000-8000-000000000022",
    "00000000-0000-4000-8000-000000000023",
)
_PROVIDER_VERSIONS = (
    "00000000-0000-4000-8000-000000000031",
    "00000000-0000-4000-8000-000000000032",
    "00000000-0000-4000-8000-000000000033",
)
_FIXED_TIME = datetime.datetime(2026, 1, 2, 3, 4, 5, 123456)
_CREDENTIAL_VALUE = {"username": "synthetic-rekey-user", "password": "synthetic-rekey-password"}
_PROVIDER_VALUE = "synthetic-rekey-provider-value"
_FAKE_DSN = "mysql+asyncmy://synthetic-rekey-user:synthetic-rekey-dsn-password@invalid.invalid/test"
_OLD_A = "A1" * 32
_OLD_B = "b2" * 32
_NEXT = "c3" * 32
_SIGNING = "d4" * 32
_HISTORY = {"old-a": _OLD_A, "old-b": _OLD_B}


def _settings(
    key_id: str, master_key: str, previous: dict[str, str] | None = None
) -> settings.Settings:
    return settings.Settings.model_validate(
        {
            "database_url": _FAKE_DSN,
            "public_url": "https://synthetic-veriq.invalid",
            "master_key_id": key_id,
            "master_key": master_key,
            "previous_master_keys": previous or {},
            "signing_key": _SIGNING,
            "session_hours": 19,
        }
    )


@contextlib.asynccontextmanager
async def _workspaces(database: db.Database, *workspace_ids: str) -> AsyncIterator[None]:
    """
    在专用测试库中为指定工作区建立父行与凭据引用，先提交这些行供用例写入归属明确的合成密文。

    上下文退出时只清理给定标识下的凭据版本、供应商及引用，再按外键顺序删除工作区父行。
    """
    async with database.sessions.begin() as session:
        for workspace_id in workspace_ids:
            session.add(
                db.Workspace(
                    id=workspace_id,
                    key=f"synthetic-rekey-{workspace_id[-1]}",
                    name="Synthetic rekey workspace",
                    archived=False,
                    created_at=_FIXED_TIME,
                )
            )
        await session.flush()
        for workspace_id in workspace_ids:
            session.add(
                db.SecretRef(workspace_id=workspace_id, key=_SECRET_REF, created_at=_FIXED_TIME)
            )
    try:
        yield
    finally:
        async with database.sessions.begin() as session:
            for model in (db.SecretVersion, db.AiProvider, db.SecretRef):
                await session.execute(
                    sqlalchemy.delete(model).where(model.workspace_id.in_(workspace_ids))
                )
            await session.execute(
                sqlalchemy.delete(db.Workspace).where(db.Workspace.id.in_(workspace_ids))
            )


def _secret(
    key_settings: settings.Settings, workspace_id: str, row_id: str, *, revoked: bool = False
) -> db.SecretVersion:
    ring = credential_service.configured_keyring(key_settings)
    sealed = ring.encrypt(workspace_id, _SECRET_REF, row_id, _CREDENTIAL_VALUE)
    return db.SecretVersion(
        id=row_id,
        workspace_id=workspace_id,
        secret_ref=_SECRET_REF,
        key_id=sealed.key_id,
        nonce=sealed.nonce,
        ciphertext=sealed.ciphertext,
        allowed_identity_ids=[_IDENTITY],
        revoked=revoked,
        created_at=_FIXED_TIME,
    )


def _provider(
    key_settings: settings.Settings, workspace_id: str, row_id: str, *, deleted: bool = False
) -> db.AiProvider:
    version = _PROVIDER_VERSIONS[_PROVIDER_IDS.index(row_id)]
    ring = credential_service.configured_keyring(key_settings, purpose=ai.PURPOSE)
    sealed = ring.encrypt(workspace_id, row_id, version, _PROVIDER_VALUE)
    return db.AiProvider(
        id=row_id,
        workspace_id=workspace_id,
        revision=7,
        config={
            "name": "Synthetic provider",
            "adapter": "OPENAI_COMPATIBLE",
            "baseURL": "https://synthetic-provider.invalid/v1",
            "model": "synthetic-rekey-model",
            "monthlyBudgetUsd": 1,
            "inputUsdPerMillion": 1,
            "outputUsdPerMillion": 2,
            "maxOutputTokens": 1024,
            "maxRequestUsd": 1,
        },
        enabled=not deleted,
        deleted=deleted,
        key_version=version,
        key_id=sealed.key_id,
        nonce=sealed.nonce,
        ciphertext=sealed.ciphertext,
    )


def _envelope(row: _EncryptedRow) -> crypto.EncryptedValue:
    return crypto.EncryptedValue(row.key_id, row.nonce, row.ciphertext)


async def _provider_comparison(session: sqlalchemy_asyncio.AsyncSession) -> tuple[str, bool]:
    collation, equal = (
        await session.execute(
            sqlalchemy.select(
                sqlalchemy.func.collation(db.AiProvider.key_id), db.AiProvider.key_id == "old"
            ).where(db.AiProvider.id == _PROVIDER_IDS[0])
        )
    ).one()
    return str(collation), bool(equal)


async def test_rekey_case_sensitive_key_ids(site: _Site) -> None:
    """
    先核对数据库对历史标识的比较结果，再用两次真实批次确认大小写不同的旧密钥不会被候选或待处理查询漏掉。
    """
    database = site[1]
    historical = _settings("Old", _OLD_A)
    rotated = _settings("old", _NEXT, {"Old": _OLD_A})
    async with _workspaces(database, _WORKSPACE_A):
        async with database.sessions.begin() as session:
            session.add(_secret(historical, _WORKSPACE_A, _SECRET_IDS[0]))
            session.add(_provider(historical, _WORKSPACE_A, _PROVIDER_IDS[0]))
        async with database.sessions() as session:
            collation, equal = await _provider_comparison(session)
        assert collation and collation.isascii()
        print(f"Provider key_id collation: {collation}; SQL Old = old: {equal}")
        first = await rekey.rekey(database, rotated, services_stopped=True, limit=1)
        second = await rekey.rekey(database, rotated, services_stopped=True, limit=1)
        assert (first, second) == (
            {"processedCount": 1, "hasMore": True, "activeKeyId": "old"},
            {"processedCount": 1, "hasMore": False, "activeKeyId": "old"},
        )
        print(
            f"Rekey Old/old receipts: {first['processedCount']} {first['hasMore']}, "
            f"{second['processedCount']} {second['hasMore']}"
        )
        async with database.sessions() as session:
            provider = await session.get(db.AiProvider, _PROVIDER_IDS[0])
            secret = await session.get(db.SecretVersion, _SECRET_IDS[0])
        assert provider is not None and secret is not None
        assert (secret.key_id, provider.key_id) == ("old", "old")
        assert (secret.workspace_id, secret.secret_ref, secret.id) == (
            _WORKSPACE_A,
            _SECRET_REF,
            _SECRET_IDS[0],
        )
        assert (provider.workspace_id, provider.id, provider.key_version) == (
            _WORKSPACE_A,
            _PROVIDER_IDS[0],
            _PROVIDER_VERSIONS[0],
        )
        _assert_plaintexts((secret, provider), _settings("old", _NEXT))


@dataclasses.dataclass(frozen=True)
class _RowState:
    metadata: tuple[object, ...]
    envelope: crypto.EncryptedValue


def _row_state(row: _EncryptedRow) -> _RowState:
    metadata: tuple[object, ...]
    if isinstance(row, db.SecretVersion):
        metadata = (
            row.workspace_id,
            row.id,
            row.secret_ref,
            tuple(row.allowed_identity_ids),
            row.revoked,
            row.created_at,
        )
    else:
        metadata = (
            row.workspace_id,
            row.id,
            row.key_version,
            row.revision,
            row.config,
            row.enabled,
            row.deleted,
        )
    return _RowState(metadata, _envelope(row))


async def _all_rows(database: db.Database) -> tuple[_EncryptedRow, ...]:
    async with database.sessions() as session:
        credential_rows = await session.scalars(
            sqlalchemy.select(db.SecretVersion).order_by(db.SecretVersion.id)
        )
        provider_rows = await session.scalars(
            sqlalchemy.select(db.AiProvider).order_by(db.AiProvider.id)
        )
        return (*credential_rows, *provider_rows)


def _snapshot(rows: tuple[_EncryptedRow, ...]) -> dict[str, _RowState]:
    return {row.id: _row_state(row) for row in rows}


def _assert_plaintexts(rows: tuple[_EncryptedRow, ...], key_settings: settings.Settings) -> None:
    credential_ring = credential_service.configured_keyring(key_settings)
    provider_ring = credential_service.configured_keyring(key_settings, purpose=ai.PURPOSE)
    for row in rows:
        if isinstance(row, db.SecretVersion):
            value = credential_ring.decrypt(
                row.workspace_id, row.secret_ref, row.id, _envelope(row)
            )
            if value != _CREDENTIAL_VALUE:
                raise AssertionError("Credential plaintext changed during rekey")
        else:
            value = provider_ring.decrypt(row.workspace_id, row.id, row.key_version, _envelope(row))
            if value != _PROVIDER_VALUE:
                raise AssertionError("Provider plaintext changed during rekey")


def _assert_rewrapped(old: crypto.EncryptedValue, new: crypto.EncryptedValue) -> None:
    assert new.key_id == "next"
    if old.nonce == new.nonce or old.ciphertext == new.ciphertext:
        raise AssertionError("Rewrapped envelope must have a fresh nonce and ciphertext")


def _assert_same_rows(actual: dict[str, _RowState], expected: dict[str, _RowState]) -> None:
    if actual != expected:
        raise AssertionError("Persisted row metadata or envelope bytes changed")


def _current_only(rotated: settings.Settings) -> settings.Settings:
    return _settings(rotated.master_key_id, rotated.master_key.get_secret_value())


async def _seed_batch_matrix(database: db.Database, rotated: settings.Settings) -> None:
    old_a = _settings("old-a", _OLD_A)
    old_b = _settings("old-b", _OLD_B)
    async with database.sessions.begin() as session:
        session.add_all(
            [
                _secret(old_a, _WORKSPACE_A, _SECRET_IDS[0]),
                _secret(old_b, _WORKSPACE_B, _SECRET_IDS[1], revoked=True),
                _secret(old_a, _WORKSPACE_B, _SECRET_IDS[2]),
                _secret(rotated, _WORKSPACE_A, _SECRET_IDS[3]),
                _provider(old_b, _WORKSPACE_A, _PROVIDER_IDS[0], deleted=True),
                _provider(old_a, _WORKSPACE_B, _PROVIDER_IDS[1]),
                _provider(rotated, _WORKSPACE_B, _PROVIDER_IDS[2]),
            ]
        )


async def _assert_batch(
    database: db.Database,
    rotated: settings.Settings,
    expected: tuple[int, bool],
) -> None:
    count, has_more = expected
    assert await rekey.rekey(database, rotated, services_stopped=True, limit=2) == {
        "processedCount": count,
        "hasMore": has_more,
        "activeKeyId": "next",
    }


async def _verify_batch_changes(
    database: db.Database, rotated: settings.Settings, before: dict[str, _RowState]
) -> None:
    """
    用每批提交后的数据库快照核对剩余密钥标识与信封变化，同时检查所有行的身份及策略字段是否保持一致。

    每轮把新快照作为下一批的基准，已轮换的行也因此必须保留上一批写入的信封字节。
    """
    for count, has_more, pending in (
        (2, True, (_SECRET_IDS[2], _PROVIDER_IDS[0], _PROVIDER_IDS[1])),
        (2, True, (_PROVIDER_IDS[1],)),
        (1, False, ()),
    ):
        await _assert_batch(database, rotated, (count, has_more))
        state = _snapshot(await _all_rows(database))
        assert tuple(row_id for row_id, row in state.items() if row.envelope.key_id != "next") == (
            pending
        )
        assert state.keys() == before.keys()
        for row_id, row in state.items():
            original = before[row_id]
            assert original.metadata == row.metadata
            if original.envelope.key_id == "next" or row_id in pending:
                if original.envelope != row.envelope:
                    raise AssertionError("An untouched envelope changed during rekey")
            else:
                _assert_rewrapped(original.envelope, row.envelope)
        before = state


async def test_rekey_batches_preserve_identities_and_replay(
    site: _Site, rekey_private_path: pathlib.Path
) -> None:
    """
    跨工作区与历史密钥逐批重封装，并通过重新读取的记录验证撤销状态、身份、引用与当前密钥控制行保持不变。
    """
    database = site[1]
    output = rekey_private_path / "rotated.json"
    rekey.rotate_configuration(_settings("old-a", _OLD_A, {"old-b": _OLD_B}), output, "next")
    rotated = _read_private_config(output)
    _assert_history(rotated)
    async with _workspaces(database, _WORKSPACE_A, _WORKSPACE_B):
        await _seed_batch_matrix(database, rotated)
        original = await _all_rows(database)
        assert tuple(row.key_id for row in original) == (
            "old-a",
            "old-b",
            "old-a",
            "next",
            "old-b",
            "old-a",
            "next",
        )
        _assert_plaintexts(original, rotated)
        await _verify_batch_changes(database, rotated, _snapshot(original))
        final_rows = await _all_rows(database)
        _assert_plaintexts(final_rows, _current_only(rotated))
        await _assert_batch(database, rotated, (0, False))
        _assert_same_rows(_snapshot(await _all_rows(database)), _snapshot(final_rows))


async def _seed_failure(database: db.Database, fault: str) -> crypto.EncryptedValue:
    """
    为回滚用例写入两个可解密的旧凭据版本，并按故障类型选择原样、损坏或绑定错误版本的供应商信封。

    返回供应商的完整原信封，以便重试前还原被改动的随机数和密文字节。缺密钥用例只改变重封装时的配置。
    """
    old_a = _settings("old-a", _OLD_A)
    old_b = _settings("old-b", _OLD_B)
    provider = _provider(old_b, _WORKSPACE_B, _PROVIDER_IDS[0])
    original = _envelope(provider)
    if fault == "ciphertext":
        provider.ciphertext = bytes([original.ciphertext[0] ^ 1]) + original.ciphertext[1:]
    if fault == "wrong-aad":
        ring = credential_service.configured_keyring(old_b, purpose=ai.PURPOSE)
        wrong_aad = ring.encrypt(_WORKSPACE_B, provider.id, _PROVIDER_VERSIONS[1], _PROVIDER_VALUE)
        provider.nonce, provider.ciphertext = wrong_aad.nonce, wrong_aad.ciphertext
    async with database.sessions.begin() as session:
        session.add_all(
            [
                _secret(old_a, _WORKSPACE_A, _SECRET_IDS[0]),
                _secret(old_a, _WORKSPACE_A, _SECRET_IDS[1]),
                provider,
            ]
        )
    return original


@contextlib.contextmanager
def _observe_secret_flushes() -> Iterator[list[tuple[str, str]]]:
    flushed: list[tuple[str, str]] = []

    def after_flush(session: orm.Session, flush_context: orm.UOWTransaction) -> None:
        # 回调只读取实际已经刷新的凭据行，忽略工作单元内部数据，以验证数据库写入在供应商解密失败前发生。
        del flush_context
        flushed.extend(
            (row.id, row.key_id) for row in session.dirty if isinstance(row, db.SecretVersion)
        )

    sqlalchemy.event.listen(orm.Session, "after_flush", after_flush)
    try:
        yield flushed
    finally:
        sqlalchemy.event.remove(orm.Session, "after_flush", after_flush)


async def _assert_failed_batch(database: db.Database, fault: str) -> None:
    if fault == "missing-key":
        invalid = _settings("next", _NEXT, {"old-a": _OLD_A})
        with pytest.raises(ValueError, match=r"^KEY_UNAVAILABLE$"):
            await rekey.rekey(database, invalid, services_stopped=True, limit=2)
    else:
        rotated = _settings("next", _NEXT, _HISTORY)
        with pytest.raises(exceptions.InvalidTag):
            await rekey.rekey(database, rotated, services_stopped=True, limit=2)


async def _repair_provider(database: db.Database, original: crypto.EncryptedValue) -> None:
    async with database.sessions.begin() as session:
        provider = await session.get(db.AiProvider, _PROVIDER_IDS[0])
        assert provider is not None
        provider.nonce, provider.ciphertext = original.nonce, original.ciphertext


@pytest.mark.parametrize("fault", ("missing-key", "ciphertext", "wrong-aad"))
async def test_rekey_failed_batch_is_atomic(site: _Site, fault: str) -> None:
    """
    让供应商解密在同批凭据实际写入后失败，验证数据库回滚当批全部变更，同时保留此前已提交的密文。
    """
    database = site[1]
    rotated = _settings("next", _NEXT, _HISTORY)
    async with _workspaces(database, _WORKSPACE_A, _WORKSPACE_B):
        original = await _seed_failure(database, fault)
        assert await rekey.rekey(database, rotated, services_stopped=True, limit=1) == {
            "processedCount": 1,
            "hasMore": True,
            "activeKeyId": "next",
        }
        before = _snapshot(await _all_rows(database))
        assert tuple(row.envelope.key_id for row in before.values()) == ("next", "old-a", "old-b")
        with _observe_secret_flushes() as flushed:
            await _assert_failed_batch(database, fault)
        assert flushed == [(_SECRET_IDS[1], "next")]
        _assert_same_rows(_snapshot(await _all_rows(database)), before)
        if fault != "missing-key":
            await _repair_provider(database, original)
        await _assert_batch(database, rotated, (2, False))
        rows = await _all_rows(database)
        _assert_plaintexts(rows, _current_only(rotated))
        final = _snapshot(rows)
        _assert_same_rows(
            {_SECRET_IDS[0]: final[_SECRET_IDS[0]]}, {_SECRET_IDS[0]: before[_SECRET_IDS[0]]}
        )
        _assert_rewrapped(before[_SECRET_IDS[1]].envelope, final[_SECRET_IDS[1]].envelope)
        _assert_rewrapped(original, final[_PROVIDER_IDS[0]].envelope)


@pytest.fixture(name="rekey_private_path")
def _private_path(tmp_path: pathlib.Path) -> Iterator[pathlib.Path]:
    with tempfile.TemporaryDirectory(dir=tmp_path) as directory:
        yield pathlib.Path(directory)


def _read_private_config(path: pathlib.Path) -> settings.Settings:
    try:
        return settings.Settings.model_validate_json(path.read_bytes())
    except (OSError, pydantic.ValidationError):
        raise AssertionError("Rotation did not produce valid private settings") from None


def _assert_history(rotated: settings.Settings) -> None:
    assert rotated.master_key_id == "next"
    keys = {
        key_id: value.get_secret_value() for key_id, value in rotated.previous_master_keys.items()
    }
    if keys != _HISTORY:
        raise AssertionError("Rotation did not preserve exact historical key IDs and bytes")


_CLI_SUCCESS = (
    b"VeriQ key rotation configuration created. Keep previous keys and switch configuration "
    b"before rekeying.\n"
)
_CLI_FAILURE = b"VeriQ command failed. Check configuration, file permissions and command inputs.\n"
_CLI_CAPTURE_LIMIT = 65536
_CLI_TIMEOUT = 10
_NETWORK_GUARD = """\
import os
import pathlib
import sys

def block_network(event, arguments):
    # 审计回调只根据事件名称阻止连接，忽略事件参数以免将地址或连接相关的原始数据写入尝试记录。
    del arguments
    if event in {"socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "socket.sendto"}:
        try:
            pathlib.Path(__file__).with_name("network-attempted").touch()
        finally:
            os._exit(97)

sys.addaudithook(block_network)
pathlib.Path(__file__).with_name("guard-ready").touch()
"""


def _assert_no_cli_material(result: subprocess.CompletedProcess[bytes], *new_keys: str) -> None:
    combined = result.stdout + result.stderr
    markers = (
        _FAKE_DSN,
        "synthetic-rekey-user",
        "synthetic-rekey-dsn-password",
        *_HISTORY.values(),
        _SIGNING,
        *_CREDENTIAL_VALUE.values(),
        _PROVIDER_VALUE,
        *new_keys,
        '"database_url"',
        '"master_key"',
        '"previous_master_keys"',
        "Traceback (most recent call last)",
    )
    if any(marker.encode() in combined for marker in markers):
        raise AssertionError("CLI printed private configuration material or a raw traceback")


def _capture_cli(child: subprocess.Popen[bytes]) -> tuple[bytes, bytes]:
    """
    从已启动子进程的两条管道收集原始字节，读至双方关闭后按标准输出、标准错误的顺序返回两个私有字节串。

    超时或超限时抛出固定内容的断言错误。选择器在此关闭，管道和子进程由调用方负责回收。
    """
    stdout, stderr = bytearray(), bytearray()
    deadline = time.monotonic() + _CLI_TIMEOUT
    assert child.stdout is not None and child.stderr is not None
    with selectors.DefaultSelector() as selection:
        # 同时排空标准输出和标准错误，防止一条管道先写满并阻塞子进程，导致另一条管道一直等不到关闭。
        # 两路共用总字节预算和截止时间，失败诊断采用固定文本，避免将尚未检查的原始字节写入日志。
        selection.register(child.stdout, selectors.EVENT_READ, stdout)
        selection.register(child.stderr, selectors.EVENT_READ, stderr)
        while selection.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("CLI output did not close in time")
            for ready in selection.select(remaining):
                key = ready[0]
                block = os.read(key.fd, 8192)
                if not block:
                    selection.unregister(key.fileobj)
                else:
                    key.data.extend(block)
                    if len(stdout) + len(stderr) > _CLI_CAPTURE_LIMIT:
                        raise AssertionError("CLI output exceeded the private capture limit")
    return bytes(stdout), bytes(stderr)


def _run_cli(config: pathlib.Path, *arguments: str) -> subprocess.CompletedProcess[bytes]:
    """
    以私有配置路径和命令参数启动独立的模块入口，通过最小子进程环境和审计钩子限制本地合成验证。

    返回捕获结果前先检查已知合成私密标记、钩子启动确认和零连接尝试。捕获或守卫失败以断言结束。
    超时或捕获失败时终止仍在运行的子进程。退出前等待子进程结束、关闭管道并移除临时守卫目录。
    """
    command = [sys.executable, "-B", "-m", "veriq_server", "--config", str(config), *arguments]
    with tempfile.TemporaryDirectory(dir=config.parent) as directory:
        guard_directory = pathlib.Path(directory)
        # 由新解释器在模块入口前安装审计钩子，任何联网尝试立即退出，防止通用错误掩盖提前打开数据库连接。
        (guard_directory / "sitecustomize.py").write_text(_NETWORK_GUARD, encoding="utf-8")
        environment = {
            "PYTHONPATH": directory,
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        with subprocess.Popen(
            command,
            cwd=config.parent,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as child:
            try:
                stdout, stderr = _capture_cli(child)
                status = child.wait(timeout=_CLI_TIMEOUT)
            except subprocess.TimeoutExpired:
                raise AssertionError("CLI did not exit in time") from None
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=_CLI_TIMEOUT)
        result = subprocess.CompletedProcess(command, status, stdout, stderr)
        _assert_no_cli_material(result)
        assert (guard_directory / "guard-ready").is_file()
        network_attempted = (guard_directory / "network-attempted").exists()
        assert result.returncode != 97 and not network_attempted, "CLI tried to open a connection"
        return result


def _synthetic_cli_config(directory: pathlib.Path) -> tuple[pathlib.Path, bytes]:
    original = _settings("old-a", _OLD_A, {"old-b": _OLD_B})
    source = directory / "source.json"
    raw = json.dumps(settings.operator_config_values(original.model_dump()), indent=2).encode()
    descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(raw)
    return source, raw


def _assert_rotation_output(
    original: settings.Settings, output: pathlib.Path, result: subprocess.CompletedProcess[bytes]
) -> bytes:
    rotated = _read_private_config(output)
    key = rotated.master_key.get_secret_value()
    _assert_no_cli_material(result, key)
    if (result.returncode, result.stdout, result.stderr) != (0, _CLI_SUCCESS, b""):
        raise AssertionError("Rotation returned an unexpected CLI receipt")
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    _assert_history(rotated)
    rotation_fields = {"master_key", "master_key_id", "previous_master_keys"}
    if rotated.model_dump(exclude=rotation_fields) != original.model_dump(exclude=rotation_fields):
        raise AssertionError("Rotation changed other effective settings or the signing key")
    decoded = bytes.fromhex(key)
    assert len(decoded) == 32
    if decoded in tuple(bytes.fromhex(value) for value in (*_HISTORY.values(), _SIGNING)):
        raise AssertionError("Rotation reused existing key material")
    return decoded


def _assert_source_unchanged(source: pathlib.Path, raw: bytes) -> None:
    if source.read_bytes() != raw:
        raise AssertionError("CLI changed the original private configuration bytes")


def _assert_generic_failure(result: subprocess.CompletedProcess[bytes]) -> None:
    if (result.returncode, result.stdout, result.stderr) != (1, b"", _CLI_FAILURE):
        raise AssertionError("CLI refusal did not use its generic configuration error")


def test_rotate_master_key_writes_private_keyring(rekey_private_path: pathlib.Path) -> None:
    """
    直接运行模块入口生成独立的私有配置，检查历史密钥与其它设置的保留情况，并用两次轮换检验新密钥随机生成。
    """
    source, raw = _synthetic_cli_config(rekey_private_path)
    original = _read_private_config(source)
    keys = []
    for filename in ("next.json", "separate.json"):
        output = rekey_private_path / filename
        result = _run_cli(
            source, "rotate-master-key", "--new-key-id", "next", "--output", str(output)
        )
        keys.append(_assert_rotation_output(original, output, result))
        _assert_source_unchanged(source, raw)
    if keys[0] == keys[1]:
        raise AssertionError("Independent rotations produced the same new key")


@pytest.mark.parametrize(
    "new_id,existing",
    (
        pytest.param("old-a", False, id="current-id"),
        pytest.param("old-b", False, id="historical-id"),
        pytest.param("next", True, id="existing-output"),
    ),
)
def test_rotate_master_key_refuses_conflicts(
    rekey_private_path: pathlib.Path, new_id: str, existing: bool
) -> None:
    """
    分别拒绝当前标识、历史标识和已存在的输出目标，并逐字节检查拒绝路径没有覆盖任何操作员私有配置。
    """
    source, raw = _synthetic_cli_config(rekey_private_path)
    output = rekey_private_path / "next.json"
    existing_bytes = b"synthetic-existing-output\x00\n"
    if existing:
        output.write_bytes(existing_bytes)
    result = _run_cli(source, "rotate-master-key", "--new-key-id", new_id, "--output", str(output))
    _assert_generic_failure(result)
    _assert_source_unchanged(source, raw)
    if existing:
        assert output.read_bytes() == existing_bytes
    else:
        assert not output.exists()


@pytest.mark.parametrize(
    "arguments",
    (
        pytest.param(("--limit", "1"), id="no-stop"),
        pytest.param(("--services-stopped", "--limit", "0"), id="zero-limit"),
        pytest.param(("--services-stopped", "--limit", "1001"), id="large-limit"),
    ),
)
def test_rekey_requires_quiescence_and_bounded_limit(
    rekey_private_path: pathlib.Path, arguments: tuple[str, ...]
) -> None:
    """
    在禁止外连的独立解释器中核对停机声明和批次上下限，缺少声明或超出范围均须在打开数据库连接前拒绝。
    """
    source, raw = _synthetic_cli_config(rekey_private_path)
    _assert_generic_failure(_run_cli(source, "rekey", *arguments))
    _assert_source_unchanged(source, raw)
