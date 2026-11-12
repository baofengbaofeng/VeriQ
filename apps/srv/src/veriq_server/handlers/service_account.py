from sqlalchemy import select
from ..db import ServiceAccount, ServiceToken
from ..pagination import Page
from ..service import Problem, audit, lock_installation, now
from ..services.service_account import ServiceAccountService, account_dto
from .base import API


class ServiceAccountAPI(API):
    """工作区服务账号治理：分页列出、创建账号、签发/吊销令牌以及禁用账号；令牌明文仅在签发响应出现一次，库内只存摘要。（ServiceAccountAPI）
    ServiceAccountAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    def prepare(self) -> None:
        """限制 collection 仅 GET/POST，其余 action 仅允许 POST，避免误用动词改状态；禁用与吊销路径禁止 GET，降低误读副作用。
        prepare 实现于 apps/srv/src/veriq_server/handlers/service_account.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        super().prepare()
        allowed = {"GET", "POST"} if self.action == "service-accounts" else {"POST"}
        if self.request.method not in allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str) -> None:
        """GET 在服务账号读授权后按 id 游标分页返回工作区服务账号列表；列表不含令牌材料，只返回账号 DTO。（ServiceAccountAPI.get）
        get 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        if self.action != "service-accounts":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            await ServiceAccountService(session).authorize(user, workspace_id)
            page = Page.read(
                self,
                {"list": "service-accounts", "workspaceId": workspace_id, "actor": user.id},
                self.config.signing_key.get_secret_value(),
            )
            query = select(ServiceAccount).where(ServiceAccount.workspace_id == workspace_id)
            if page.last:
                query = query.where(ServiceAccount.id > page.last[1])
            rows = (
                (await session.execute(query.order_by(ServiceAccount.id).limit(page.limit + 1)))
                .scalars()
                .all()
            )
            shown = rows[: page.limit]
            self.respond(
                {
                    "items": [account_dto(row) for row in shown],
                    "nextCursor": page.next((shown[-1].id, shown[-1].id), len(rows) > page.limit)
                    if shown
                    else None,
                }
            )

    async def post(
        self, workspace_id: str, account_id: str | None = None, token_id: str | None = None
    ) -> None:
        """POST 创建服务账号、签发限定用途令牌、禁用账号或吊销指定令牌，均需写授权；吊销校验 token 归属 account，防止跨账号操作。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        data = self.body(
            {
                "service-accounts": "ServiceAccountCreate",
                "service-token-issue": "ServiceTokenIssue",
                "service-account-disable": "EmptyObject",
                "service-token-revoke": "EmptyObject",
            }[self.action]
        )
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            service = ServiceAccountService(session)
            await service.authorize(user, workspace_id, write=True)
            if self.action == "service-accounts":
                result = account_dto(await service.create(user, workspace_id, data["name"]))
            else:
                assert account_id
                account = await service.get(workspace_id, account_id)
                if self.action == "service-token-issue":
                    result = await service.issue(
                        user, account, data["purpose"], data.get("operations")
                    )
                elif self.action == "service-account-disable":
                    account.disabled = True
                    audit(
                        session,
                        "service_account.disabled",
                        user.id,
                        account.id,
                        workspace_id=workspace_id,
                    )
                    result = account_dto(account)
                else:
                    token = await session.get(ServiceToken, token_id)
                    # 令牌必须归属当前服务账号，防止跨账号吊销。
                    if not token or token.service_account_id != account.id:
                        raise Problem(404, "SERVICE_TOKEN_NOT_FOUND", "Service token not found")
                    token.revoked_at = now()
                    audit(
                        session,
                        "service_token.revoked",
                        user.id,
                        token.id,
                        workspace_id=workspace_id,
                    )
                    result = {}
        self.respond(
            result, 201 if self.action in {"service-accounts", "service-token-issue"} else 200
        )
