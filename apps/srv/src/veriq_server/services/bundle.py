"""Export exact published dependency bytes and provenance, without executing or resolving secrets."""

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
from ..bundles.issuer import Issuer
from ..contracts import asset_source_hash, canonical_bytes, validate_schema
from ..credentials.registry import IdentityRegistry
from ..db import Bundle, User
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, now, stamp, lock_installation
from ..settings import Settings
from .engines import ApprovedEngines
from .resource import asset_references, check_document, document_hash, resource_dto, version_dto
from .resource_source import compiled_source
from .workspace import WorkspaceRepository

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_OUTPUT = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_FILES = 4096


def safe_path(path: str) -> bool:
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
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "manifestSha256": row.manifest_hash,
        "snapshotSha256": row.snapshot_hash,
        "validationStatus": row.validation_status,
        "createdAt": stamp(row.created_at),
    }


class BundleService:
    def __init__(
        self,
        session: AsyncSession,
        actor: User,
        settings: Settings,
        reauthorize: Callable[[AsyncSession], Awaitable[User]] | None = None,
    ):
        self.session, self.actor, self.settings = session, actor, settings
        self.reauthorize = reauthorize

    async def export(self, scope: WorkspaceScope, req: dict[str, Any]) -> dict[str, Any]:
        """Own the two transactions; callers supply a session without an outer begin block."""
        await lock_installation(self.session)
        await self.session.refresh(self.actor)
        prepared = await self.prepare(scope, req)
        await self.session.commit()
        assembled = await asyncio.to_thread(self.assemble, prepared)
        await lock_installation(self.session)
        self.session.expire_all()
        await self.session.refresh(self.actor)
        if self.reauthorize:
            self.actor = await self.reauthorize(self.session)
        result = await self.publish(scope, prepared, assembled)
        await self.session.commit()
        return result

    async def authorize(self, scope: WorkspaceScope) -> None:
        await WorkspaceRepository(self.session, scope).authorize(self.actor, Permission.DOWNLOAD)

    async def get(self, scope: WorkspaceScope, bundle_id: str) -> Bundle:
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
        await self.authorize(scope)
        issuer = Issuer(self.settings.bundle_issuer_path)
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
            engine, _ = ApprovedEngines(self.settings).require(engine_version)
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
        }

    @staticmethod
    def assemble(prepared: dict[str, Any]) -> tuple[bytes, bytes, bytes]:
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
        await self.authorize(scope)
        if "draftValidationJobId" in prepared["request"]:
            await WorkspaceRepository(self.session, scope).authorize(self.actor, Permission.EDIT)
        current = Issuer(self.settings.bundle_issuer_path)
        if current.public() != prepared["issuer"].public():
            raise Problem(409, "ISSUER_CHANGED", "Issuer changed during export; retry")
        await IdentityRegistry().freeze(self.session, scope, prepared["roles"])
        if "draftValidationJobId" not in prepared["request"]:
            engine, _ = ApprovedEngines(self.settings).require(
                prepared["manifest"]["engineVersion"]
            )
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
