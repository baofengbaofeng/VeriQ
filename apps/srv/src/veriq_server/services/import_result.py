"""Separate, reauthorized offline writer. Bundle signatures never certify local results."""

import asyncio
import base64
import io
import json
import re
import zipfile
from datetime import datetime
from hashlib import sha256
from typing import Any
from collections.abc import Awaitable, Callable
from sqlalchemy.ext.asyncio import AsyncSession
from ..settings import Settings
from ..bundles.issuer import Issuer
from .engines import ApprovedEngines
from uuid import uuid4
from sqlalchemy import select
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from ..auth.authorization import Permission, WorkspaceScope
from ..bundles.authority import authority_guard
from ..contracts import canonical_bytes, asset_source_hash, validate_schema
from ..db import (
    BundleExport,
    Bundle,
    OfflineImport,
    OfflineImportKey,
    OfflineAttempt,
    OfflineImportUpload,
    Run,
    CaseExecution,
    User,
)
from ..repositories.resource import ResourceRepository
from ..service import Problem, now, lock_installation
from .bundle import BundleService, safe_path, MAX_ARCHIVE, MAX_FILE, MAX_OUTPUT, MAX_FILES
from .workspace import WorkspaceRepository
from .results import aggregate, reduce_test
from .completion import retry_is_safe


def verify_archive(raw: bytes, manifest_hash: str, public: dict[str, Any]) -> dict[str, Any]:
    """Bounded decoding of stored immutable signed content, outside authority locks."""
    try:
        if len(raw) > MAX_ARCHIVE:
            raise ValueError()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if (
                len(entries) > MAX_FILES
                or sum(e.file_size for e in entries) > MAX_OUTPUT
                or any(e.file_size > MAX_FILE or not safe_path(e.filename) for e in entries)
                or len({e.filename.lower() for e in entries}) != len(entries)
            ):
                raise ValueError()
            files = {e.filename: archive.read(e) for e in entries}
        manifest_raw = files.pop("manifest.json")
        signature = files.pop("manifest.sig")
        manifest = json.loads(manifest_raw)
        if sha256(manifest_raw).hexdigest() != manifest_hash or validate_schema(
            "BundleManifestV1", manifest
        ):
            raise ValueError()
        key = next(
            k for k in public["keys"] if k["keyId"] == manifest["keyId"] and not k["revoked"]
        )
        if public["issuerId"] != manifest["issuerId"]:
            raise ValueError()
        Ed25519PublicKey.from_public_bytes(base64.b64decode(key["publicKey"])).verify(
            signature, manifest_raw
        )
        if set(files) != {f["path"] for f in manifest["files"]}:
            raise ValueError()
        for f in manifest["files"]:
            if (
                len(files[f["path"]]) != f["sizeBytes"]
                or sha256(files[f["path"]]).hexdigest() != f["sha256"]
            ):
                raise ValueError()
        snapshot = json.loads(files["snapshot.json"])
        if (
            validate_schema("AssetSnapshotV1", snapshot)
            or asset_source_hash(snapshot) != manifest["sourceHash"]
            or sha256(files["snapshot.json"]).hexdigest() != manifest["snapshotSha256"]
            or snapshot["workspaceId"] != manifest["workspaceId"]
        ):
            raise ValueError()
        return {
            "manifest": manifest,
            "snapshot": snapshot,
            "files": files,
            "selection": json.loads(files["selection.json"]),
        }
    except (
        ValueError,
        KeyError,
        TypeError,
        StopIteration,
        zipfile.BadZipFile,
        InvalidSignature,
        RuntimeError,
        NotImplementedError,
    ):
        raise Problem(
            409, "INVALID_SIGNED_BUNDLE", "Stored signed bundle is invalid or revoked"
        ) from None


def expected_variants(checked: dict[str, Any], result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Derive bounded selection facts from signed assets, never a caller-supplied plan."""
    assets = {a["versionId"]: a for a in checked["snapshot"]["assets"]}
    selection, files = checked["selection"], checked["files"]
    draft = "draft/source.json" in files
    target = checked["snapshot"].get("validationTarget", {}).get("versionId")
    suite = selection.get("suiteVersionId") or (
        target if draft and assets.get(target, {}).get("kind") == "SUITE" else None
    )
    entries = (
        assets[suite]["document"]["cases"]
        if suite
        else [
            {"versionId": case}
            for case in selection.get("caseVersionIds", checked["snapshot"]["entryCaseVersionIds"])
        ]
    )
    expected: dict[str, dict[str, Any]] = {}
    for ordinal, entry in enumerate(entries):
        case = entry["versionId"]
        document = assets[case]["document"]
        root = suite or case
        source = files.get("draft/source.json" if draft else f"provenance/{root}/source.json")
        if source is None:
            raise Problem(409, "SOURCE_UNAVAILABLE", "Selected compilation source is unavailable")
        provenance = {
            "compilationSourceHash": json.loads(source)["sourceHash"],
            "compilationSourceSha256": sha256(source).hexdigest(),
            "compilationRootVersionId": root,
            "dslOnly": draft,
        }
        for name, path in [
            ("publishedDependencySourceSha256", f"provenance/{case}/source.json"),
            ("publishedDependencyReceiptSha256", f"provenance/{case}/receipt.json"),
            ("compilationDescriptorSha256", f"provenance/{root}/descriptor.json"),
            ("compilationReceiptSha256", f"provenance/{root}/receipt.json"),
        ]:
            if path in files and (not draft or name.startswith("publishedDependency")):
                provenance[name] = sha256(files[path]).hexdigest()
        dataset = entry.get("datasetVersionId", document.get("datasetVersionId"))
        data_rows = assets[dataset]["document"]["rows"] if dataset else [None]
        for role in entry.get("roleKeys", [document["roleKey"]]):
            for browser in entry.get(
                "browsers", result.get("executionChoices", {}).get("browsers", ["chromium"])
            ):
                for data in data_rows:
                    key = sha256(
                        canonical_bytes(
                            [case, ordinal, role, browser, dataset, data["key"] if data else None]
                        )
                    ).hexdigest()
                    expected[key] = {
                        "variant": key,
                        "caseVersionId": case,
                        "source": source,
                        "root": root,
                        "draft": draft,
                        "attempts": [],
                        "outcome": "INCOMPLETE",
                        "compilation": provenance,
                        "selection": {
                            "variantKey": key,
                            "suiteEntryIndex": ordinal,
                            "roleKey": role,
                            "browser": browser,
                            "datasetVersionId": dataset,
                            "dataRow": data,
                        },
                    }
                    if len(expected) > 1000:
                        raise Problem(
                            422, "MATRIX_LIMIT", "Selected offline matrix exceeds 1000 variants"
                        )
    if not expected:
        raise Problem(422, "EMPTY_EXECUTION_MATRIX", "Signed selection has no variants")
    return expected


class ImportService:
    def __init__(
        self,
        session: AsyncSession,
        actor: User,
        settings: Settings,
        reauthorize: Callable[[AsyncSession], Awaitable[User]] | None = None,
    ):
        self.session, self.actor, self.settings, self.reauthorize = (
            session,
            actor,
            settings,
            reauthorize,
        )

    async def authorize(
        self, scope: WorkspaceScope, bundle_id: str, authority: tuple[Issuer, ApprovedEngines]
    ) -> Bundle:
        await self.session.refresh(self.actor)
        if self.reauthorize:
            self.actor = await self.reauthorize(self.session)
        await WorkspaceRepository(self.session, scope).authorize(
            self.actor, Permission.EXECUTE, write=True
        )
        service = BundleService(self.session, self.actor, self.settings)
        service.issuer, service.engines = authority
        row = await service.get(scope, bundle_id)
        reservation = (
            await self.session.execute(
                select(BundleExport).where(
                    BundleExport.workspace_id == scope.workspace_id,
                    BundleExport.bundle_id == bundle_id,
                )
            )
        ).scalar_one_or_none()
        if not reservation:
            raise Problem(409, "BUNDLE_PROVENANCE_MISSING", "Export provenance is unavailable")
        await service.replay(scope, reservation)
        return row

    async def import_result(
        self, scope: WorkspaceScope, result: dict[str, Any], key: str
    ) -> dict[str, Any]:
        if not re.fullmatch(r"[!-~]{1,160}", key):
            raise Problem(
                400, "IDEMPOTENCY_KEY_REQUIRED", "Printable bounded idempotency key required"
            )
        if (
            validate_schema("OfflineResultV1", result)
            or result["workspaceId"] != scope.workspace_id
        ):
            raise Problem(400, "INVALID_OFFLINE_RESULT", "Result schema or Workspace is invalid")
        if len(canonical_bytes(result)) > 8 * 1024 * 1024:
            raise Problem(413, "RESULT_LIMIT", "Result exceeds 8 MiB")
        request_hash = sha256(canonical_bytes(result)).hexdigest()
        await self.session.commit()
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            row = await self.authorize(scope, result["bundleId"], authority)
            if row.manifest_hash != result["manifestSha256"]:
                raise Problem(
                    409, "BUNDLE_MANIFEST_MISMATCH", "Result identifies a different manifest"
                )
            raw = (await ResourceRepository(self.session, scope).artifact(row.archive_hash)).content
            public = authority[0].public()
            manifest_hash = row.manifest_hash
            await self.session.commit()
        checked = await asyncio.to_thread(verify_archive, raw, manifest_hash, public)
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            await self.authorize(scope, result["bundleId"], authority)
            # Current engine, draft and nested resource closure authority is checked again.
            service = BundleService(self.session, self.actor, self.settings)
            service.issuer, service.engines = authority
            prepared = await service.prepare(scope, checked["selection"])
            if json.loads(prepared["snapshot"]) != checked["snapshot"]:
                raise Problem(409, "BUNDLE_SOURCE_CHANGED", "Current immutable closure differs")
            existing_key = await self.session.get(OfflineImportKey, (scope.workspace_id, key))
            if existing_key and (
                existing_key.actor_id != self.actor.id or existing_key.request_hash != request_hash
            ):
                raise Problem(409, "IDEMPOTENCY_CONFLICT", "Import header is already bound")
            existing = (
                await self.session.execute(
                    select(OfflineImport).where(
                        OfflineImport.workspace_id == scope.workspace_id,
                        OfflineImport.bundle_id == result["bundleId"],
                        OfflineImport.local_run_id == result["localRunId"],
                    )
                )
            ).scalar_one_or_none()
            if existing:
                if existing.request_hash != request_hash:
                    raise Problem(409, "IDEMPOTENCY_CONFLICT", "Local Run payload changed")
                if not existing_key:
                    self.session.add(
                        OfflineImportKey(
                            workspace_id=scope.workspace_id,
                            key=key,
                            import_id=existing.id,
                            actor_id=self.actor.id,
                            request_hash=request_hash,
                        )
                    )
                await self.session.commit()
                return self.receipt(existing, True)
            rows = await self.validate_facts(scope, result, checked)
            repo = ResourceRepository(self.session, scope)
            run = Run(
                id=str(uuid4()),
                workspace_id=scope.workspace_id,
                created_by=self.actor.id,
                idempotency_key="offline_" + str(uuid4()),
                request_hash=request_hash,
                trigger_kind="OFFLINE_IMPORT",
                source="OFFLINE_IMPORT",
                state="FINISHED",
                outcome=aggregate([r["outcome"] for r in rows]),
                snapshot_hash=await repo.store(
                    canonical_bytes(
                        {"bundleId": result["bundleId"], "localRunId": result["localRunId"]}
                    )
                ),
                created_at=now(),
            )
            self.session.add(run)
            await self.session.flush()
            imported = OfflineImport(
                id=str(uuid4()),
                workspace_id=scope.workspace_id,
                bundle_id=result["bundleId"],
                local_run_id=result["localRunId"],
                actor_id=self.actor.id,
                run_id=run.id,
                request_hash=request_hash,
                declared={k: v for k, v in result.items() if k != "attempts"},
                verified={
                    "source": "OFFLINE_IMPORT",
                    "officialGatePassed": False,
                    "manifestSha256": manifest_hash,
                    "issuerId": checked["manifest"]["issuerId"],
                    "keyId": checked["manifest"]["keyId"],
                    "revocationStatus": "CURRENT",
                    "validationStatus": checked["manifest"]["validationStatus"],
                    "resultAuthenticity": "UNVERIFIED",
                    "dirty": result["dirty"]
                    or result["actualEnvironment"]
                    != next(
                        a["document"]
                        for a in checked["snapshot"]["assets"]
                        if a["versionId"] == checked["selection"]["environmentVersionId"]
                    )
                    or checked["manifest"]["validationStatus"] != "VALIDATED",
                    "expired": datetime.fromisoformat(
                        checked["manifest"]["expiresAt"].replace("Z", "+00:00")
                    ).timestamp()
                    <= now().timestamp(),
                },
                created_at=now(),
            )
            self.session.add(imported)
            await self.session.flush()
            self.session.add(
                OfflineImportKey(
                    workspace_id=scope.workspace_id,
                    key=key,
                    import_id=imported.id,
                    actor_id=self.actor.id,
                    request_hash=request_hash,
                )
            )
            for reduced in rows:
                candidate = (
                    checked["snapshot"].get("validationTarget", {}).get("versionId")
                    == reduced["caseVersionId"]
                    and "draft/source.json" in checked["files"]
                )
                execution = CaseExecution(
                    id=str(uuid4()),
                    workspace_id=scope.workspace_id,
                    run_id=run.id,
                    case_version_id=reduced["caseVersionId"],
                    published_case_version_id=None if candidate else reduced["caseVersionId"],
                    candidate_version_id=reduced["caseVersionId"] if candidate else None,
                    source_snapshot_hash=await repo.store(reduced["source"]),
                    variant_key=reduced["variant"],
                    provenance={
                        "source": "OFFLINE_IMPORT",
                        "declared": imported.declared,
                        "verified": imported.verified,
                        "selection": {
                            **{k: v for k, v in reduced["selection"].items() if k != "dataRow"},
                            "dataRowKey": (reduced["selection"]["dataRow"] or {}).get("key"),
                        },
                        "compilation": reduced["compilation"],
                    },
                    state="FINISHED",
                    outcome=reduced["outcome"],
                )
                self.session.add(execution)
                await self.session.flush()
                for attempt, facts in reduced["attempts"]:
                    self.session.add(
                        OfflineAttempt(
                            id=str(uuid4()),
                            workspace_id=scope.workspace_id,
                            import_id=imported.id,
                            case_execution_id=execution.id,
                            local_attempt_id=attempt["attemptId"],
                            attempt_no=attempt["attemptNo"],
                            outcome=facts["outcome"],
                            facts=facts,
                            document=attempt,
                        )
                    )
            await self.session.commit()
            return self.receipt(imported, False)

    @staticmethod
    def receipt(row: OfflineImport, duplicate: bool) -> dict[str, Any]:
        return {
            "id": row.id,
            "runId": row.run_id,
            "localRunId": row.local_run_id,
            "duplicate": duplicate,
            "source": "OFFLINE_IMPORT",
            "officialGatePassed": False,
        }

    async def validate_facts(
        self, scope: WorkspaceScope, result: dict[str, Any], checked: dict[str, Any]
    ) -> list[dict[str, Any]]:
        rows = expected_variants(checked, result)
        assets = {a["versionId"]: a for a in checked["snapshot"]["assets"]}
        selection = checked["selection"]
        ids: set[str] = set()
        for attempt in result["attempts"]:
            case = attempt["caseVersionId"]
            if (
                case not in checked["snapshot"]["entryCaseVersionIds"]
                or attempt["attemptId"] in ids
            ):
                raise Problem(422, "INVALID_OFFLINE_CASE", "Unknown or duplicate case attempt")
            ids.add(attempt["attemptId"])
            events = attempt["events"]
            if attempt["lastSequence"] != len(events) or any(
                e["attemptId"] != attempt["attemptId"] or e["sequence"] != i + 1
                for i, e in enumerate(events)
            ):
                raise Problem(422, "INVALID_EVENT_SEQUENCE", "Offline event sequence differs")
            execution = attempt.get("execution")
            if execution:
                variant = sha256(
                    canonical_bytes(
                        [
                            case,
                            execution.get("suiteEntryIndex", 0),
                            execution["roleKey"],
                            execution["browser"],
                            execution.get("datasetVersionId"),
                            execution.get("dataRow", {}).get("key"),
                        ]
                    )
                ).hexdigest()
                if variant not in rows:
                    raise Problem(
                        422,
                        "INVALID_OFFLINE_VARIANT",
                        "Variant is outside the signed selected matrix",
                    )
            else:
                candidates = [key for key, row in rows.items() if row["caseVersionId"] == case]
                if len(candidates) != 1:
                    raise Problem(
                        422,
                        "OFFLINE_VARIANT_FACTS_REQUIRED",
                        "Legacy result has ambiguous variants; retain local history for inspection",
                    )
                variant = candidates[0]
            group = rows[variant]
            source = group["source"]
            if execution:
                if (
                    execution["workspaceId"] != scope.workspace_id
                    or execution["runId"] != result["localRunId"]
                    or execution["caseVersionId"] != case
                    or execution["assetSourceHash"] != json.loads(source)["sourceHash"]
                    or execution["environment"] != result["actualEnvironment"]
                    or execution["attemptNo"] != attempt["attemptNo"]
                    or attempt.get("variantKey") != variant
                ):
                    raise Problem(
                        422, "INVALID_OFFLINE_VARIANT", "Offline execution binding differs"
                    )
            document = assets[case]["document"]
            if execution:
                selection = checked["selection"]
                original_environment = assets[selection["environmentVersionId"]]["document"]
                actual = result["actualEnvironment"]
                allowed_override = {"baseURL", "apiBaseURL", "fixtureBaseURL", "allowedOrigins"}
                if any(
                    original_environment.get(k) != actual.get(k)
                    for k in set(original_environment) | set(actual)
                    if k not in allowed_override
                ):
                    raise Problem(
                        422, "INVALID_ENVIRONMENT_OVERRIDE", "Only public routing may differ"
                    )
                from urllib.parse import urlsplit

                allowed_origins = set(original_environment["allowedOrigins"])
                for field in ["baseURL", "apiBaseURL", "fixtureBaseURL"]:
                    if field in actual:
                        url = urlsplit(actual[field])
                        if url.username or url.password or url.scheme not in {"http", "https"}:
                            raise Problem(
                                422, "INVALID_ENVIRONMENT_OVERRIDE", "Unsafe routing override"
                            )
                        allowed_origins.add(f"{url.scheme}://{url.netloc}")
                if set(actual["allowedOrigins"]) != allowed_origins:
                    raise Problem(
                        422,
                        "INVALID_ENVIRONMENT_OVERRIDE",
                        "Allowed origins differ from public routing",
                    )
                role = next(
                    (
                        r
                        for r in original_environment["roles"]
                        if r["roleKey"] == execution["roleKey"]
                    ),
                    None,
                )
                if not role:
                    raise Problem(422, "INVALID_OFFLINE_VARIANT", "Role is unavailable")
                identities = [role] + (
                    [original_environment["fixtureIdentity"]]
                    if document.get("fixtureVersionId")
                    else []
                )
                pins = [
                    {"secretRef": i["secretRef"], "versionId": i["secretVersionId"]}
                    for i in identities
                ]
                dataset = group["selection"]["datasetVersionId"]
                if (
                    execution["environmentVersionId"] != selection["environmentVersionId"]
                    or execution["secretVersions"] != pins
                    or execution.get("authAdapters", [])
                    != checked["snapshot"].get("authAdapters", [])
                    or execution["variables"] != {}
                    or execution.get("datasetVersionId") != dataset
                    or execution.get("dataRow") != group["selection"]["dataRow"]
                ):
                    raise Problem(422, "INVALID_OFFLINE_VARIANT", "Frozen auth or dataset differs")
            # Older descriptors without variant facts remain importable as INCOMPLETE.
            plan_raw = (
                None
                if group["draft"]
                else checked["files"].get(f"compiled/{group['root']}/metadata/expected-plans.json")
            )
            plan = (
                next((p for p in json.loads(plan_raw)["cases"] if p["caseVersionId"] == case), None)
                if plan_raw
                else None
            )
            evidence_complete = (
                bool(attempt["artifacts"])
                and plan is not None
                and set(plan.get("requiredEvidenceKinds", []))
                <= {f.get("kind") for f in attempt["artifacts"]}
            )
            evidence_complete &= any(
                e["type"] == "ATTEMPT_STARTED"
                and e["payload"].get("sourceHash") == json.loads(source)["sourceHash"]
                and e["payload"].get("engineVersion") == checked["manifest"]["engineVersion"]
                for e in events
            )
            for file in attempt["artifacts"]:
                if not safe_path(file["path"]) or file["sizeBytes"] > 32 * 1024 * 1024:
                    raise Problem(422, "INVALID_OFFLINE_ARTIFACT", "Artifact descriptor is unsafe")
                upload = (
                    await self.session.execute(
                        select(OfflineImportUpload).where(
                            OfflineImportUpload.workspace_id == scope.workspace_id,
                            OfflineImportUpload.bundle_id == result["bundleId"],
                            OfflineImportUpload.local_run_id == result["localRunId"],
                            OfflineImportUpload.local_attempt_id == attempt["attemptId"],
                            OfflineImportUpload.path == file["path"],
                        )
                    )
                ).scalar_one_or_none()
                if (
                    not upload
                    or upload.state != "COMPLETE"
                    or upload.expired_at
                    or upload.sha256 != file["sha256"]
                    or upload.size_bytes != file["sizeBytes"]
                    or upload.kind != file.get("kind")
                ):
                    raise Problem(
                        409, "OFFLINE_ARTIFACT_MISSING", "Verified uploaded bytes required"
                    )
            facts = (
                reduce_test(
                    plan,
                    events,
                    {
                        "cleanupStatus": attempt["cleanupStatus"],
                        "businessOutcome": attempt["outcome"],
                    },
                    evidence_complete=evidence_complete
                    and bool(execution)
                    and attempt.get("processStopped") is True,
                )
                if plan
                else {
                    "outcome": "INCOMPLETE",
                    "business": attempt["outcome"],
                    "cleanup": attempt["cleanupStatus"],
                    "evidence": "INCOMPLETE",
                }
            )
            prior = group["attempts"]
            if attempt["attemptNo"] != len(prior) + 1 or len(prior) >= 2:
                raise Problem(422, "INVALID_OFFLINE_RETRY", "Attempt ordering differs")
            if prior and (
                prior[0][1]["outcome"] not in {"FAILED", "ERROR"}
                or not retry_is_safe(
                    plan.get("hasPotentialWrites") if plan else None,
                    prior[0][0].get("retrySafety"),
                    bool(document.get("fixtureVersionId")),
                    prior[0][0]["cleanupStatus"],
                )
            ):
                raise Problem(422, "UNSAFE_OFFLINE_RETRY", "Whole-case retry was not safe")
            if (
                prior
                and execution
                and (
                    execution["caseExecutionId"] != prior[0][0]["execution"]["caseExecutionId"]
                    or execution["namespace"] == prior[0][0]["execution"]["namespace"]
                )
            ):
                raise Problem(422, "INVALID_OFFLINE_RETRY", "Retry identity or namespace differs")
            prior.append((attempt, facts))
            group["outcome"] = (
                "UNSTABLE" if len(prior) == 2 and facts["outcome"] == "PASSED" else facts["outcome"]
            )
        return list(rows.values())
