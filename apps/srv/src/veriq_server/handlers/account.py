from datetime import datetime
from sqlalchemy import delete, select, and_, or_
from ..db import UserSession, UserToken
from ..service import (
    Problem,
    admin_dto,
    audit,
    hash_password,
    invalidate,
    lock_installation,
    now,
    stamp,
    verify,
)
from .base import API
from ..pagination import Page


class AccountAPI(API):
    """当前登录账户自助接口：查询档案与会话列表，以及改密、吊销本账户全部会话；所有操作仅作用于当前 Cookie 会话对应用户自身。
    AccountAPI 实现于 apps/srv/src/veriq_server/handlers/account.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    async def get(self, user_id: str | None = None) -> None:
        """GET 分发 account 档案或 sessions 游标分页；会话游标时间戳非法时映射 INVALID_CURSOR。
        get 实现于 apps/srv/src/veriq_server/handlers/account.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        async with self.db.sessions() as s:
            if self.action == "account":
                user, _ = await self.identity(s)
                self.respond(admin_dto(user))
            elif self.action == "sessions":
                user, current = await self.identity(s)
                page = Page.read(
                    self,
                    {"list": "sessions", "actor": user.id},
                    self.config.signing_key.get_secret_value(),
                )
                statement = select(UserSession).where(
                    UserSession.user_id == user.id, UserSession.expires_at > now()
                )
                if page.last:
                    try:
                        created = datetime.fromisoformat(page.last[0])
                        if created.tzinfo is not None:
                            raise ValueError
                    except ValueError:
                        raise Problem(
                            400, "INVALID_CURSOR", "Session cursor timestamp is invalid"
                        ) from None
                    statement = statement.where(
                        or_(
                            UserSession.created_at > created,
                            and_(UserSession.created_at == created, UserSession.id > page.last[1]),
                        )
                    )
                rows = (
                    (
                        await s.execute(
                            statement.order_by(UserSession.created_at, UserSession.id).limit(
                                page.limit + 1
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                sessions = rows[: page.limit]
                cursor = (
                    page.next(
                        (
                            sessions[-1].created_at.isoformat(timespec="microseconds"),
                            sessions[-1].id,
                        ),
                        len(rows) > page.limit,
                    )
                    if sessions
                    else None
                )
                self.respond(
                    {
                        "items": [
                            {
                                "id": v.id,
                                "createdAt": stamp(v.created_at),
                                "expiresAt": stamp(v.expires_at),
                                "current": v.id == current.id,
                            }
                            for v in sessions
                        ],
                        "nextCursor": cursor,
                    }
                )
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")

    async def post(self, user_id: str | None = None) -> None:
        """POST 处理 password 改密与 revoke-own 吊销；改密前校验当前口令并清空重置令牌；写操作在安装锁内执行，保证与管理员吊销互斥。
        post 实现于 apps/srv/src/veriq_server/handlers/account.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        async with self.db.sessions.begin() as s:
            if self.action == "password":
                data = self.body("ChangePasswordRequest")
                await lock_installation(s)
                user, _ = await self.identity(s)
                if not await verify(user.password_hash, data["currentPassword"]):
                    raise Problem(400, "INVALID_PASSWORD", "Current password is incorrect")
                user.password_hash = await hash_password(data["newPassword"])
                # 口令变更后立刻使全部会话与重置令牌失效，防止旧凭证继续访问。
                await invalidate(s, user.id)
                await s.execute(delete(UserToken).where(UserToken.user_id == user.id))
                audit(s, "password.changed", user.id, user.id)
                self.respond({})
            elif self.action == "revoke-own":
                self.body("Empty")
                user, _ = await self.identity(s)
                await invalidate(s, user.id)
                audit(s, "sessions.revoked", user.id, user.id)
                self.respond({})
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")
