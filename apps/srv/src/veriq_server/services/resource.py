"""Versioned source editing and immutable Runtime validation requests.

Compiler semantics (variables, assertions and flow expansion) belong to T05;
this service enforces schemas, typed version closure and provenance boundaries.
"""

from hashlib import sha256
from typing import Any, Protocol
from uuid import NAMESPACE_URL, uuid4, uuid5

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import canonical_bytes, asset_source_hash, validate_schema
from ..db import Resource, ResourceDraft, ResourceVersion, User, Job
from ..repositories.resource import ResourceRepository
from ..service import Problem, audit, now, stamp
from .workspace import WorkspaceRepository

ENGINE_VERSION = "0.1.0"
DOCUMENT_LIMIT = 2 * 1024 * 1024
SNAPSHOT_LIMIT = 16 * 1024 * 1024
ASSET_LIMIT = 1000


class IdentityReferenceRegistry(Protocol):
    """T07 resolves these typed domains in this transaction and Workspace.

    Must check adapter version, secretRef/version association, revocation and allowed
    identities; must return no plaintext credentials. Unknown references raise Problem.
    """

    async def require_role(
        self, session: AsyncSession, scope: WorkspaceScope, role: dict[str, Any]
    ) -> None: ...

    async def freeze(
        self, session: AsyncSession, scope: WorkspaceScope, roles: list[dict[str, Any]]
    ) -> list[dict[str, Any]]: ...


class UnavailableIdentityRegistry:
    async def require_role(
        self, session: AsyncSession, scope: WorkspaceScope, role: dict[str, Any]
    ) -> None:
        raise Problem(
            422,
            "UNRESOLVED_IDENTITY_REFERENCE",
            "Authentication adapter and credential references must resolve in this Workspace",
        )

    async def freeze(
        self, session: AsyncSession, scope: WorkspaceScope, roles: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        raise Problem(
            422, "UNRESOLVED_IDENTITY_REFERENCE", "Authentication registry is unavailable"
        )


def document_hash(content: dict[str, Any]) -> str:
    return sha256(canonical_bytes(content)).hexdigest()


def check_document(kind: str, content: dict[str, Any]) -> None:
    if validate_schema("ResourceDocumentV1", content) or content["kind"] != kind:
        raise Problem(
            422, "INVALID_RESOURCE_DOCUMENT", "Document must match the immutable resource kind"
        )
    try:
        raw = canonical_bytes(content)
    except ValueError:
        raise Problem(
            422, "INVALID_RESOURCE_DOCUMENT", "Document must contain portable Unicode JSON"
        ) from None
    if len(raw) > DOCUMENT_LIMIT:
        raise Problem(413, "BODY_TOO_LARGE", "Resource document exceeds 2 MiB")


def asset_references(content: dict[str, Any]) -> list[tuple[str, str]]:
    """Read schema-defined reference positions only; JSON data remains inert."""
    kind, doc = content["kind"], content["document"]
    result: list[tuple[str, str]] = []
    if kind == "CASE":
        for key, target in [
            ("catalogVersionId", "ELEMENT_CATALOG"),
            ("datasetVersionId", "DATASET"),
            ("fixtureVersionId", "FIXTURE"),
        ]:
            if key in doc:
                result.append((doc[key], target))
    if kind == "SUITE":
        for case in doc["cases"]:
            result.append((case["versionId"], "CASE"))
            if "datasetVersionId" in case:
                result.append((case["datasetVersionId"], "DATASET"))
    assertions = list(doc.get("assertions", [])) if kind == "ASSERTION_TEMPLATE" else []
    if kind in {"CASE", "FLOW"}:
        for step in doc["steps"]:
            if step["action"] == "callFlow":
                result.append((step["versionId"], "FLOW"))
            assertions.extend(step.get("beforeAssertions", []))
            assertions.extend(step.get("afterAssertions", []))
    for assertion in assertions:
        if assertion["type"] == "template":
            result.append((assertion["versionId"], "ASSERTION_TEMPLATE"))
    return sorted(set(result))


def resource_dto(row: Resource) -> dict[str, Any]:
    result = {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "kind": row.kind,
        "key": row.key,
        "name": row.name,
        "status": row.status,
    }
    if row.latest_version_id:
        result["latestVersionId"] = row.latest_version_id
    return result


def draft_dto(row: ResourceDraft) -> dict[str, Any]:
    return {
        "resourceId": row.resource_id,
        "revision": row.revision,
        "content": row.document_json,
        "updatedAt": stamp(row.updated_at),
        "documentHash": document_hash(row.document_json),
    }


def version_dto(row: ResourceVersion) -> dict[str, Any]:
    return {
        "id": row.id,
        "resourceId": row.resource_id,
        "workspaceId": row.workspace_id,
        "versionNo": row.version_no,
        "schemaVersion": "1.0",
        "sha256": row.sha256,
        "content": row.document_json,
        "publishedAt": stamp(row.published_at),
    }


def job_dto(row: Job) -> dict[str, Any]:
    result = {"id": row.id, "workspaceId": row.workspace_id, "kind": row.kind, "state": row.state}
    if row.active_attempt_id:
        result["activeAttemptId"] = row.active_attempt_id
    return result


class ResourceService:
    def __init__(
        self, session: AsyncSession, user: User, registry: IdentityReferenceRegistry | None = None
    ):
        self.session, self.user = session, user
        self.registry = registry or UnavailableIdentityRegistry()

    async def authorize(
        self,
        scope: WorkspaceScope,
        kind: str,
        permission: Permission = Permission.EDIT,
        *,
        write: bool = True,
    ) -> None:
        required = (
            Permission.MANAGE_ENVIRONMENT
            if kind == "ENVIRONMENT" and permission != Permission.VIEW
            else permission
        )
        await WorkspaceRepository(self.session, scope).authorize(self.user, required, write=write)

    async def editable(
        self, scope: WorkspaceScope, resource_id: str, permission: Permission = Permission.EDIT
    ) -> Resource:
        await WorkspaceRepository(self.session, scope).authorize(self.user, permission, write=True)
        resource = await ResourceRepository(self.session, scope).resource(resource_id)
        await self.authorize(scope, resource.kind, permission)
        if resource.status == "ARCHIVED":
            raise Problem(409, "RESOURCE_ARCHIVED", "Resource is archived")
        return resource

    async def create(self, scope: WorkspaceScope, data: dict[str, Any]) -> dict[str, Any]:
        await self.authorize(scope, data["kind"])
        check_document(data["kind"], data["content"])
        existing = (
            await self.session.execute(
                select(Resource.id).where(
                    Resource.workspace_id == scope.workspace_id,
                    Resource.kind == data["kind"],
                    Resource.key == data["key"],
                )
            )
        ).scalar_one_or_none()
        if existing:
            raise Problem(
                409, "RESOURCE_KEY_EXISTS", "Resource key is retained, including archived resources"
            )
        resource = Resource(
            id=str(uuid4()),
            workspace_id=scope.workspace_id,
            kind=data["kind"],
            key=data["key"],
            name=data["name"],
            status="DRAFT",
        )
        self.session.add(resource)
        await self.session.flush()
        self.session.add(
            ResourceDraft(
                resource_id=resource.id,
                workspace_id=scope.workspace_id,
                revision=1,
                document_json=data["content"],
                updated_by=self.user.id,
                updated_at=now(),
            )
        )
        audit(
            self.session,
            "resource.created",
            self.user.id,
            resource.id,
            workspace_id=scope.workspace_id,
        )
        return resource_dto(resource)

    async def update_draft(
        self,
        scope: WorkspaceScope,
        resource_id: str,
        expected_revision: int,
        document: dict[str, Any],
    ) -> dict[str, Any]:
        resource = await self.editable(scope, resource_id)
        check_document(resource.kind, document)
        draft = await ResourceRepository(self.session, scope).draft(resource_id)
        self.require_revision(draft, expected_revision)
        if draft.revision >= 9007199254740991:
            raise Problem(409, "REVISION_LIMIT", "Draft revision limit reached")
        draft.revision += 1
        draft.document_json, draft.updated_by, draft.updated_at = document, self.user.id, now()
        audit(
            self.session,
            "resource.draft_updated",
            self.user.id,
            resource.id,
            workspace_id=scope.workspace_id,
        )
        return draft_dto(draft)

    @staticmethod
    def require_revision(draft: ResourceDraft, revision: int) -> None:
        if draft.revision != revision:
            raise Problem(409, "STALE_REVISION", "Draft revision changed; reload the draft")

    async def snapshot(
        self, scope: WorkspaceScope, resource: Resource, draft: ResourceDraft
    ) -> dict[str, Any]:
        repo = ResourceRepository(self.session, scope)
        check_document(resource.kind, draft.document_json)
        root_id = str(
            uuid5(
                NAMESPACE_URL,
                f"veriq:{scope.workspace_id}:{resource.id}:{draft.revision}:{document_hash(draft.document_json)}",
            )
        )
        assets: dict[str, dict[str, Any]] = {}
        visiting: set[str] = set()
        source_size = 0
        auth_adapters: dict[str, dict[str, Any]] = {}

        async def visit(version_id: str, resource_id: str, content: dict[str, Any]) -> None:
            nonlocal source_size
            if version_id in visiting:
                raise Problem(422, "DEPENDENCY_CYCLE", "Version dependency cycle")
            if version_id in assets:
                return
            if len(assets) + len(visiting) >= ASSET_LIMIT or len(visiting) >= 100:
                raise Problem(
                    422, "DEPENDENCY_LIMIT", "Dependency closure exceeds 1000 assets or depth 100"
                )
            visiting.add(version_id)
            check_document(content["kind"], content)
            asset = {
                "resourceId": resource_id,
                "versionId": version_id,
                "sha256": document_hash(content),
                **content,
            }
            source_size += len(canonical_bytes(asset))
            if source_size > SNAPSHOT_LIMIT:
                raise Problem(413, "SNAPSHOT_TOO_LARGE", "Dependency snapshot exceeds 16 MiB")
            if content["kind"] == "ENVIRONMENT":
                identities = [*content["document"]["roles"]]
                if content["document"].get("fixtureIdentity"):
                    identities.append(content["document"]["fixtureIdentity"])
                for adapter in await self.registry.freeze(self.session, scope, identities):
                    auth_adapters[adapter["versionId"]] = adapter
            for dependency_id, expected_kind in asset_references(content):
                try:
                    dependency = await repo.version(dependency_id)
                except Problem:
                    raise Problem(
                        422,
                        "INVALID_REFERENCE",
                        "Referenced published version is not available in this Workspace",
                    ) from None
                if (
                    dependency.kind != expected_kind
                    or document_hash(dependency.document_json) != dependency.sha256
                ):
                    raise Problem(
                        422,
                        "INVALID_REFERENCE",
                        "Referenced version kind or integrity does not match",
                    )
                await visit(dependency.id, dependency.resource_id, dependency.document_json)
            assets[version_id] = asset
            visiting.remove(version_id)

        await visit(root_id, resource.id, draft.document_json)
        entries = (
            [root_id]
            if resource.kind == "CASE"
            else sorted({c["versionId"] for c in draft.document_json["document"]["cases"]})
            if resource.kind == "SUITE"
            else []
        )
        snapshot = {
            "schemaVersion": "1.0",
            "workspaceId": scope.workspace_id,
            "sourceHash": "0" * 64,
            "engineVersion": ENGINE_VERSION,
            "entryCaseVersionIds": entries,
            "assets": [assets[k] for k in sorted(assets)],
            "validationTarget": {
                "resourceId": resource.id,
                "versionId": root_id,
                "revision": draft.revision,
            },
        }
        if auth_adapters:
            snapshot["authAdapters"] = [auth_adapters[key] for key in sorted(auth_adapters)]
        snapshot["sourceHash"] = asset_source_hash(snapshot)
        if len(canonical_bytes(snapshot)) > SNAPSHOT_LIMIT:
            raise Problem(413, "SNAPSHOT_TOO_LARGE", "Dependency snapshot exceeds 16 MiB")
        return snapshot

    async def preview(self, scope: WorkspaceScope, resource_id: str) -> dict[str, Any]:
        await WorkspaceRepository(self.session, scope).authorize(self.user)
        repo = ResourceRepository(self.session, scope)
        resource, draft = await repo.resource(resource_id), await repo.draft(resource_id)
        snapshot = await self.snapshot(scope, resource, draft)
        return {
            "resourceId": resource_id,
            "revision": draft.revision,
            "candidateVersionId": snapshot["validationTarget"]["versionId"],
            "documentHash": document_hash(draft.document_json),
            "sourceHash": snapshot["sourceHash"],
            "engineVersion": ENGINE_VERSION,
        }

    async def validate(
        self, scope: WorkspaceScope, resource_id: str, revision: int, source_hash: str
    ) -> dict[str, Any]:
        resource = await self.editable(scope, resource_id)
        repo = ResourceRepository(self.session, scope)
        draft = await repo.draft(resource_id)
        self.require_revision(draft, revision)
        snapshot = await self.snapshot(scope, resource, draft)
        if source_hash != snapshot["sourceHash"]:
            raise Problem(
                409, "STALE_SOURCE_HASH", "Validation source changed; refresh validation preview"
            )
        key = document_hash(
            {"resourceId": resource_id, "revision": revision, "sourceHash": source_hash}
        )
        existing = (
            await self.session.execute(
                select(Job).where(Job.workspace_id == scope.workspace_id, Job.validation_key == key)
            )
        ).scalar_one_or_none()
        if existing:
            return job_dto(existing)
        job_id = str(uuid4())
        snapshot_hash = await repo.store(canonical_bytes(snapshot))
        manifest = {
            "schemaVersion": "1.0",
            "workspaceId": scope.workspace_id,
            "jobId": job_id,
            "snapshotSha256": snapshot_hash,
            "engineVersion": ENGINE_VERSION,
            "kind": "VALIDATE",
            "resourceId": resource_id,
            "revision": revision,
            "sourceHash": source_hash,
        }
        manifest_hash = await repo.store(canonical_bytes(manifest))
        job = Job(
            id=job_id,
            workspace_id=scope.workspace_id,
            kind="VALIDATE",
            subject_id=resource_id,
            state="QUEUED",
            snapshot_hash=snapshot_hash,
            manifest_hash=manifest_hash,
            validation_key=key,
            required_capabilities={"engineVersion": ENGINE_VERSION, "compileAssets": True},
            created_by=self.user.id,
            created_at=now(),
        )
        self.session.add(job)
        audit(
            self.session,
            "resource.validation_queued",
            self.user.id,
            resource_id,
            workspace_id=scope.workspace_id,
        )
        return job_dto(job)
