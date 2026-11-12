from typing import Any

from ..contracts import canonical_bytes
from ..auth.authorization import WorkspaceScope
from ..pagination import Page
from ..service import Problem
from ..services.ai import AiService
from .base import API


class AiAPI(API):
    """工作区 AI 控制面：供应商 CRUD、连通性探测、草稿生成、审阅与取消，均绑定 WorkspaceScope；生成结果永不自动发布，审阅通过后由资源管线另行处理。"""

    body_limit = 128 * 1024

    def body(self, schema: str) -> dict[str, Any]:
        """在契约校验后再要求可移植有限 JSON，拒绝 NaN/循环结构进入生成管线；canonical_bytes 失败说明存在非有限数值或环。"""
        value = super().body(schema)
        try:
            canonical_bytes(value)
        except (ValueError, RecursionError):
            raise Problem(
                400, "INVALID_REQUEST", "Request must contain portable finite JSON"
            ) from None
        return value

    def service(self) -> AiService:
        """构造绑定会话身份与可选身份注册表的 AiService，供各 action 复用同一配置；identity 可调用闭包传入，便于服务层按需二次鉴权。"""
        return AiService(
            self.db,
            self.config,
            self.identity,
            self.application.settings.get("identity_reference_registry"),
        )

    def prepare(self) -> None:
        """按 action 白名单收紧允许的 HTTP 动词，未知组合直接映射 METHOD_NOT_ALLOWED；方法表与路由 action 一一对应，缺省即 405。"""
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
        """GET 分页列出供应商或生成历史，也可按 item_id 读取单条记录；providers 与 history 分支共用签名分页作用域。"""
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
        """POST 创建供应商、预览上下文、启动草稿、连通性测试、取消任务或提交审阅结论；ai-connection 固定提示词，避免测试调用产生可审阅草稿语义。"""
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
            # 连通性测试固定 BOUNDARY_SUGGESTION 提示词，避免误触发可发布草稿。
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
        """PUT 更新指定供应商配置；服务层负责密钥密封与 Workspace 写授权；item_id 指向既有供应商，缺失时由服务层映射 404。"""
        self.respond(
            await self.service().write_provider(
                WorkspaceScope(workspace_id), self.body("ProviderWrite"), item_id
            )
        )

    async def delete(self, workspace_id: str, item_id: str) -> None:
        """DELETE 移除工作区供应商；进行中的生成引用由服务层拒绝或隔离；删除后历史生成记录仍保留，仅切断新调用入口。（AiAPI.delete）"""
        self.respond(await self.service().delete_provider(WorkspaceScope(workspace_id), item_id))
