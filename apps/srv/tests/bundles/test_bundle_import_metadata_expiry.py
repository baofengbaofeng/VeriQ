"""使用真实员工会话与测试签名归档核对保留期边界，验证导出和导入幂等请求在逻辑到期后没有新增副作用。"""

import base64
import io
import json
import re
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import httpx
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import test_export
from veriq_server import db as models
from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.bundles.issuer import Issuer
from veriq_server.repositories.resource import ResourceRepository
from veriq_server.services.jobs import database_time

from apps.srv.tests.ai.test_ai_metadata_expiry import (
    ExpiryResponseGuard,
    ResponseGuardHook,
    Site,
    change_membership,
    error_response,
    owner_login,
    success_data,
    workspace,
)

# 旧导出模块同时提供执行助手搜索路径和既有资源夹具，显式声明已核对调用签名即可保留其发布行为。
_environment = cast(
    Callable[[httpx.AsyncClient, models.Database, str], Awaitable[str]],
    vars(test_export)["environment"],
)
_published = cast(
    Callable[[httpx.AsyncClient, models.Database, str, str, str, dict[str, Any]], Awaitable[str]],
    vars(test_export)["published"],
)
_EXPIRY = ("BUNDLE_EXPIRED", "Bundle archive retention has expired")
_FORBIDDEN = ("WORKSPACE_FORBIDDEN", "Workspace permission required")
_READ_SUFFIXES = ("", "/manifest", "/download")


@dataclass(frozen=True)
class _Selection:
    """保留导出之前就选定的发布版本，幂等请求与签名内容的预期都源于这些原始输入和测试公开字面值。"""

    environment_id: str
    catalog_id: str
    case_id: str

    def request(self) -> dict[str, Any]:
        """构造本用例实际提交的固定有效选择，同键重放复用原始字段，冲突场景只改变明确允许的状态枚举。"""
        return {
            "caseVersionIds": [self.case_id],
            "environmentVersionId": self.environment_id,
            "validationStatus": "VALIDATED",
        }


@dataclass(frozen=True)
class _SignedArchive:
    """保存下载归档和已核验的清单快照，原始字节从夹具表示中移除以免断言失败时输出原文件内容。"""

    raw: bytes = field(repr=False)
    manifest: bytes = field(repr=False)
    snapshot: bytes = field(repr=False)
    signature: bytes = field(repr=False)
    environment: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class _BundleFixture:
    """以同一已登录站点持有原始导出请求、紧凑响应以及归档，邮箱 Cookie 和凭据不出现在夹具失败表示。"""

    site: Site = field(repr=False)
    workspace_id: str
    actor_id: str
    export_key: str
    selection: _Selection
    dto: dict[str, Any]
    archive: _SignedArchive = field(repr=False)

    @property
    def bundles(self) -> str:
        """为导出、列表和详情使用相同工作区资源路径，越界验证只替换明确已授权的第二个工作区标识。"""
        return f"/api/v1/workspaces/{self.workspace_id}/bundles"

    @property
    def detail(self) -> str:
        """使用真实导出响应给出的标识访问原始资源，不从列表搜索其他归档来满足详情或重放检查。"""
        return f"{self.bundles}/{self.dto['id']}"


def _authoring_status(request: httpx.Request) -> int | None:
    """为旧发布助手的交互预先声明应答状态，异常返回先由固定诊断拦截以免助手断言打印完整正文。"""
    path = request.url.path
    if re.fullmatch(r"/api/v1/workspaces/[^/]+/resources/[^/]+/validation-preview", path):
        return 200
    if request.method == "POST":
        statuses = {
            "credentials": 201,
            "auth-adapters": 201,
            "resources": 201,
            "validate": 202,
            "publish": 201,
        }
        return statuses.get(path.rsplit("/", 1)[-1])
    return None


async def _publish_selection(
    site: Site, workspace_id: str, approved_metadata: dict[str, bytes]
) -> _Selection:
    """复用真实资源发布流程和合成编译回执，并把四份批准库存字节只存入当前工作区供正常导出使用。"""
    client, database = site
    async with database.sessions.begin() as session:
        repo = ResourceRepository(session, WorkspaceScope(workspace_id))
        for raw in approved_metadata.values():
            await repo.store(raw)
    environment_id = await _environment(client, database, workspace_id)
    catalog_id = await _published(
        client,
        database,
        workspace_id,
        "catalog",
        "ELEMENT_CATALOG",
        {
            "schemaVersion": "1.0",
            "elements": [{"key": "save", "locator": {"by": "veriqId", "value": "save"}}],
        },
    )
    case_id = await _published(
        client,
        database,
        workspace_id,
        "case",
        "CASE",
        {
            "schemaVersion": "1.0",
            "caseKey": "read",
            "title": "Read",
            "kind": "READ",
            "roleKey": "reader",
            "catalogVersionId": catalog_id,
            "steps": [{"id": "open", "action": "goto", "path": "/"}],
        },
    )
    return _Selection(environment_id, catalog_id, case_id)


async def _export(
    client: httpx.AsyncClient, route: str, key: str, request: dict[str, Any]
) -> httpx.Response:
    """发起工作区的真实导出写入并在请求级携带原幂等键，其他导入或读取不会因客户端默认头污染而复用此键。"""
    return await client.post(route, json=request, headers={"Idempotency-Key": key})


def _zip_files(response: httpx.Response, guard: ExpiryResponseGuard) -> dict[str, bytes]:
    """只在内存读取受控小型归档且先扫描其成员路径与解压内容，路径名称与文件字节都不含已知夹具密钥。"""
    if len(response.content) > 256_000:
        pytest.fail("Unexpected archive fixture size", pytrace=False)
    guard.check_archive(response.content, response.request)
    try:
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            entries = archive.infolist()
            if not 1 <= len(entries) <= 32 or sum(item.file_size for item in entries) > 512_000:
                pytest.fail("Unexpected expanded archive fixture size", pytrace=False)
            result = {}
            for item in entries:
                guard.check_archive(item.filename.encode(), response.request)
                raw = archive.read(item)
                guard.check_archive(raw, response.request)
                result[item.filename] = raw
            assert len(result) == len(entries)
            return result
    except (OSError, zipfile.BadZipFile):
        raise pytest.fail.Exception(
            "Download is not a readable signed ZIP", pytrace=False
        ) from None


def _verify_manifest(
    files: dict[str, bytes], issuer: Issuer, dto: dict[str, Any]
) -> dict[str, Any]:
    """用独立夹具信任公钥验证清单真实签名，并确认清单中的每个条目与收到的归档内容和哈希相符。"""
    raw = files["manifest.json"]
    manifest = cast(dict[str, Any], json.loads(raw))
    trust = issuer.public()
    assert manifest["issuerId"] == trust["issuerId"]
    key = next(key for key in trust["keys"] if key["keyId"] == manifest["keyId"])
    assert key["revoked"] is False
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(key["publicKey"])).verify(
            files["manifest.sig"], raw
        )
    except InvalidSignature:
        pytest.fail("The fixture issuer could not verify the downloaded signature", pytrace=False)
    assert (manifest["bundleId"], manifest["workspaceId"]) == (dto["id"], dto["workspaceId"])
    assert manifest["validationStatus"] == "VALIDATED" and manifest["engineVersion"] == "0.1.0"
    assert manifest["createdAt"] == dto["createdAt"] < manifest["expiresAt"]
    assert sha256(raw).hexdigest() == dto["manifestSha256"]
    snapshot_hash = sha256(files["snapshot.json"]).hexdigest()
    assert snapshot_hash == manifest["snapshotSha256"] == dto["snapshotSha256"]
    assert set(files) == {"manifest.json", "manifest.sig", *(f["path"] for f in manifest["files"])}
    for entry in manifest["files"]:
        body = files[entry["path"]]
        assert len(body) == entry["sizeBytes"] and sha256(body).hexdigest() == entry["sha256"]
    return manifest


def _verified_archive(
    response: httpx.Response,
    guard: ExpiryResponseGuard,
    issuer: Issuer,
    dto: dict[str, Any],
    selection: _Selection,
) -> _SignedArchive:
    """检查正常下载的二进制类型和沙箱头，并证明下载内选集与快照都是由本用例明确发布的对象。"""
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-security-policy"] == "sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-disposition"] == f'attachment; filename="{dto["id"]}.zip"'
    files = _zip_files(response, guard)
    manifest = _verify_manifest(files, issuer, dto)
    assert json.loads(files["selection.json"]) == selection.request()
    snapshot = json.loads(files["snapshot.json"])
    assert snapshot["sourceHash"] == manifest["sourceHash"]
    assert snapshot["entryCaseVersionIds"] == [selection.case_id]
    assert {(a["kind"], a["versionId"]) for a in snapshot["assets"]} == {
        ("CASE", selection.case_id),
        ("ELEMENT_CATALOG", selection.catalog_id),
        ("ENVIRONMENT", selection.environment_id),
    }
    environment = next(
        a["document"] for a in snapshot["assets"] if a["versionId"] == selection.environment_id
    )
    return _SignedArchive(
        response.content,
        files["manifest.json"],
        files["snapshot.json"],
        files["manifest.sig"],
        environment,
    )


@pytest.fixture(name="expiry_issuer")
def _expiry_issuer(bundle_issuer: None, tmp_path: Path) -> Issuer:
    """等目录隔离夹具完成密钥初始化后再读测试签发者，响应守卫和实际归档验签共享同一测试信任来源。"""
    del bundle_issuer
    return Issuer(tmp_path / "issuer" / "keys.json")


@pytest.fixture(name="bundle_response_guard")
def _bundle_response_guard(expiry_issuer: Issuer) -> ExpiryResponseGuard:
    """在首个匿名响应之前登记签发材料与业务身份的合成私值，并与后续解压检查共享同一个守卫实例。"""
    private = expiry_issuer.private.private_bytes_raw()
    return ExpiryResponseGuard(
        (
            "synthetic-business-secret",
            "synthetic-fixture-secret",
            base64.b64encode(private).decode(),
            private.decode("latin-1"),
        ),
        _EXPIRY,
        _authoring_status,
    )


@pytest.fixture(name="veriq_response_guard", autouse=True)
def _bundle_site_hook(bundle_response_guard: ExpiryResponseGuard) -> ResponseGuardHook:
    """把模块限定的响应回调交给原站点夹具，在启动时守护安装态而且继续调用站点自己的完整契约校验。"""
    return bundle_response_guard.inspect_response


@pytest.fixture(name="live_bundle")
async def _live_bundle(
    approved_metadata: dict[str, bytes],
    site: Site,
    expiry_issuer: Issuer,
    bundle_response_guard: ExpiryResponseGuard,
) -> _BundleFixture:
    """使用隔离签发夹具和正常导出建立真实可下载 ZIP，合成批准引擎与编译回执仅为发布前提所需。"""
    client = site[0]
    actor_id = await owner_login(client)
    workspace_id = await workspace(client, "bundle-expiry")
    selection = await _publish_selection(site, workspace_id, approved_metadata)
    key = str(uuid4())
    route = f"/api/v1/workspaces/{workspace_id}/bundles"
    dto = success_data(await _export(client, route, key, selection.request()), 201)
    assert dto["workspaceId"] == workspace_id and dto["validationStatus"] == "VALIDATED"
    response = await client.get(f"{route}/{dto['id']}/download")
    archive = _verified_archive(response, bundle_response_guard, expiry_issuer, dto, selection)
    return _BundleFixture(site, workspace_id, actor_id, key, selection, dto, archive)


async def _archive_record(session: AsyncSession, fixture: _BundleFixture) -> models.Artifact:
    """沿原 Bundle 与工作区定位精确归档并核对存储字节，清单、快照和签名始终与下载时的内容相同。"""
    row = await session.scalar(
        select(models.Bundle).where(
            models.Bundle.id == fixture.dto["id"],
            models.Bundle.workspace_id == fixture.workspace_id,
        )
    )
    assert row is not None and row.exported_by == fixture.actor_id and not row.contains_draft
    assert row.manifest_hash == fixture.dto["manifestSha256"]
    assert row.snapshot_hash == fixture.dto["snapshotSha256"]
    assert row.archive_hash == sha256(fixture.archive.raw).hexdigest()
    if row.signature != fixture.archive.signature:
        pytest.fail("Persisted bundle signature changed", pytrace=False)
    for digest, expected in (
        (row.manifest_hash, fixture.archive.manifest),
        (row.snapshot_hash, fixture.archive.snapshot),
    ):
        metadata = await session.get(models.Artifact, (fixture.workspace_id, digest))
        assert metadata is not None and metadata.expired_at is None and metadata.deleted_at is None
        if metadata.content != expected:
            pytest.fail("Persisted signed bundle metadata changed", pytrace=False)
    archive = await session.get(models.Artifact, (fixture.workspace_id, row.archive_hash))
    assert archive is not None and archive.deleted_at is None
    assert archive.media_type == "application/zip" and archive.storage_backend == "INLINE"
    assert archive.size_bytes == len(fixture.archive.raw)
    if archive.content != fixture.archive.raw:
        pytest.fail("Persisted ZIP bytes changed", pytrace=False)
    return archive


async def _expire_archive(fixture: _BundleFixture) -> datetime:
    """只给非过期的当前内联归档设置数据库 UTC 标记，签名清单日期、快照、文件字节和删除标记不做变化。"""
    async with fixture.site[1].sessions.begin() as session:
        archive = await _archive_record(session, fixture)
        assert archive.expired_at is None
        expired_at = await database_time(session)
        manifest = json.loads(fixture.archive.manifest)
        assert expired_at.isoformat(timespec="microseconds") + "Z" < manifest["expiresAt"]
        archive.expired_at = expired_at
        return expired_at


async def _assert_retained_archive(fixture: _BundleFixture, expired_at: datetime) -> None:
    """另开事务确认过期拒绝之后仍只保留预设归档墓碑，避免任何路由借清除字节制造到期行为的假绿。"""
    async with fixture.site[1].sessions() as session:
        archive = await _archive_record(session, fixture)
        assert archive.expired_at == expired_at


async def test_bundle_reads_expire_while_list_and_session_survive(
    live_bundle: _BundleFixture,
) -> None:
    """三条原 Bundle 读取路径先真实可用，到期后只拒绝单项读取，列表仍为紧凑摘要且授权先于到期。"""
    client, database = live_bundle.site
    assert success_data(await client.get(live_bundle.detail)) == live_bundle.dto
    manifest = success_data(await client.get(live_bundle.detail + "/manifest"))
    assert manifest == json.loads(live_bundle.archive.manifest)
    page = {"items": [live_bundle.dto], "nextCursor": None}
    assert success_data(await client.get(live_bundle.bundles)) == page
    expired_at = await _expire_archive(live_bundle)

    for suffix in _READ_SUFFIXES:
        error_response(await client.get(live_bundle.detail + suffix), 410, *_EXPIRY)
    assert success_data(await client.get(live_bundle.bundles)) == page
    foreign = await workspace(client, "bundle-foreign")
    other = f"/api/v1/workspaces/{foreign}/bundles/{live_bundle.dto['id']}"
    for suffix in _READ_SUFFIXES:
        error_response(
            await client.get(other + suffix), 404, "BUNDLE_NOT_FOUND", "Bundle not found"
        )
    await change_membership(database, live_bundle.workspace_id, live_bundle.actor_id, None)
    for suffix in _READ_SUFFIXES:
        error_response(await client.get(live_bundle.detail + suffix), 403, *_FORBIDDEN)
    account = success_data(await client.get("/api/v1/account"))
    assert account["id"] == live_bundle.actor_id
    await _assert_retained_archive(live_bundle, expired_at)


async def _export_state(fixture: _BundleFixture) -> tuple[str, str, dict[str, Any]]:
    """确认空间内恰好一条导出和一个 ZIP，原键预订指向同一已完成记录，并返回保留状态供各次重放比较。"""
    async with fixture.site[1].sessions() as session:
        ids = await session.scalars(
            select(models.Bundle.id).where(models.Bundle.workspace_id == fixture.workspace_id)
        )
        assert list(ids) == [fixture.dto["id"]]
        archives = await session.scalars(
            select(models.Artifact.sha256).where(
                models.Artifact.workspace_id == fixture.workspace_id,
                models.Artifact.media_type == "application/zip",
            )
        )
        assert list(archives) == [sha256(fixture.archive.raw).hexdigest()]
        reservations = await session.scalars(
            select(models.BundleExport).where(
                models.BundleExport.workspace_id == fixture.workspace_id
            )
        )
        (row,) = tuple(reservations)
        assert row.idempotency_key == fixture.export_key and row.actor_id == fixture.actor_id
        assert row.bundle_id == fixture.dto["id"] and row.state == "COMPLETE"
        return row.id, row.request_hash, row.authority


async def test_export_replay_expires_after_live_idempotency(live_bundle: _BundleFixture) -> None:
    """固定键与原始选择在活跃期复用同一签名结果，改变合法请求会冲突，归档到期后拒绝且不会丢失预订。"""
    client, database = live_bundle.site
    key, route = live_bundle.export_key, live_bundle.bundles
    request = live_bundle.selection.request()
    initial = await _export_state(live_bundle)
    assert success_data(await _export(client, route, key, request), 201) == live_bundle.dto
    conflict = await _export(
        client, route, key, {**request, "validationStatus": "UNVALIDATED_DEBUG"}
    )
    error_response(conflict, 409, "IDEMPOTENCY_CONFLICT", "Bundle export request changed")
    assert await _export_state(live_bundle) == initial

    expired_at = await _expire_archive(live_bundle)
    error_response(await _export(client, route, key, request), 410, *_EXPIRY)
    await change_membership(database, live_bundle.workspace_id, live_bundle.actor_id, None)
    error_response(await _export(client, route, key, request), 403, *_FORBIDDEN)
    assert await _export_state(live_bundle) == initial
    await _assert_retained_archive(live_bundle, expired_at)


def _offline_result(fixture: _BundleFixture) -> dict[str, Any]:
    """构造匹配签名归档的合成离线结果，固定单次导航和执行声明只用于验证协议幂等与门禁不会提升。"""
    return {
        "schemaVersion": "1.0",
        "workspaceId": fixture.workspace_id,
        "bundleId": fixture.dto["id"],
        "localRunId": str(uuid4()),
        "deviceId": str(uuid4()),
        "source": "OFFLINE_IMPORT",
        "trustStatus": "MANAGED",
        "dirty": True,
        "revocationStatus": "CURRENT",
        "manifestSha256": fixture.dto["manifestSha256"],
        "startedAt": "2026-11-12T00:00:00Z",
        "finishedAt": "2026-11-12T00:00:01Z",
        "outcome": "PASSED",
        "actualEnvironment": fixture.archive.environment,
        "attempts": [
            {
                "attemptId": str(uuid4()),
                "caseVersionId": fixture.selection.case_id,
                "attemptNo": 1,
                "outcome": "PASSED",
                "cleanupStatus": "NOT_REQUIRED",
                "lastSequence": 0,
                "events": [],
                "artifacts": [],
            }
        ],
    }


async def _import_result(
    fixture: _BundleFixture, key: str, payload: dict[str, Any]
) -> httpx.Response:
    """通过员工会话向当前工作区真实提交结果，首次创建和重复发送明确传递独立的请求键与同一业务正文。"""
    return await fixture.site[0].post(
        f"/api/v1/workspaces/{fixture.workspace_id}/result-imports",
        json=payload,
        headers={"Idempotency-Key": key},
    )


async def _import_counts(fixture: _BundleFixture) -> tuple[int, int, int]:
    """检查相同工作区的结果、请求键和运行数量，检测一次拒绝是否暗中创建了部分提交或新的可见状态。"""
    scope = fixture.workspace_id
    async with fixture.site[1].sessions() as session:
        imports = await session.scalars(
            select(models.OfflineImport.id).where(models.OfflineImport.workspace_id == scope)
        )
        keys = await session.scalars(
            select(models.OfflineImportKey.key).where(models.OfflineImportKey.workspace_id == scope)
        )
        runs = await session.scalars(select(models.Run.id).where(models.Run.workspace_id == scope))
        return len(list(imports)), len(list(keys)), len(list(runs))


async def _retained_import(
    fixture: _BundleFixture, receipt: dict[str, Any], key: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """从独立事务核对原始导入声明、已验证事实、幂等绑定和只读运行结果均留在同一个目标工作区内。"""
    async with fixture.site[1].sessions() as session:
        row = await session.get(models.OfflineImport, receipt["id"])
        assert row is not None and row.workspace_id == fixture.workspace_id
        assert row.actor_id == fixture.actor_id and row.bundle_id == fixture.dto["id"]
        assert row.local_run_id == receipt["localRunId"] and row.run_id == receipt["runId"]
        assert row.declared == {
            field: value for field, value in payload.items() if field != "attempts"
        }
        assert row.verified["officialGatePassed"] is False and row.verified["expired"] is False
        assert row.verified["resultAuthenticity"] == "UNVERIFIED"
        request = await session.get(models.OfflineImportKey, (fixture.workspace_id, key))
        assert request is not None and request.import_id == row.id
        assert request.actor_id == fixture.actor_id and request.request_hash == row.request_hash
        run = await session.get(models.Run, row.run_id)
        assert run is not None and run.workspace_id == fixture.workspace_id
        assert run.created_by == fixture.actor_id and run.request_hash == row.request_hash
        assert (run.state, run.source, run.outcome) == ("FINISHED", "OFFLINE_IMPORT", "INCOMPLETE")
        attempts = await session.scalars(
            select(models.OfflineAttempt).where(
                models.OfflineAttempt.workspace_id == fixture.workspace_id,
                models.OfflineAttempt.import_id == row.id,
            )
        )
        attempt = attempts.one()
        assert attempt.document == payload["attempts"][0]
        assert attempt.local_attempt_id == payload["attempts"][0]["attemptId"]
        assert (attempt.attempt_no, attempt.outcome) == (1, "INCOMPLETE")
        return {
            "verified": row.verified,
            "requestHash": row.request_hash,
            "attemptFacts": attempt.facts,
        }


async def test_first_import_of_expired_bundle_creates_no_records(
    live_bundle: _BundleFixture,
) -> None:
    """合法离线结果首次访问已到期原归档时返回明确拒绝，导入实体、幂等键与运行都没有产生部分写入。"""
    payload, key = _offline_result(live_bundle), str(uuid4())
    assert await _import_counts(live_bundle) == (0, 0, 0)
    expired_at = await _expire_archive(live_bundle)
    error_response(await _import_result(live_bundle, key, payload), 410, *_EXPIRY)
    assert await _import_counts(live_bundle) == (0, 0, 0)
    await _assert_retained_archive(live_bundle, expired_at)


async def test_import_replay_checks_archive_expiry_before_duplicate(
    live_bundle: _BundleFixture,
) -> None:
    """首次导入与重放维持既有事实，到期时阻止原键和新键，成员撤权后沿原键和正文先检查当前授权。"""
    client, database = live_bundle.site
    payload, key = _offline_result(live_bundle), str(uuid4())
    assert await _import_counts(live_bundle) == (0, 0, 0)
    first = success_data(await _import_result(live_bundle, key, payload), 201)
    assert first["localRunId"] == payload["localRunId"]
    assert first["source"] == "OFFLINE_IMPORT" and first["officialGatePassed"] is False
    assert first["duplicate"] is False
    duplicate = success_data(await _import_result(live_bundle, key, payload), 201)
    assert duplicate == {**first, "duplicate": True}
    assert await _import_counts(live_bundle) == (1, 1, 1)
    retained = await _retained_import(live_bundle, first, key, payload)

    expired_at = await _expire_archive(live_bundle)
    for retry_key in (key, str(uuid4())):
        error_response(await _import_result(live_bundle, retry_key, payload), 410, *_EXPIRY)
    assert await _import_counts(live_bundle) == (1, 1, 1)
    assert await _retained_import(live_bundle, first, key, payload) == retained

    await change_membership(database, live_bundle.workspace_id, live_bundle.actor_id, None)
    error_response(await _import_result(live_bundle, key, payload), 403, *_FORBIDDEN)
    assert success_data(await client.get("/api/v1/account"))["id"] == live_bundle.actor_id
    assert await _import_counts(live_bundle) == (1, 1, 1)
    assert await _retained_import(live_bundle, first, key, payload) == retained
    await _assert_retained_archive(live_bundle, expired_at)
