"""
使用真实静态库存与最小私有快照验证恢复前置门禁，并在任何数据库驱动建立连接之前记录第一次访问企图。

快照、配置和外置材料均来自当前测试的临时目录，归档的独立确认摘要只覆盖最终写入的清单字节。
"""

import dataclasses
import datetime
import decimal
import hashlib
import json
import os
import pathlib
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import AsyncIterator
from typing import Any, Never

import pytest
from sqlalchemy import event

import veriq_server
from veriq_server import db, readiness, recovery, settings, snapshot_io
from veriq_server.handlers import static

_DSN = "mysql+asyncmy://synthetic-recovery:synthetic-recovery-password@db.invalid/veriq_synthetic"
_ACTIVE = "13" * 32
_HISTORY = "26" * 32
_SIGNING = "39" * 32
_DIFFERENT = "47" * 32
_ARTIFACT = "file-artifacts/example/payload.bin"
_ARTIFACT_BYTES = b"synthetic FILE payload\x00"
_HEAD_FILE = "tables/veriq_alembic_version.jsonl"
_MATERIAL_BYTES = b"synthetic issuer material\n"


@dataclasses.dataclass(frozen=True)
class _RecoveryCase:
    """
    保存一次恢复的源、目标配置和独立收据，变体只替换被测输入并仍通过相同的公开恢复入口运行。
    """

    source: pathlib.Path
    target: settings.Settings
    configuration: pathlib.Path
    digest: str


class _DatabaseAccessError(RuntimeError):
    """
    标记恢复已经触及数据库连接边界，测试借此区分目标前置拒绝与真正即将要求数据库服务的路径。
    """


@dataclasses.dataclass
class _DatabaseTrap:
    """
    在 SQLAlchemy 调用真实驱动之前记录连接次数，随后抛出固定错误，调用方始终不能拿到连接或查询结果。
    """

    database: db.Database
    attempts: int = 0

    def refuse_connection(
        self, dialect: object, record: object, args: object, kwargs: object
    ) -> Never:
        """
        记录恢复逻辑跨过全部本地校验后的连接企图，并抛出仅含固定哨兵的异常，阻止驱动执行网络或数据库操作。
        """
        # 回调签名由 SQLAlchemy 连接事件确定，丢弃驱动参数以免密码进入任何诊断或连接计数。
        del dialect, record, args, kwargs
        self.attempts += 1
        raise _DatabaseAccessError("SYNTHETIC_DB_ACCESS_ATTEMPT")


def _refuse_s3_client(configuration: settings.Settings) -> Never:
    """
    这些快照只含普通制品，本地门禁若意外创建对象存储客户端应立即失败，避免凭据发现或任何服务调用。
    """
    # 客户端边界收到的配置不会被读取，删除引用以保证该意外路径只留下固定的断言失败说明。
    del configuration
    raise AssertionError("Recovery accessed the S3 client during a local-only check")


@pytest.fixture(name="database_trap")
async def _database_trap(
    recovery_case: _RecoveryCase, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[_DatabaseTrap]:
    """
    从专用测试配置建立真实惰性引擎并安装驱动前哨兵，退出夹具时关闭引擎并移除只在当前用例生效的监听器。
    """
    database = db.Database(recovery_case.target)
    trap = _DatabaseTrap(database)
    monkeypatch.setattr(recovery, "s3_client", _refuse_s3_client)
    event.listen(database.engine.sync_engine, "do_connect", trap.refuse_connection)
    try:
        yield trap
    finally:
        event.remove(database.engine.sync_engine, "do_connect", trap.refuse_connection)
        await database.close()


def _config_bytes(configuration: settings.Settings) -> bytes:
    """
    复用真实配置序列化保留数据库地址与密钥字节，返回值只写入当前用例独占的私有文件并用于摘要验证。
    """
    return (json.dumps(settings.operator_config_values(configuration.model_dump())) + "\n").encode()


def _head_bytes(head: str) -> bytes:
    """
    用一个独立指定的带标签列值构造迁移表的单行载荷，归档头变体可以在重新确认完整性后单独验证列值。
    """
    return (json.dumps({"version_num": {"kind": "json", "value": head}}) + "\n").encode()


def _identity(raw: bytes) -> dict[str, str | int]:
    """
    返回独立读取的载荷字节大小及摘要，让收据与归档验证都以落盘字节为准，替换内容时可显式保留或更新确认信息。
    """
    return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def _write_manifest(source: pathlib.Path, manifest: dict[str, Any]) -> str:
    """
    在所有载荷落盘后写入清单，并从保存的原始字节返回独立摘要，变体更新清单时也采用相同的格式。
    """
    path = source / "manifest.json"
    path.unlink(missing_ok=True)
    snapshot_io.private_file(path, (json.dumps(manifest, indent=2) + "\n").encode())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _archive_manifest(case: _RecoveryCase) -> dict[str, Any]:
    """
    读取仅由当前测试写入的清单为可编辑对象，允许单独更改声明字段而无需替换程序校验或重建整个归档。
    """
    manifest: dict[str, Any] = json.loads((case.source / "manifest.json").read_bytes())
    return manifest


def _replace_payload(case: _RecoveryCase, name: str, raw: bytes) -> _RecoveryCase:
    """
    写入一个变体载荷并同步更新内外摘要，返回的新收据让测试到达语义门禁而非被较早的字节校验挡住。
    """
    (case.source / name).write_bytes(raw)
    manifest = _archive_manifest(case)
    manifest["files"][name] = _identity((case.source / name).read_bytes())
    return dataclasses.replace(case, digest=_write_manifest(case.source, manifest))


@pytest.fixture(name="recovery_case")
def _recovery_case(tmp_path: pathlib.Path, static_package: pathlib.Path) -> _RecoveryCase:
    """
    使用当前安装的迁移头和生产静态加载结果生成私有归档，源制品、目标制品及外置材料配置使用互不重叠的根。

    每个载荷单独落盘后计算大小与摘要，清单最后创建。普通制品字节无业务数据，密钥和数据库地址均为合成值。
    """
    source = tmp_path / "snapshot"
    source.mkdir(mode=0o700)
    (source / "file-artifacts").mkdir(mode=0o700)
    configuration = tmp_path / "operator" / "restore.json"
    target = settings.Settings.model_validate(
        {
            "database_url": _DSN,
            "public_url": "https://recovery.invalid",
            "master_key_id": "active",
            "master_key": _ACTIVE,
            "previous_master_keys": {"historical": _HISTORY},
            "signing_key": _SIGNING,
            "artifact_directory": str(tmp_path / "target-artifacts"),
            "bundle_issuer_path": str(tmp_path / "target-materials" / "issuer.json"),
        }
    )
    snapshot_io.private_file(configuration, _config_bytes(target))
    archived = target.model_copy(
        update={
            "artifact_directory": str(tmp_path / "source-artifacts"),
            "bundle_issuer_path": str(tmp_path / "source-materials" / "issuer.json"),
        }
    )
    heads = readiness.packaged_heads()
    assert len(heads) == 1
    published = static.load_published_site(target)
    assert published is not None and published.root == static_package
    payloads = {
        "configuration.json": _config_bytes(archived),
        _HEAD_FILE: _head_bytes(heads[0]),
        _ARTIFACT: _ARTIFACT_BYTES,
        "issuer.json": _MATERIAL_BYTES,
    }
    files = {}
    for name, raw in payloads.items():
        snapshot_io.private_file(source / name, raw)
        files[name] = _identity((source / name).read_bytes())
    manifest = {
        "format": "veriq-backup-1",
        "serverVersion": veriq_server.__version__,
        "schemaHeads": list(heads),
        "buildInfo": published.build_info,
        "tables": {
            "veriq_alembic_version": {"file": _HEAD_FILE, "rows": 1, "columns": ["version_num"]}
        },
        "materials": {"issuer": "issuer.json"},
        "keyFingerprints": {
            "active": hashlib.sha256(bytes.fromhex(_ACTIVE)).hexdigest(),
            "historical": hashlib.sha256(bytes.fromhex(_HISTORY)).hexdigest(),
        },
        "signingKeyFingerprint": hashlib.sha256(bytes.fromhex(_SIGNING)).hexdigest(),
        "artifactBackend": "FILE",
        "s3Objects": [],
        "s3Tombstones": [],
        "files": files,
    }
    return _RecoveryCase(source, target, configuration, _write_manifest(source, manifest))


def _tree_state(root: pathlib.Path) -> dict[str, tuple[int, str]]:
    """
    以不跟踪链接的方式记录测试根的目录、模式及文件摘要，用于检查拒绝未复制制品、改写外置材料或创建标记。

    目录只记录模式，链接只记录链接文本的摘要，文件内容不会出现在断言差异中。
    """
    state = {}
    for path in root.rglob("*"):
        mode = path.lstat().st_mode
        identity = ""
        if stat.S_ISLNK(mode):
            identity = hashlib.sha256(str(path.readlink()).encode()).hexdigest()
        elif stat.S_ISREG(mode):
            identity = hashlib.sha256(path.read_bytes()).hexdigest()
        state[path.relative_to(root).as_posix()] = (mode, identity)
    return state


async def _restore(
    case: _RecoveryCase,
    trap: _DatabaseTrap,
    *,
    services_stopped: bool = True,
    allow_restore: bool = True,
    confirm_empty_target: bool = True,
) -> None:
    """
    在测试固定关闭对象存储授权的前提下调用公开恢复函数，让各场景只替换需要验证的归档或操作员确认。
    """
    await recovery.restore(
        trap.database,
        case.target,
        case.source,
        expected_digest=case.digest,
        services_stopped=services_stopped,
        allow_restore=allow_restore,
        confirm_empty_target=confirm_empty_target,
        allow_s3_inventory=False,
        configuration_path=case.configuration,
    )


async def _assert_restore_refused(
    case: _RecoveryCase,
    trap: _DatabaseTrap,
    reason: str,
    **flags: bool,
) -> None:
    """
    精确检查公开恢复入口给出的拒绝原因，随后验证驱动调用计数和整个合成目录树，意外触及数据库即判失败。
    """
    root = case.configuration.parent.parent
    before = _tree_state(root)
    with pytest.raises(ValueError) as refusal:
        await _restore(case, trap, **flags)
    assert str(refusal.value) == reason
    assert trap.attempts == 0
    assert _tree_state(root) == before


async def test_untouched_archive_reaches_database_trap(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    普通归档能通过全部本地门禁并恰好触及一次连接哨兵，同时保持目标目录和外置材料在连接前的原始状态。
    """
    root = recovery_case.source.parent
    before = _tree_state(root)
    with pytest.raises(_DatabaseAccessError, match="^SYNTHETIC_DB_ACCESS_ATTEMPT$"):
        await _restore(recovery_case, database_trap)
    assert database_trap.attempts == 1
    assert _tree_state(root) == before


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"master_key": _DIFFERENT}, id="archived-active-bytes"),
        pytest.param(
            {"previous_master_keys": {"historical": _DIFFERENT}}, id="archived-history-bytes"
        ),
        pytest.param({"signing_key": _DIFFERENT}, id="archived-signing-bytes"),
    ],
)
async def test_restore_rejects_archived_key_material_mismatch(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, overrides: dict[str, Any]
) -> None:
    """
    只替换归档中某一密钥的合法字节并重算两级摘要，目标配置保持匹配，恢复仍应因密钥材料不符而在连接前拒绝。
    """
    raw = (recovery_case.source / "configuration.json").read_bytes()
    archived = settings.Settings.model_validate({**json.loads(raw), **overrides})
    changed = _replace_payload(recovery_case, "configuration.json", _config_bytes(archived))
    await _assert_restore_refused(changed, database_trap, "BACKUP_KEY_MATERIAL_MISMATCH")


@pytest.mark.parametrize(
    "scenario", ["writers-not-stopped", "relative", "existing", "inside-file-root"]
)
async def test_backup_rejects_unsafe_request_before_database(
    recovery_case: _RecoveryCase,
    database_trap: _DatabaseTrap,
    monkeypatch: pytest.MonkeyPatch,
    scenario: str,
) -> None:
    """
    分别改变停写声明或目的地属性检查备份的早期拒绝，已有目录内容及空目标候选都不得受到任何写入影响。
    """
    root = recovery_case.source.parent
    existing = root / "existing-backup"
    snapshot_io.private_file(existing / "sentinel.bin", b"existing backup bytes")
    monkeypatch.chdir(root)
    destination = {
        "writers-not-stopped": root / "new-backup",
        "relative": pathlib.Path("relative-backup"),
        "existing": existing,
        "inside-file-root": pathlib.Path(recovery_case.target.artifact_directory) / "nested-backup",
    }[scenario]
    reason = (
        "BACKUP_DESTINATION_INSIDE_ARTIFACT_ROOT"
        if scenario == "inside-file-root"
        else "BACKUP_REQUIRES_QUIESCENT_NEW_ABSOLUTE_DIRECTORY"
    )
    before = _tree_state(root)
    with pytest.raises(ValueError) as refusal:
        await recovery.backup(
            database_trap.database,
            recovery_case.target,
            destination,
            services_stopped=scenario != "writers-not-stopped",
            configuration_path=recovery_case.configuration,
        )
    assert str(refusal.value) == reason
    assert database_trap.attempts == 0
    assert _tree_state(root) == before


@pytest.mark.parametrize("missing", ["services_stopped", "allow_restore", "confirm_empty_target"])
async def test_restore_requires_every_confirmation(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, missing: str
) -> None:
    """
    用同一有效归档逐项撤销一个确认，校验其余两个确认无法代替缺失的声明，也不触发目标写入或连接。
    """
    await _assert_restore_refused(
        recovery_case, database_trap, "RESTORE_EXPLICIT_CONFIRMATION_REQUIRED", **{missing: False}
    )


async def test_restore_rejects_relative_source(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    从归档父目录传入确实存在的相对路径，验证拒绝来自绝对来源要求，且摘要与其他确认仍沿用有效归档。
    """
    monkeypatch.chdir(recovery_case.source.parent)
    relative = dataclasses.replace(recovery_case, source=pathlib.Path(recovery_case.source.name))
    await _assert_restore_refused(relative, database_trap, "RESTORE_EXPLICIT_CONFIRMATION_REQUIRED")


async def test_restore_rejects_wrong_manifest_receipt(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    真实清单字节保持不变，只提交另一份符合长度要求的摘要，验证独立收据无法确认其他内容且不会写目标。
    """
    wrong_receipt = dataclasses.replace(recovery_case, digest="0" * 64)
    await _assert_restore_refused(wrong_receipt, database_trap, "BACKUP_MANIFEST_DIGEST_MISMATCH")


async def test_restore_rejects_edited_manifest_with_original_receipt(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    仅对有效清单追加仍可被解析的空白，沿用原摘要验证门禁绑定实际字节，而不是重新格式化后的对象内容。
    """
    manifest = recovery_case.source / "manifest.json"
    manifest.write_bytes(manifest.read_bytes() + b"\n")
    await _assert_restore_refused(recovery_case, database_trap, "BACKUP_MANIFEST_DIGEST_MISMATCH")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("format", "veriq-backup-2", id="format"),
        pytest.param("serverVersion", "99.0.0", id="server-version"),
        pytest.param("schemaHeads", ["0000_synthetic"], id="declared-migration-head"),
    ],
)
async def test_restore_rejects_incompatible_archive_version(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, field: str, value: object
) -> None:
    """
    刷新外层摘要后单独更改快照格式、服务版本或声明迁移头，使每个场景都在版本兼容门禁准确拒绝。
    """
    manifest = _archive_manifest(recovery_case)
    manifest[field] = value
    changed = dataclasses.replace(
        recovery_case, digest=_write_manifest(recovery_case.source, manifest)
    )
    await _assert_restore_refused(changed, database_trap, "BACKUP_VERSION_INCOMPATIBLE")


async def test_restore_rejects_valid_but_different_static_build(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, static_package: pathlib.Path
) -> None:
    """
    保留完整静态库存与产物字节，仅更换为另一份可成功加载的构建身份，验证恢复必须匹配完整发布元数据。
    """
    build_info = static_package / "build-info.json"
    replacement = {**json.loads(build_info.read_bytes()), "buildId": "synthetic-alternate-build"}
    build_info.write_text(json.dumps(replacement), encoding="utf-8")
    published = static.load_published_site(recovery_case.target)
    assert published is not None and published.build_info == replacement
    assert published.build_info != _archive_manifest(recovery_case)["buildInfo"]
    await _assert_restore_refused(recovery_case, database_trap, "BACKUP_VERSION_INCOMPATIBLE")


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param(
            {"artifact_backend": "S3", "artifact_s3_bucket": "synthetic-unused"},
            id="storage-backend",
        ),
        pytest.param({"master_key_id": "another-id"}, id="active-id"),
        pytest.param({"master_key": _DIFFERENT}, id="active-bytes"),
        pytest.param({"previous_master_keys": {"another-id": _HISTORY}}, id="historical-id"),
        pytest.param({"previous_master_keys": {"historical": _DIFFERENT}}, id="historical-bytes"),
        pytest.param({"signing_key": _DIFFERENT}, id="signing-bytes"),
    ],
)
async def test_restore_rejects_incompatible_target_configuration(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, overrides: dict[str, object]
) -> None:
    """
    更换一个生效目标设置但保留原归档及收据，验证后端、密钥标识和相同标识下的不同字节都参与匹配。
    """
    raw = recovery_case.configuration.read_bytes()
    target = settings.Settings.model_validate({**json.loads(raw), **overrides})
    recovery_case.configuration.write_bytes(_config_bytes(target))
    changed = dataclasses.replace(recovery_case, target=target)
    await _assert_restore_refused(changed, database_trap, "BACKUP_CONFIG_KEYS_INCOMPATIBLE")


async def test_restore_rejects_same_size_payload_edit(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    替换普通制品首字节且保持原来的长度和确认摘要，验证实际内容校验无法被相同载荷大小绕过。
    """
    modified = b"X" + _ARTIFACT_BYTES[1:]
    assert len(modified) == len(_ARTIFACT_BYTES) and modified != _ARTIFACT_BYTES
    (recovery_case.source / _ARTIFACT).write_bytes(modified)
    await _assert_restore_refused(recovery_case, database_trap, "BACKUP_PAYLOAD_DIGEST_MISMATCH")


async def test_restore_rejects_extra_payload(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    在原归档内额外放入完全私有的普通文件，验证单项摘要通过后仍需拒绝未纳入清单的载荷集合。
    """
    snapshot_io.private_file(recovery_case.source / "extra.bin", b"unlisted snapshot bytes")
    await _assert_restore_refused(recovery_case, database_trap, "BACKUP_PAYLOAD_SET_MISMATCH")


async def test_restore_rejects_widened_file_permissions(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    仅放宽已登记制品文件的读权限，保持内容及两级摘要有效，验证任何额外访问权限都会在连接前拒绝。
    """
    (recovery_case.source / _ARTIFACT).chmod(0o640)
    await _assert_restore_refused(recovery_case, database_trap, "SNAPSHOT_FILE_UNSAFE")


async def test_restore_rejects_linked_payload(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    将归档制品换成指向相同私有字节的符号链接，验证链接检查独立于字节一致性而且外部文件保持原样。
    """
    outside = recovery_case.source.parent / "outside-payload.bin"
    snapshot_io.private_file(outside, _ARTIFACT_BYTES)
    payload = recovery_case.source / _ARTIFACT
    payload.unlink()
    payload.symlink_to(outside)
    await _assert_restore_refused(recovery_case, database_trap, "SNAPSHOT_PATH_UNSAFE")


@pytest.mark.parametrize("invalid_name", ["../outside.bin", "tables//invalid.jsonl"])
async def test_restore_rejects_invalid_inventory_path(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, invalid_name: str
) -> None:
    """
    让操作员确认包含非法相对索引的新清单，保留其他载荷项并验证路径解析拒绝越出根或被规范化的输入。
    """
    manifest = _archive_manifest(recovery_case)
    manifest["files"][invalid_name] = manifest["files"][_ARTIFACT]
    changed = dataclasses.replace(
        recovery_case, digest=_write_manifest(recovery_case.source, manifest)
    )
    await _assert_restore_refused(changed, database_trap, "SNAPSHOT_PATH_INVALID")


async def test_restore_rejects_rehashed_wrong_archived_head(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    用标签正确的单行载荷替换归档迁移头，刷新内外摘要但保留声明头，确认恢复还要独立校验实际列值。
    """
    changed = _replace_payload(recovery_case, _HEAD_FILE, _head_bytes("0000_synthetic"))
    await _assert_restore_refused(changed, database_trap, "BACKUP_SCHEMA_PAYLOAD_MISMATCH")


@pytest.mark.parametrize("layout", ["occupied", "source", "inside-source", "source-parent", "link"])
async def test_restore_rejects_nonempty_or_overlapping_file_root(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap, layout: str
) -> None:
    """
    用同一有效归档验证已有制品、归档路径重叠和直接目录链接均拒绝，保留原始文件和链接目标状态。
    """
    root = recovery_case.source.parent
    occupied = root / "occupied-target"
    snapshot_io.private_file(occupied / "sentinel.bin", b"preexisting target bytes")
    empty = root / "empty-directory"
    empty.mkdir(mode=0o700)
    link = root / "target-link"
    link.symlink_to(empty, target_is_directory=True)
    target_path = {
        "occupied": occupied,
        "source": recovery_case.source,
        "inside-source": recovery_case.source / "nested-target",
        "source-parent": root,
        "link": link,
    }[layout]
    target = recovery_case.target.model_copy(update={"artifact_directory": str(target_path)})
    changed = dataclasses.replace(recovery_case, target=target)
    await _assert_restore_refused(changed, database_trap, "RESTORE_ARTIFACT_TARGET_NOT_EMPTY")


async def test_restore_rejects_linked_target_ancestor(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    目标叶路径尚不存在但祖先经由符号链接重定向，验证创建前会检查祖先并保持链接两侧没有新输出。
    """
    root = recovery_case.source.parent
    directory = root / "real-target-parent"
    directory.mkdir(mode=0o700)
    link = root / "linked-target-parent"
    link.symlink_to(directory, target_is_directory=True)
    target = recovery_case.target.model_copy(update={"artifact_directory": str(link / "new-root")})
    changed = dataclasses.replace(recovery_case, target=target)
    await _assert_restore_refused(changed, database_trap, "RESTORE_ARTIFACT_TARGET_UNSAFE")


async def test_restore_rejects_conflicting_external_material(
    recovery_case: _RecoveryCase, database_trap: _DatabaseTrap
) -> None:
    """
    用合成的外置签发材料制造同路径字节冲突，验证恢复不覆盖当前操作员文件，也不创建制品或不完整标记。
    """
    assert recovery_case.target.bundle_issuer_path is not None
    snapshot_io.private_file(
        pathlib.Path(recovery_case.target.bundle_issuer_path), b"distinct existing issuer bytes\n"
    )
    await _assert_restore_refused(
        recovery_case, database_trap, "RESTORE_EXTERNAL_MATERIAL_CONFLICT"
    )


@pytest.mark.parametrize(
    ("value", "wire"),
    [
        pytest.param(b"\x00\xffA\x10", {"kind": "bytes", "value": "AP9BEA=="}, id="binary"),
        pytest.param(
            datetime.datetime(2024, 2, 29, 12, 34, 56, 123456, tzinfo=datetime.UTC),
            {"kind": "datetime", "value": "2024-02-29T12:34:56.123456+00:00"},
            id="utc-microseconds",
        ),
        pytest.param(
            decimal.Decimal("-72.4500"),
            {"kind": "decimal", "value": "-72.4500"},
            id="decimal-scale",
        ),
        pytest.param(
            {"rows": [1, {"present": True, "absent": None}], "name": "快照"},
            {
                "kind": "json",
                "value": {"rows": [1, {"present": True, "absent": None}], "name": "快照"},
            },
            id="nested-json",
        ),
        pytest.param(
            {"kind": "bytes", "value": "AP9BEA=="},
            {"kind": "json", "value": {"kind": "bytes", "value": "AP9BEA=="}},
            id="json-shaped-like-bytes",
        ),
        pytest.param(
            {"nodes": [{"kind": "datetime", "value": "2024-02-29T12:34:56.123456+00:00"}]},
            {
                "kind": "json",
                "value": {
                    "nodes": [{"kind": "datetime", "value": "2024-02-29T12:34:56.123456+00:00"}]
                },
            },
            id="nested-json-shaped-like-datetime",
        ),
    ],
)
def test_snapshot_codec_preserves_exact_values(value: object, wire: dict[str, object]) -> None:
    """
    编码和解码都与独立的固定格式比较，确保时间精度、十进制位数和形似格式标签的普通对象在落盘后保留。
    """
    assert snapshot_io.encode_value(value) == wire
    decoded = snapshot_io.decode_value(json.loads(json.dumps(wire)))
    assert type(decoded) is type(value)
    assert decoded == value
    if isinstance(value, decimal.Decimal):
        assert isinstance(decoded, decimal.Decimal)
        assert decoded.as_tuple() == value.as_tuple()


def test_snapshot_codec_rejects_unknown_tag() -> None:
    """
    使用字段齐全但格式未定义的列标签，验证解码器拒绝该条记录而不把未识别的类型静默降级为业务数据。
    """
    with pytest.raises(ValueError, match="^SNAPSHOT_VALUE_INVALID$"):
        snapshot_io.decode_value({"kind": "unrecognized", "value": "test"})


_CLI_FAILURE = b"VeriQ command failed. Check configuration, file permissions and command inputs.\n"
_CLI_CAPTURE_LIMIT = 65536
_CLI_TIMEOUT = 10
_DATABASE_ATTEMPT_EXIT = 96
_NETWORK_ATTEMPT_EXIT = 97
_CHILD_GUARD = """\
import os
import pathlib
import sys
from importlib import resources

guard = pathlib.Path(__file__).parent
if any(name.startswith("VERIQ_") for name in os.environ):
    os._exit(95)

def block_network(name, arguments):
    # 审计事件只需名称即可确认网络企图，丢弃地址参数以保证子进程不会在失败时泄露连接输入。
    del arguments
    if name.startswith("socket.") and name not in {"socket.__new__"}:
        try:
            (guard / "network-attempted").touch()
        finally:
            os._exit(97)

sys.addaudithook(block_network)

from sqlalchemy import event, engine

def block_database(dialect, record, args, kwargs):
    # 驱动连接前只需留下固定哨兵文件，删除事件提供的驱动参数以免合成连接设置进入任何输出。
    del dialect, record, args, kwargs
    try:
        (guard / "database-attempted").touch()
    finally:
        os._exit(96)

event.listen(engine.Engine, "do_connect", block_database)
original_files = resources.files
package = pathlib.Path.cwd() / "installed" / "veriq_server"

def synthetic_package(anchor):
    # 仅把服务包的资源定位到现有静态夹具，其他依赖继续使用安装位置以保留实际配置及协议检查。
    return package if anchor == "veriq_server" else original_files(anchor)

resources.files = synthetic_package
(guard / "guard-ready").touch()
"""


def _capture_cli(child: subprocess.Popen[bytes], deadline: float) -> tuple[bytes, bytes]:
    """
    在同一截止时间和字节上限内持续排空两个管道，返回原始字节供私密材料扫描，超限诊断绝不包含捕获内容。

    选择器关闭后由调用方负责回收进程和管道，避免某路输出提前填满而让模块入口无限等待。
    """
    stdout, stderr = bytearray(), bytearray()
    assert child.stdout is not None and child.stderr is not None
    with selectors.DefaultSelector() as selection:
        selection.register(child.stdout, selectors.EVENT_READ, stdout)
        selection.register(child.stderr, selectors.EVENT_READ, stderr)
        while selection.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("Recovery CLI did not finish capturing output in time")
            for key, _events in selection.select(remaining):
                limit = _CLI_CAPTURE_LIMIT - len(stdout) - len(stderr)
                block = os.read(key.fd, min(8192, limit + 1))
                if len(block) > limit:
                    raise AssertionError("Recovery CLI exceeded its private capture limit")
                if block:
                    key.data.extend(block)
                else:
                    selection.unregister(key.fileobj)
    return bytes(stdout), bytes(stderr)


def _assert_private_cli_output(case: _RecoveryCase, stdout: bytes, stderr: bytes) -> None:
    """
    在任何退出诊断和收据断言前扫描两路原始字节，若出现配置、私密标记或回溯则以固定诊断终止。
    """
    markers = (
        case.configuration.read_bytes(),
        (case.source / "configuration.json").read_bytes(),
        str(case.configuration).encode(),
        b"mysql+asyncmy://",
        b"synthetic-recovery",
        b"db.invalid",
        b"https://recovery.invalid",
        _ACTIVE.encode(),
        _HISTORY.encode(),
        _SIGNING.encode(),
        _DIFFERENT.encode(),
        _MATERIAL_BYTES.strip(),
        _ARTIFACT_BYTES,
        b'"database_url"',
        b'"master_key"',
        b'"previous_master_keys"',
        b'"signing_key"',
        b"Traceback (most recent call last)",
    )
    if any(marker in stdout or marker in stderr for marker in markers):
        raise AssertionError("Recovery CLI exposed private configuration material or a traceback")


def _run_restore_cli(case: _RecoveryCase, *, database_attempted: bool) -> None:
    """
    通过真实模块入口运行恢复，校验启动钩子及数据库哨兵，并在解释退出状态前先扫描两路输出的私密标记。

    子解释器仅接收允许的环境变量，静态资源仍由产品检查，哨兵只阻止调用外部数据库驱动或网络。
    """
    command = [
        sys.executable,
        "-B",
        "-m",
        "veriq_server",
        "--config",
        str(case.configuration),
        "restore",
        "--source",
        str(case.source),
        "--expected-manifest-sha256",
        case.digest,
        "--services-stopped",
        "--allow-restore",
        "--confirm-empty-target",
    ]
    root = case.source.parent
    with tempfile.TemporaryDirectory(dir=root) as directory:
        guard = pathlib.Path(directory)
        snapshot_io.private_file(guard / "sitecustomize.py", _CHILD_GUARD.encode())
        environment = {
            "PYTHONPATH": directory,
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        deadline = time.monotonic() + _CLI_TIMEOUT
        with subprocess.Popen(
            command,
            cwd=root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as child:
            try:
                stdout, stderr = _capture_cli(child, deadline)
                status = child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise AssertionError("Recovery CLI did not finish in time") from None
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=_CLI_TIMEOUT)
        _assert_private_cli_output(case, stdout, stderr)
        assert (guard / "guard-ready").is_file(), "Recovery CLI startup guard did not load"
        assert status != _NETWORK_ATTEMPT_EXIT and not (guard / "network-attempted").exists()
        assert (guard / "database-attempted").exists() is database_attempted
        expected = (
            (_DATABASE_ATTEMPT_EXIT, b"", b"") if database_attempted else (1, b"", _CLI_FAILURE)
        )
        if (status, stdout, stderr) != expected:
            raise AssertionError("Recovery CLI returned an unexpected exit status or receipt")


def test_real_cli_refuses_occupied_target_before_connecting(
    recovery_case: _RecoveryCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    同一模块命令先拒绝非空目标，再移除仅由测试放置的文件确认能到达驱动哨兵，隔离启动失败与目标门禁。

    两次子进程都使用合成配置且不允许网络连接，拒绝不产生成功收据、外置文件或不完整标记。
    """
    root = recovery_case.source.parent
    monkeypatch.setenv("VERIQ_PUBLIC_URL", "inherited-settings-must-not-reach-cli")
    occupied = pathlib.Path(recovery_case.target.artifact_directory) / "occupied.bin"
    snapshot_io.private_file(occupied, b"preexisting CLI target bytes")
    before = _tree_state(root)
    _run_restore_cli(recovery_case, database_attempted=False)
    assert _tree_state(root) == before

    occupied.unlink()
    before = _tree_state(root)
    _run_restore_cli(recovery_case, database_attempted=True)
    assert _tree_state(root) == before
