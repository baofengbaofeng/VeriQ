from sqlalchemy import select
from ..db import ServiceAccount, ServiceToken
from ..pagination import Page
from ..service import Problem, audit, lock_installation, now, stamp
from ..services.service_account import ServiceAccountService, account_dto
from .base import API


class ServiceAccountAPI(API):
    """工作区服务账号治理：分页列出、创建账号、签发/吊销令牌以及禁用账号；令牌明文仅在签发响应出现一次，库内只存摘要。（ServiceAccountAPI）
    ServiceAccountAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    def prepare(self) -> None:
        """账号集合与令牌集合支持只读分页和显式签发，禁用账号与吊销令牌只允许 POST 以防导航产生状态变化；方法约束在读取请求体之前执行，普通浏览器写入仍需原有同源和 CSRF 校验。"""
        super().prepare()
        allowed = (
            {"GET", "POST"}
            if self.action in {"service-accounts", "service-token-issue"}
            else {"POST"}
        )
        if self.request.method not in allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str, account_id: str | None = None) -> None:
        """账号列表和令牌元数据列表先校验当前空间管理范围，账号路径再次核对嵌套归属再生成绑定主体的游标；返回用途、范围和失效状态供界面治理，永远不返回令牌明文或数据库中的哈希材料。"""
        if self.action not in {"service-accounts", "service-token-issue"}:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        async with self.db.sessions() as session:
            user, _ = await self.identity(session)
            await ServiceAccountService(session).authorize(user, workspace_id)
            if account_id:
                await ServiceAccountService(session).get(workspace_id, account_id)
                page = Page.read(
                    self,
                    {
                        "list": "service-tokens",
                        "workspaceId": workspace_id,
                        "accountId": account_id,
                        "actor": user.id,
                    },
                    self.config.signing_key.get_secret_value(),
                )
                token_query = select(ServiceToken).where(
                    ServiceToken.service_account_id == account_id
                )
                if page.last:
                    token_query = token_query.where(ServiceToken.id > page.last[1])
                tokens = list(
                    (
                        await session.scalars(
                            token_query.order_by(ServiceToken.id).limit(page.limit + 1)
                        )
                    ).all()
                )
                shown_tokens = tokens[: page.limit]
                self.respond(
                    {
                        "items": [
                            {
                                "id": token.id,
                                "purpose": token.purpose,
                                "operations": token.operation_scopes or [],
                                "planIds": token.plan_scopes or [],
                                "expiresAt": stamp(token.expires_at),
                                "revoked": token.revoked_at is not None,
                                "consumed": token.consumed_at is not None,
                            }
                            for token in shown_tokens
                        ],
                        "nextCursor": page.next(
                            (shown_tokens[-1].id, shown_tokens[-1].id), len(tokens) > page.limit
                        )
                        if shown_tokens
                        else None,
                    }
                )
                return
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
        """账号创建、限定用途令牌签发、禁用和吊销都在安装锁内验证当前管理权限；计划范围交给签发服务逐项核对，吊销还验证令牌归属，只有新令牌签发响应可以向当前操作者显示一次明文。"""
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
                        user, account, data["purpose"], data.get("operations"), data.get("planIds")
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
