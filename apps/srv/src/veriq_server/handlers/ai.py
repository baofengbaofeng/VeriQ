"""AI HTTP boundary; external model requests never hold a DB transaction."""

from typing import Any

from ..contracts import canonical_bytes
from ..auth.authorization import WorkspaceScope
from ..pagination import Page
from ..service import Problem
from ..services.ai import AiService
from .base import API


class AiAPI(API):
    body_limit = 128 * 1024

    def body(self, schema: str) -> dict[str, Any]:
        value = super().body(schema)
        try:
            canonical_bytes(value)
        except (ValueError, RecursionError):
            raise Problem(
                400, "INVALID_REQUEST", "Request must contain portable finite JSON"
            ) from None
        return value

    def service(self) -> AiService:
        return AiService(
            self.db,
            self.config,
            self.identity,
            self.application.settings.get("identity_reference_registry"),
        )

    def prepare(self) -> None:
        super().prepare()
        methods = {
            "ai-providers": {"GET", "POST"},
            "ai-provider": {"GET", "PUT", "DELETE"},
            "ai-connection": {"POST"},
            "ai-generations": {"GET", "POST"},
            "ai-generation": {"GET"},
            "ai-review": {"POST"},
            "ai-cancel": {"POST"},
            "ai-context": {"POST"},
        }
        if self.request.method not in methods[self.action]:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str, item_id: str | None = None) -> None:
        scope = WorkspaceScope(workspace_id)
        page = Page.read(
            self,
            {"workspaceId": workspace_id, "list": self.action},
            self.config.signing_key.get_secret_value(),
        )
        if self.action in {"ai-providers", "ai-provider"}:
            result = await self.service().providers(scope, page, item_id)
        else:
            result = await self.service().history(scope, page, item_id)
        self.respond(result)

    async def post(self, workspace_id: str, item_id: str | None = None) -> None:
        scope = WorkspaceScope(workspace_id)
        service = self.service()
        if self.action == "ai-providers":
            self.respond(await service.write_provider(scope, self.body("ProviderWrite")), 201)
        elif self.action == "ai-context":
            self.respond(await service.preview(scope, self.body("GenerationRequest")))
        elif self.action == "ai-generations":
            self.respond(await service.create_draft(scope, self.body("GenerationRequest")), 201)
        elif self.action == "ai-connection":
            assert item_id
            data = self.body("AiConnectionRequest")
            self.respond(
                await service.create_draft(
                    scope,
                    {
                        **data,
                        "providerId": item_id,
                        "purpose": "BOUNDARY_SUGGESTION",
                        "prompt": 'Connection test. Return {"suggestions":[],"basis":"connection test"}.',
                    },
                    connection=True,
                )
            )
        elif self.action == "ai-cancel":
            assert item_id
            self.respond(await service.cancel(scope, item_id))
        else:
            assert item_id
            self.respond(await service.review(scope, item_id, self.body("GenerationReview")))

    async def put(self, workspace_id: str, item_id: str) -> None:
        self.respond(
            await self.service().write_provider(
                WorkspaceScope(workspace_id), self.body("ProviderWrite"), item_id
            )
        )

    async def delete(self, workspace_id: str, item_id: str) -> None:
        self.respond(await self.service().delete_provider(WorkspaceScope(workspace_id), item_id))
