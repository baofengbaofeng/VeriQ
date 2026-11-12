"""本模块封装控制面安装初始化、Argon2 口令哈希、会话批量失效与一次性重置令牌签发，并通过安装行锁与审计记录保证初始化竞态下只成功一次且可追溯。

安装单例行（id=1）用 FOR UPDATE 串行化 setup/initialize；口令哈希在线程池中执行以免阻塞事件循环。
不存在用户时仍对 dummy_hash 做恒定开销校验，避免邮箱枚举侧信道。
重置令牌只存 SHA-256，新签发会删除同用户全部旧令牌，保证链接互斥。
"""

import asyncio
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, UTC
from uuid import uuid4
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import AuditLog, Database, Installation, User, UserSession, UserToken

password_hasher = PasswordHasher()
# 缺失账号时仍执行同等哈希工作量的占位摘要，材料随机生成且永不对应真实口令。
dummy_hash = password_hasher.hash(secrets.token_urlsafe(32))


def now() -> datetime:
    """返回去掉 tzinfo 的 UTC 墙钟时间，与 DATETIME(fsp=6) 列及 stamp() 序列化约定严格对齐。
    now 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return datetime.now(UTC).replace(tzinfo=None)


def stamp(value: datetime) -> str:
    """将 naive UTC 时间格式化为微秒精度 ISO8601 并追加 Z 后缀，供 API 与邮件过期时间展示使用，stamp 的失败路径返回稳定错误。
    stamp 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return value.isoformat(timespec="microseconds") + "Z"


def digest(value: str) -> str:
    """对明文令牌或安装密钥做 SHA-256 十六进制摘要，数据库内只持久化摘要而从不回存明文，digest 的失败路径返回稳定错误。
    digest 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return hashlib.sha256(value.encode()).hexdigest()


class Problem(Exception):
    """控制面可映射的 HTTP 问题对象：携带 status、code、message，由处理器转为稳定错误响应体，Problem 的失败路径返回稳定错误。
    Problem 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def __init__(self, status: int, code: str, message: str):
        """保存 HTTP 状态、稳定错误码与面向客户端的说明消息，供处理器直接序列化输出，Problem.__init__ 的失败路径返回稳定错误。
        __init__ 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.status, self.code, self.message = status, code, message


def user_dto(user: User) -> dict[str, Any]:
    """导出普通用户可见字段，刻意省略 systemAdmin 与口令哈希等特权或机密属性，防止越权泄露，user_dto 的失败路径返回稳定错误。
    user_dto 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.display_name,
        "disabled": user.disabled,
    }


def admin_dto(user: User) -> dict[str, Any]:
    """在 user_dto 基础上附加 systemAdmin 标志，仅供系统管理员列表与详情接口返回使用，admin_dto 的失败路径返回稳定错误。
    admin_dto 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return {**user_dto(user), "systemAdmin": user.system_admin}


def audit(
    s: AsyncSession,
    action: str,
    actor: str | None = None,
    target: str | None = None,
    *,
    workspace_id: str | None = None,
) -> None:
    """向当前事务追加一条审计行；可绑定 Workspace，失败不单独提交，随调用方事务一起回滚，audit 的失败路径返回稳定错误。
    audit 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """
    s.add(
        AuditLog(
            id=str(uuid4()),
            actor_id=actor,
            target_id=target,
            workspace_id=workspace_id,
            action=action,
            created_at=now(),
        )
    )


async def lock_installation(s: AsyncSession) -> Installation:
    """对安装单例行加写锁，串行化初始化、密钥登记以及依赖该护栏的 Workspace 级突变，lock_installation 的失败路径返回稳定错误。
    lock_installation 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return (
        await s.execute(select(Installation).where(Installation.id == 1).with_for_update())
    ).scalar_one()


async def provision_setup_secret(db: Database, secret: str) -> None:
    """在未初始化安装上登记 setup 密钥摘要；若已初始化则返回 409，防止重复开局覆盖密钥，provision_setup_secret 的失败路径返回稳定错误。
    provision_setup_secret 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """
    async with db.sessions.begin() as s:
        installation = await lock_installation(s)
        if installation.initialized:
            raise Problem(409, "ALREADY_INITIALIZED", "Installation already initialized")
        installation.setup_secret_hash = digest(secret)


async def hash_password(password: str) -> str:
    """校验长度后用 Argon2 在线程池中异步哈希口令；过短或过长一律以 WEAK_PASSWORD 拒绝，hash_password 的失败路径返回稳定错误。
    hash_password 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    if len(password) < 12 or len(password) > 1024:
        raise Problem(400, "WEAK_PASSWORD", "Password must contain 12 to 1024 characters")
    return await asyncio.to_thread(password_hasher.hash, password)


async def verify(password_hash: str, password: str) -> bool:
    """在线程池中校验 Argon2 摘要，VerificationError 统一归一为 False 而不泄露哈希细节，verify 的失败路径返回稳定错误。
    verify 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    try:
        return await asyncio.to_thread(password_hasher.verify, password_hash, password)
    except VerificationError:
        return False


async def create_user(s: AsyncSession, data: dict[str, Any], *, first: bool = False) -> User:
    """在当前会话创建用户：邮箱小写化、口令哈希入库；first=True 时强制授予系统管理员角色，create_user 的失败路径返回稳定错误。
    create_user 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    user = User(
        id=str(uuid4()),
        email=data["email"].lower(),
        display_name=data["displayName"],
        password_hash=await hash_password(data["password"]),
        disabled=False,
        system_admin=first or data.get("systemAdmin", False),
    )
    s.add(user)
    await s.flush()
    return user


async def initialize(db: Database, data: dict[str, Any]) -> User:
    """消费安装密钥创建首位系统管理员并标记 initialized，成功后清空 setup_secret_hash 防重放，initialize 的失败路径返回稳定错误。
    initialize 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    async with db.sessions.begin() as s:
        installation = await lock_installation(s)
        if installation.initialized:
            raise Problem(409, "ALREADY_INITIALIZED", "Installation already initialized")
        if not installation.setup_secret_hash or not hmac.compare_digest(
            installation.setup_secret_hash, digest(data["installationSecret"])
        ):
            raise Problem(403, "INVALID_INSTALLATION_SECRET", "Installation secret is invalid")
        user = await create_user(s, data, first=True)
        installation.initialized = True
        installation.setup_secret_hash = None
        audit(s, "installation.initialized", user.id, user.id)
        return user


async def invalidate(s: AsyncSession, user_id: str) -> None:
    """删除指定用户的全部会话行，用于改密、禁用或管理员强制吊销后立即失效 Cookie，invalidate 的失败路径返回稳定错误。
    invalidate 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    await s.execute(delete(UserSession).where(UserSession.user_id == user_id))


async def issue_reset(s: AsyncSession, user: User, minutes: int) -> tuple[str, datetime]:
    """签发一次性密码重置令牌：先清空旧令牌，再写入新摘要与过期时间，明文仅返回给投递层，issue_reset 的失败路径返回稳定错误。
    issue_reset 实现于 apps/srv/src/veriq_server/service.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    新链接必须取代全部旧重置链接，避免多枚未过期令牌并存。
    """
    await s.execute(delete(UserToken).where(UserToken.user_id == user.id))
    token = secrets.token_urlsafe(32)
    expiry = now() + timedelta(minutes=minutes)
    s.add(
        UserToken(
            id=str(uuid4()),
            user_id=user.id,
            token_hash=digest(token),
            expires_at=expiry,
            consumed=False,
        )
    )
    return token, expiry
