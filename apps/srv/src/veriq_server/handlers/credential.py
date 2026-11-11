"""Environment-manager credential API and fail-closed internal resolution seam."""

from sqlalchemy import select
from ..auth.authorization import WorkspaceScope
from ..credentials.service import CredentialService, configured_keyring, version_dto
from ..db import SecretVersion
from ..service import Problem, lock_installation
from ..pagination import Page
from .base import API


class CredentialAPI(API):
    def prepare(self) -> None:
        super().prepare()
        allowed = {"GET", "POST"} if self.action == "credentials" else {"POST"}
        if self.request.method not in allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str) -> None:
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            service = CredentialService(session, user, configured_keyring(self.config))
            await service.authorize(WorkspaceScope(workspace_id))
            page = Page.read(
                self,
                {"list": "credentials", "workspaceId": workspace_id, "actor": user.id},
                self.config.signing_key.get_secret_value(),
            )
            query = select(SecretVersion).where(SecretVersion.workspace_id == workspace_id)
            if page.last:
                query = query.where(SecretVersion.id > page.last[1])
            rows = (
                (await session.execute(query.order_by(SecretVersion.id).limit(page.limit + 1)))
                .scalars()
                .all()
            )
            shown = rows[: page.limit]
            self.respond(
                {
                    "items": [version_dto(row) for row in shown],
                    "nextCursor": page.next((shown[-1].id, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
            )

    async def post(
        self, workspace_id: str, secret_ref: str | None = None, version_id: str | None = None
    ) -> None:
        data = self.body(
            {
                "credentials": "CredentialCreate",
                "credential-versions": "CredentialRotate",
                "credential-revoke": "EmptyObject",
            }[self.action]
        )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = CredentialService(session, user, configured_keyring(self.config))
            scope = WorkspaceScope(workspace_id)
            if self.action == "credential-revoke":
                assert secret_ref and version_id
                result = await service.revoke(scope, secret_ref, version_id)
            else:
                result = await service.create(
                    scope, secret_ref or data["secretRef"], data, new=self.action == "credentials"
                )
        self.respond(result, 200 if self.action == "credential-revoke" else 201)


class CredentialResolveAPI(API):
    def check_xsrf_cookie(self) -> None:
        # Device authentication belongs to the verifier; never cookie authentication.
        pass

    def prepare(self) -> None:
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")

    async def post(self, attempt_id: str) -> None:
        from ..credentials.resolve import (
            CredentialProofTransport,
            DenyAttemptProof,
            resolve_verified,
        )

        verifier = self.application.settings.get("attempt_proof_verifier") or DenyAttemptProof()
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            transport = CredentialProofTransport.parse(
                self.request.headers.get("Authorization", ""),
                self.request.headers.get("X-VeriQ-Lease-Token", ""),
                self.request.headers.get("X-VeriQ-Fencing-Token", ""),
            )
            proof = await verifier.verify(session, attempt_id, transport)
            if proof.attempt_id != attempt_id or proof.fence != transport.fencing_token:
                raise Problem(403, "ATTEMPT_PROOF_REQUIRED", "Attempt binding does not match")
            data = self.body("CredentialResolveRequest")
            value = await resolve_verified(
                session,
                proof,
                data["secretRef"],
                data["versionId"],
                configured_keyring(self.config),
            )
        self.respond(
            {"secretRef": data["secretRef"], "versionId": data["versionId"], "value": value}
        )


class AuthAdapterAPI(API):
    def prepare(self) -> None:
        super().prepare()
        allowed = {"GET", "POST"} if self.action == "auth-adapters" else {"POST"}
        if self.request.method not in allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def post(self, workspace_id: str, version_id: str | None = None) -> None:
        from hashlib import sha256
        from uuid import uuid4
        from ..contracts import canonical_bytes
        from ..credentials.registry import adapter_dto
        from ..db import AuthAdapterVersion
        from ..service import now, audit

        data = self.body("EmptyObject" if version_id else "AuthAdapterCreate")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            scope = WorkspaceScope(workspace_id)
            await CredentialService(session, user, configured_keyring(self.config)).authorize(
                scope, True
            )
            if version_id:
                row = (
                    await session.execute(
                        select(AuthAdapterVersion)
                        .where(
                            AuthAdapterVersion.workspace_id == workspace_id,
                            AuthAdapterVersion.id == version_id,
                        )
                        .with_for_update()
                    )
                ).scalar_one_or_none()
                if row is None:
                    raise Problem(404, "AUTH_ADAPTER_NOT_FOUND", "Authentication adapter not found")
                row.revoked = True
            else:
                config = data["configuration"]
                row = AuthAdapterVersion(
                    id=str(uuid4()),
                    workspace_id=workspace_id,
                    content_hash=sha256(canonical_bytes(config)).hexdigest(),
                    configuration=config,
                    revoked=False,
                    created_at=now(),
                )
                session.add(row)
            audit(
                session,
                "auth_adapter.revoked" if version_id else "auth_adapter.created",
                user.id,
                row.id,
                workspace_id=workspace_id,
            )
            result = {**adapter_dto(row), "revoked": row.revoked}
        self.respond(result, 200 if version_id else 201)

    async def get(self, workspace_id: str) -> None:
        from ..credentials.registry import adapter_dto
        from ..db import AuthAdapterVersion

        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            await CredentialService(session, user, configured_keyring(self.config)).authorize(
                WorkspaceScope(workspace_id)
            )
            page = Page.read(
                self,
                {"list": "auth-adapters", "workspaceId": workspace_id, "actor": user.id},
                self.config.signing_key.get_secret_value(),
            )
            query = select(AuthAdapterVersion).where(
                AuthAdapterVersion.workspace_id == workspace_id
            )
            if page.last:
                query = query.where(AuthAdapterVersion.id > page.last[1])
            rows = (
                (await session.execute(query.order_by(AuthAdapterVersion.id).limit(page.limit + 1)))
                .scalars()
                .all()
            )
            shown = rows[: page.limit]
            self.respond(
                {
                    "items": [{**adapter_dto(row), "revoked": row.revoked} for row in shown],
                    "nextCursor": page.next((shown[-1].id, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
            )
