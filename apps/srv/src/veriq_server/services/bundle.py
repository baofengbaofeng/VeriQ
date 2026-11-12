"""离线包导出：幂等预订、准备清单、组装签名归档，下载受 Workspace 授权与导出槽位并发限制，本文件注释描述专属不变量。
safe_path 防止路径穿越；publish 在签发后落 Bundle 元数据，replay 重放同一 Idempotency-Key。
"""


import asyncio
import io
import json
import re
import zipfile
from datetime import timedelta
from hashlib import sha256
from typing import Any
from collections.abc import Awaitable, Callable
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..bundles.authority import authority_guard
from ..contracts import asset_source_hash, canonical_bytes, validate_schema
from ..credentials.registry import IdentityRegistry
from ..db import Bundle, BundleExport, User
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, now, stamp, lock_installation
from ..settings import Settings
from .resource import asset_references, check_document, document_hash, resource_dto, version_dto
from .resource_source import compiled_source
from .workspace import WorkspaceRepository

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_OUTPUT = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_FILES = 4096


def safe_path(path: str) -> bool:
    """校验包内相对路径不含穿越或绝对前缀，防止写出 Workspace 外位置，safe_path 遵守本文件边界，失败返回稳定 Problem。
    safe_path 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return bool(
        len(path) <= 240
        and all(
            re.fullmatch(r"[A-Za-z0-9_@.-]+", part)
            and part not in {".", ".."}
            and not part.endswith((".", " "))
            and not re.match(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", part, re.I)
            for part in path.split("/")
        )
    )


def bundle_dto(row: Bundle) -> dict[str, Any]:
    """导出 Bundle 元数据字段供列表与详情，不含归档私有密钥，bundle_dto 遵守本文件边界，失败返回稳定 Problem。
    bundle_dto 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "manifestSha256": row.manifest_hash,
        "snapshotSha256": row.snapshot_hash,
        "validationStatus": row.validation_status,
        "createdAt": stamp(row.created_at),
    }


class BundleService:
    """编排导出预订、准备、组装与发布，全程绑定 Workspace 与幂等键，BundleService 遵守本文件边界，失败返回稳定 Problem。
    BundleService 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    def __init__(
        self,
        session: AsyncSession,
        actor: User,
        settings: Settings,
        reauthorize: Callable[[AsyncSession], Awaitable[User]] | None = None,
    ):
        """注入会话、用户、设置与导出信号量，限制并发组装，BundleService.__init__ 遵守本文件边界，失败返回稳定 Problem。
        __init__ 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.session, self.actor, self.settings = session, actor, settings
        self.reauthorize = reauthorize

    async def export(self, scope: WorkspaceScope, req: dict[str, Any], key: str) -> dict[str, Any]:
        """幂等导出入口：预订或重放，返回 bundle 标识与状态，BundleService.export 遵守本文件边界，失败返回稳定 Problem。
        export 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if (
            not key
            or len(key) > 160
            or not key.isascii()
            or any(ord(c) < 33 or ord(c) > 126 for c in key)
        ):
            raise Problem(
                400, "IDEMPOTENCY_KEY_REQUIRED", "Bounded printable ASCII idempotency key required"
            )
        request_hash = sha256(
            canonical_bytes({"actorId": self.actor.id, "request": req})
        ).hexdigest()
        reservation_id: str | None = None
        # identity() may have started a read transaction; no configuration guard
        # is ever acquired with a database transaction still open.
        await self.session.commit()
        try:
            async with authority_guard(self.settings, "draftValidationJobId" in req) as authority:
                self.issuer, self.engines = authority
                await lock_installation(self.session)
                await self.session.refresh(self.actor)
                if self.reauthorize:
                    self.actor = await self.reauthorize(self.session)
                await self.authorize(scope)
                if "draftValidationJobId" in req:
                    await WorkspaceRepository(self.session, scope).authorize(
                        self.actor, Permission.EDIT
                    )
                existing = (
                    await self.session.execute(
                        select(BundleExport).where(
                            BundleExport.workspace_id == scope.workspace_id,
                            BundleExport.idempotency_key == key,
                        )
                    )
                ).scalar_one_or_none()
                if existing:
                    if existing.actor_id != self.actor.id or existing.request_hash != request_hash:
                        raise Problem(409, "IDEMPOTENCY_CONFLICT", "Bundle export request changed")
                    if existing.state != "COMPLETE":
                        raise Problem(
                            409,
                            "BUNDLE_EXPORT_" + existing.state,
                            "Export cannot be automatically repeated; use a new key only after reconciling the prior request",
                        )
                    result = await self.replay(scope, existing)
                    await self.session.commit()
                    return result
                prepared = await self.prepare(scope, req)
                reservation_id = str(uuid4())
                self.session.add(
                    BundleExport(
                        id=reservation_id,
                        workspace_id=scope.workspace_id,
                        idempotency_key=key,
                        actor_id=self.actor.id,
                        request_hash=request_hash,
                        state="IN_PROGRESS",
                        authority={
                            "roles": prepared["roles"],
                            "issuerId": prepared["manifest"]["issuerId"],
                            "keyId": prepared["manifest"]["keyId"],
                            "keyFingerprint": next(
                                k["fingerprint"]
                                for k in prepared["issuer"].public()["keys"]
                                if k["keyId"] == prepared["manifest"]["keyId"]
                            ),
                            "engine": prepared.get("engine"),
                            "draft": "draftValidationJobId" in req,
                        },
                        created_at=now(),
                    )
                )
                await self.session.commit()
            assembled = await asyncio.to_thread(self.assemble, prepared)
            async with authority_guard(self.settings, "draftValidationJobId" in req) as authority:
                self.issuer, self.engines = authority
                await lock_installation(self.session)
                self.session.expire_all()
                await self.session.refresh(self.actor)
                if self.reauthorize:
                    self.actor = await self.reauthorize(self.session)
                result = await self.publish(scope, prepared, assembled)
                await self.session.flush()
                reservation = await self.session.get(BundleExport, reservation_id)
                assert reservation is not None and reservation.state == "IN_PROGRESS"
                reservation.state, reservation.bundle_id = "COMPLETE", result["id"]
                await self.session.commit()
            return result
        except BaseException:
            await self.session.rollback()
            if reservation_id:
                # An uncertain commit must never overwrite COMPLETE. If this cleanup
                # itself cannot commit, IN_PROGRESS remains safely unreplayable.
                async with self.session.begin():
                    await lock_installation(self.session)
                    reservation = await self.session.get(
                        BundleExport, reservation_id, populate_existing=True
                    )
                    if reservation and reservation.state == "IN_PROGRESS":
                        reservation.state = "FAILED"
            raise

    async def replay(self, scope: WorkspaceScope, reservation: BundleExport) -> dict[str, Any]:
        """对已有 BundleExport 预订重放组装结果，不重新解释不同请求，BundleService.replay 遵守本文件边界。
        replay 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        assert reservation.bundle_id is not None
        row = await self.get(scope, reservation.bundle_id)
        authority = reservation.authority
        public = self.issuer.public()
        if public["issuerId"] != authority["issuerId"] or not any(
            k["keyId"] == authority["keyId"]
            and k["fingerprint"] == authority["keyFingerprint"]
            and not k["revoked"]
            for k in public["keys"]
        ):
            raise Problem(409, "ISSUER_CHANGED", "Original bundle signing key is unavailable")
        await IdentityRegistry().freeze(self.session, scope, authority["roles"])
        if authority["engine"] is not None:
            engine, _ = self.engines.require(authority["engine"]["engineVersion"])
            if engine != authority["engine"]:
                raise Problem(409, "ENGINE_CHANGED", "Original approved engine changed")
        repo = ResourceRepository(self.session, scope)
        await repo.artifact(row.archive_hash)
        return bundle_dto(row)

    async def authorize(self, scope: WorkspaceScope) -> None:
        """校验用户对 Workspace 的导出/下载类权限，BundleService.authorize 遵守本文件边界，失败返回稳定 Problem。
        authorize 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        await WorkspaceRepository(self.session, scope).authorize(self.actor, Permission.DOWNLOAD)

    async def get(self, scope: WorkspaceScope, bundle_id: str) -> Bundle:
        """按 Workspace 加载 Bundle，缺失返回 Problem，BundleService.get 遵守本文件边界。
        get 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        await self.authorize(scope)
        row = (
            await self.session.execute(
                select(Bundle).where(
                    Bundle.workspace_id == scope.workspace_id, Bundle.id == bundle_id
                )
            )
        ).scalar_one_or_none()
        if not row:
            raise Problem(404, "BUNDLE_NOT_FOUND", "Bundle not found")
        if row.contains_draft:
            await WorkspaceRepository(self.session, scope).authorize(self.actor, Permission.EDIT)
        return row

    async def prepare(self, scope: WorkspaceScope, req: dict[str, Any]) -> dict[str, Any]:
        """冻结导出所需版本与产物清单，写入临时准备结构，BundleService.prepare 遵守本文件边界，失败返回稳定 Problem。
        prepare 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        await self.authorize(scope)
        issuer = self.issuer
        repo = ResourceRepository(self.session, scope)
        if sum(k in req for k in ("caseVersionIds", "suiteVersionId", "draftValidationJobId")) != 1:
            raise Problem(400, "INVALID_SELECTION", "Select CASE versions or one SUITE")
        draft_mode = "draftValidationJobId" in req
        draft_source: dict[str, Any] | None = None
        if draft_mode:
            await WorkspaceRepository(self.session, scope).authorize(self.actor, Permission.EDIT)
            if req["validationStatus"] != "UNVALIDATED_DEBUG":
                raise Problem(400, "INVALID_SELECTION", "Draft packages require DEBUG")
            draft_job = await repo.job(req["draftValidationJobId"])
            if draft_job.kind != "VALIDATE":
                raise Problem(422, "INVALID_SELECTION", "Immutable validation candidate required")
            draft_raw = (await repo.artifact(draft_job.snapshot_hash)).content
            draft_source = json.loads(draft_raw)
            if (
                validate_schema("AssetSnapshotV1", draft_source)
                or draft_source["workspaceId"] != scope.workspace_id
                or asset_source_hash(draft_source) != draft_source["sourceHash"]
            ):
                raise Problem(409, "INVALID_SNAPSHOT", "Original draft source differs")
            draft_root = next(
                a
                for a in draft_source["assets"]
                if a["versionId"] == draft_source["validationTarget"]["versionId"]
            )
            if draft_root["kind"] not in {"CASE", "SUITE"}:
                raise Problem(422, "INVALID_SELECTION", "Draft CASE or SUITE required")
            roots = [draft_root["versionId"]]
        else:
            roots = req.get("caseVersionIds", [req.get("suiteVersionId")])
        if not roots or len(roots) > 100 or len(set(roots)) != len(roots):
            raise Problem(400, "INVALID_SELECTION", "Select one to 100 unique published versions")
        assets: dict[str, Any] = {}
        versions: list[dict[str, Any]] = []
        resources: dict[str, Any] = {}
        visiting: set[str] = set()
        files: dict[str, bytes] = {}
        used_paths: set[str] = set()
        total = 0
        source_size = 0
        engine_version: str | None = None

        def add(path: str, raw: bytes) -> None:
            nonlocal total
            if not safe_path(path) or path.lower() in used_paths:
                raise Problem(409, "INVALID_ARTIFACT", "Unsafe or duplicate bundle member")
            total += len(raw)
            if len(raw) > MAX_FILE or total > MAX_OUTPUT or len(files) >= MAX_FILES - 2:
                raise Problem(413, "BUNDLE_TOO_LARGE", "Bundle exceeds documented file/byte limits")
            used_paths.add(path.lower())
            files[path] = raw

        async def visit(version_id: str, expected_kind: str) -> None:
            nonlocal source_size, engine_version
            if version_id in visiting:
                raise Problem(422, "DEPENDENCY_CYCLE", "Dependency cycle")
            if version_id in assets:
                if assets[version_id]["kind"] != expected_kind:
                    raise Problem(422, "INVALID_REFERENCE", "Dependency kind differs")
                return
            if len(assets) + len(visiting) >= 1000 or len(visiting) >= 100:
                raise Problem(422, "DEPENDENCY_LIMIT", "Dependency closure exceeds limits")
            visiting.add(version_id)
            version = await repo.version(version_id)
            resource = await repo.resource(version.resource_id)
            content = version.document_json
            check_document(expected_kind, content)
            if version.kind != expected_kind or document_hash(content) != version.sha256:
                raise Problem(422, "INVALID_REFERENCE", "Published dependency integrity differs")
            if engine_version and engine_version != version.engine_version:
                raise Problem(409, "ENGINE_MISMATCH", "Dependency engine versions differ")
            engine_version = version.engine_version
            asset = {
                "resourceId": resource.id,
                "versionId": version.id,
                "sha256": version.sha256,
                **content,
            }
            source_size += len(canonical_bytes(asset))
            if source_size > 16 * 1024 * 1024:
                raise Problem(413, "SNAPSHOT_TOO_LARGE", "Dependency closure exceeds 16 MiB")
            # The existing source endpoint enforces original receipt/job/version provenance.
            metadata, _ = await compiled_source(repo, resource.id, version.id, None)
            receipt = await repo.receipt(version.receipt_id)
            assert receipt is not None
            job = await repo.job(receipt.job_id)
            source_raw = (await repo.artifact(job.snapshot_hash)).content
            source = json.loads(source_raw)
            if (
                validate_schema("AssetSnapshotV1", source)
                or source["workspaceId"] != scope.workspace_id
                or asset_source_hash(source) != receipt.source_hash
                or source["sourceHash"] != receipt.source_hash
                or source.get("validationTarget", {}).get("versionId") != version.id
                or next((a for a in source["assets"] if a["versionId"] == version.id), None)
                != asset
            ):
                raise Problem(409, "INVALID_RECEIPT", "Original source provenance differs")
            descriptor_raw = (await repo.artifact(metadata["descriptorSha256"])).content
            descriptor = json.loads(descriptor_raw)
            prefix = f"provenance/{version.id}"
            add(prefix + "/source.json", source_raw)
            add(prefix + "/descriptor.json", descriptor_raw)
            add(
                prefix + "/receipt.json",
                canonical_bytes(
                    {
                        "receiptId": receipt.id,
                        "jobId": job.id,
                        "attemptId": receipt.attempt_id,
                        "runtimeId": receipt.runtime_id,
                        "sourceHash": receipt.source_hash,
                        "compiledBundleSha256": receipt.compiled_bundle_sha256,
                        "engineVersion": receipt.engine_version,
                        "compilerTrust": receipt.compiler_trust,
                        "revision": receipt.revision,
                        "validatedAt": stamp(receipt.validated_at),
                    }
                ),
            )
            for entry in [] if draft_mode else descriptor["files"]:
                body = (await repo.artifact(entry["sha256"])).content
                if len(body) != entry["sizeBytes"]:
                    raise Problem(409, "INVALID_ARTIFACT", "Compiled byte size differs")
                add(f"compiled/{version.id}/{entry['path']}", body)
            add(f"assets/{version.id}.json", canonical_bytes(asset))
            for child, kind in asset_references(content):
                await visit(child, kind)
            assets[version.id] = asset
            versions.append(version_dto(version))
            resources[resource.id] = resource_dto(resource)
            visiting.remove(version.id)

        if draft_source is not None:
            assets[draft_root["versionId"]] = draft_root
            source_size = len(canonical_bytes(draft_root))
            engine_version = draft_source["engineVersion"]
            add("draft/source.json", draft_raw)
            add("draft/metadata.json", canonical_bytes({"frozenAt": stamp(draft_job.created_at)}))
            add(f"assets/{draft_root['versionId']}.json", canonical_bytes(draft_root))
            resource = await repo.resource(draft_root["resourceId"])
            resources[resource.id] = resource_dto(resource)
            for child, kind in asset_references(draft_root):
                await visit(child, kind)
            original = {a["versionId"]: a for a in draft_source["assets"]}
            if original != assets:
                raise Problem(409, "INVALID_SNAPSHOT", "Draft dependency closure differs")
        else:
            for root in roots:
                await visit(root, "SUITE" if "suiteVersionId" in req else "CASE")
        await visit(req["environmentVersionId"], "ENVIRONMENT")
        environment = assets[req["environmentVersionId"]]["document"]
        roles = [*environment["roles"]]
        if environment.get("fixtureIdentity"):
            roles.append(environment["fixtureIdentity"])
        adapters = await IdentityRegistry().freeze(self.session, scope, roles)
        assert engine_version is not None
        if draft_mode:
            add(
                "engine/requirements.json",
                canonical_bytes(
                    {"engineVersion": engine_version, "localCompilationRequired": True}
                ),
            )
        else:
            engine, _ = self.engines.require(engine_version)
            add(
                "engine/inventory.json",
                canonical_bytes({"schemaVersion": "1.0", "engines": [engine]}),
            )
            # Platform-specific release archives remain separately installed. Preserve lock metadata.
            for entry in engine["files"]:
                if entry["path"] in {"package.json", "package-lock.json", "dependencies.json"}:
                    raw = (await repo.artifact(entry["sha256"])).content
                    if len(raw) != entry["sizeBytes"]:
                        raise Problem(409, "INVALID_ARTIFACT", "Engine metadata size differs")
                    add("engine/" + entry["path"], raw)
        snapshot = {
            "schemaVersion": "1.0",
            "workspaceId": scope.workspace_id,
            "sourceHash": "0" * 64,
            "engineVersion": engine_version,
            "entryCaseVersionIds": sorted(
                a["versionId"] for a in assets.values() if a["kind"] == "CASE"
            ),
            "assets": [assets[k] for k in sorted(assets)],
            "authAdapters": adapters,
        }
        if draft_source is not None:
            snapshot["validationTarget"] = draft_source["validationTarget"]
        snapshot["sourceHash"] = asset_source_hash(snapshot)
        if validate_schema("AssetSnapshotV1", snapshot):
            raise Problem(409, "INVALID_SNAPSHOT", "Export snapshot is invalid")
        snapshot_raw = canonical_bytes(snapshot)
        add("snapshot.json", snapshot_raw)
        add("selection.json", canonical_bytes(req))
        # A local snapshot's default version must be one actually included in this export.
        for metadata in resources.values():
            available = [version for version in versions if version["resourceId"] == metadata["id"]]
            metadata.pop("latestVersionId", None)
            if available:
                metadata["latestVersionId"] = max(
                    available, key=lambda version: version["versionNo"]
                )["id"]
        add(
            "resources.json",
            canonical_bytes({"resources": list(resources.values()), "versions": versions}),
        )
        created = now()
        bundle_id = str(uuid4())
        manifest = {
            "schemaVersion": "1.0",
            "bundleId": bundle_id,
            "workspaceId": scope.workspace_id,
            "issuerId": issuer.data["issuerId"],
            "keyId": issuer.data["activeKeyId"],
            "createdAt": stamp(created),
            "expiresAt": stamp(created + timedelta(days=self.settings.bundle_lifetime_days)),
            "sourceHash": snapshot["sourceHash"],
            "snapshotSha256": sha256(snapshot_raw).hexdigest(),
            "engineVersion": engine_version,
            "validationStatus": req["validationStatus"],
            "files": [
                {"path": path, "sha256": sha256(raw).hexdigest(), "sizeBytes": len(raw)}
                for path, raw in sorted(files.items())
            ],
        }
        return {
            "manifest": manifest,
            "files": files,
            "snapshot": snapshot_raw,
            "roles": roles,
            "issuer": issuer,
            "created": created,
            "request": req,
            "engine": None if draft_mode else engine,
        }

    @staticmethod
    def assemble(prepared: dict[str, Any]) -> tuple[bytes, bytes, bytes]:
        """将准备结果打包为清单、归档与签名字节三元组，BundleService.assemble 遵守本文件边界，失败返回稳定 Problem。
        assemble 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        manifest_raw = canonical_bytes(prepared["manifest"])
        signature = prepared["issuer"].sign(manifest_raw)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", manifest_raw)
            archive.writestr("manifest.sig", signature)
            for path, raw in sorted(prepared["files"].items()):
                archive.writestr(path, raw)
        archive_raw = output.getvalue()
        if len(archive_raw) > MAX_ARCHIVE:
            raise Problem(413, "BUNDLE_TOO_LARGE", "Archive exceeds 64 MiB")
        return manifest_raw, signature, archive_raw

    async def publish(
        self, scope: WorkspaceScope, prepared: dict[str, Any], assembled: tuple[bytes, bytes, bytes]
    ) -> dict[str, Any]:
        """签发并持久化 Bundle 元数据，供后续授权下载，BundleService.publish 遵守本文件边界，失败返回稳定 Problem。
        publish 实现于 apps/srv/src/veriq_server/services/bundle.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        await self.authorize(scope)
        if "draftValidationJobId" in prepared["request"]:
            await WorkspaceRepository(self.session, scope).authorize(self.actor, Permission.EDIT)
        current = self.issuer
        if current.public() != prepared["issuer"].public():
            raise Problem(409, "ISSUER_CHANGED", "Issuer changed during export; retry")
        await IdentityRegistry().freeze(self.session, scope, prepared["roles"])
        if "draftValidationJobId" not in prepared["request"]:
            engine, _ = self.engines.require(prepared["manifest"]["engineVersion"])
            if (
                canonical_bytes({"schemaVersion": "1.0", "engines": [engine]})
                != prepared["files"]["engine/inventory.json"]
            ):
                raise Problem(409, "ENGINE_CHANGED", "Approved engine changed during export; retry")
        manifest_raw, signature, archive_raw = assembled
        repo = ResourceRepository(self.session, scope)
        row = Bundle(
            id=prepared["manifest"]["bundleId"],
            workspace_id=scope.workspace_id,
            exported_by=self.actor.id,
            manifest_hash=await repo.store(manifest_raw),
            archive_hash=await repo.store(archive_raw, "application/zip"),
            snapshot_hash=await repo.store(prepared["snapshot"]),
            signature=signature,
            validation_status=prepared["manifest"]["validationStatus"],
            contains_draft="draftValidationJobId" in prepared["request"],
            created_at=prepared["created"],
        )
        self.session.add(row)
        audit(
            self.session, "bundle.exported", self.actor.id, row.id, workspace_id=scope.workspace_id
        )
        return bundle_dto(row)
