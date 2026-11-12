from sqlalchemy import select
from ..auth.authorization import WorkspaceScope
from ..credentials.service import CredentialService, configured_keyring, version_dto
from ..db import SecretVersion
from ..service import Problem, lock_installation
from ..pagination import Page
from .base import API


class CredentialAPI(API):
    """工作区环境凭据管理 HTTP 面：列出版本、创建引用、轮换与撤销，均走 MANAGE_ENVIRONMENT；响应 DTO 仅含元数据，密文永不离开服务层钥匙串。"""

    def prepare(self) -> None:
        """credentials 集合允许 GET/POST；轮换与撤销 action 仅接受 POST；错误方法在业务前短路，避免半开事务。"""
        super().prepare()
        allowed = {"GET", "POST"} if self.action == "credentials" else {"POST"}
        if self.request.method not in allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def get(self, workspace_id: str) -> None:
        """GET 在环境管理授权后按密钥版本 id 游标分页，响应绝不包含密文；分页键使用 SecretVersion.id，与工作区过滤一并签名。"""
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
        """POST 创建新引用、追加轮换版本或撤销指定版本；写路径先抢安装锁再授权；撤销返回 200，创建/轮换返回 201 以区分语义。"""
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
    """设备 Attempt 凭据解析入口：跳过 Cookie CSRF，改用租约/fence 证明解密已分配密钥；端点面向 Runner，不接受浏览器会话 Cookie。"""

    def check_xsrf_cookie(self) -> None:
        """设备认证归证明校验器，禁止依赖浏览器 Cookie 会话通过本端点；空实现是刻意的，避免误触发 Cookie CSRF。"""
        # 设备认证属于证明校验器；绝不走 Cookie 会话认证。
        pass

    def prepare(self) -> None:
        """仅设置请求号并检查正文上限，刻意跳过浏览器 Origin/CSRF 门禁；不检查 Origin，因为原生客户端通常不带浏览器 Origin。"""
        self.set_header("X-Request-Id", self.request_id)
        if len(self.request.body) > self.body_limit:
            raise Problem(413, "BODY_TOO_LARGE", "Request body exceeds operation limit")

    async def post(self, attempt_id: str) -> None:
        """校验 Authorization+租约+fence 与 Attempt 绑定后解密 secretRef/versionId。"""
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
            # fence 与路径 attempt_id 必须同时对齐，防止租约重放跨 Attempt。
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
    """认证适配器版本库：创建不可变配置快照、逻辑撤销以及按工作区分页枚举；适配器配置一旦创建即不可变，只能逻辑撤销。（AuthAdapterAPI）"""

    def prepare(self) -> None:
        """auth-adapters 集合允许 GET/POST；单版本撤销路径仅允许 POST；与凭据集合相同的动词约束模式，降低路由误配风险。"""
        super().prepare()
        allowed = {"GET", "POST"} if self.action == "auth-adapters" else {"POST"}
        if self.request.method not in allowed:
            raise Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed")

    async def post(self, workspace_id: str, version_id: str | None = None) -> None:
        """POST 创建适配器版本或以写权限标记既有版本 revoked，配置哈希写入 content_hash；content_hash 基于规范化 JSON，供发布冻结对照。"""
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
        """GET 在环境管理读授权后分页返回适配器版本，含 revoked 标记供发布冻结对照；列表包含已撤销版本，便于审计与引用诊断。"""
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
