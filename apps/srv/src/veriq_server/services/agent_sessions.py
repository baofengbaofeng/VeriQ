"""为对话控制面提供成员授权、私有会话历史和供应商选择；这些查询及写入均可在短事务内完成，不调用远程模型。"""

import re
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..db import AgentSession, AgentSettings, AgentTurn, AiProvider, Database, User, UserSession
from ..pagination import Page
from ..service import Problem, audit, lock_installation, now, stamp
from ..settings import Settings
from .ai import AiService
from .agent_capabilities import workspace_form_card
from .workspace import WorkspaceRepository

_DEFAULT_TITLE = "New conversation"
_TITLE_FIRST_SENTENCE = re.compile(r"[\r\n。！？!?]+|\.\s+")
_TITLE_SMALL_TALK = re.compile(
    r"(?:hi|hello|hey|thanks?(?: you)?|great|sure|ok(?:ay)?|please continue|continue|"
    r"你好|您好|谢谢(?:你)?|可以|好的?|行|明白了|继续|请继续|确认)",
    re.IGNORECASE,
)
_TITLE_FOLLOW_UP = re.compile(
    r"^(?:(?:and|also|make it|change it|keep the rest)\b|把它|再加[上入]|再补充|其余保持)",
    re.IGNORECASE,
)


def update_automatic_title(row: AgentSession, text: str) -> None:
    """在持有会话写入护栏的成功结算事务中，提取最新请求的有效主题，简短应答与依赖上文的补充保留现有标题。"""
    if row.title_locked:
        return
    for sentence in _TITLE_FIRST_SENTENCE.split(text):
        candidate = " ".join(sentence.split()).strip(" #*`-.,:;、，；：")
        if (
            not any(character.isalpha() for character in candidate)
            or _TITLE_SMALL_TALK.fullmatch(candidate)
            or (row.title != _DEFAULT_TITLE and _TITLE_FOLLOW_UP.match(candidate))
            or any(marker in candidate for marker in ("[REDACTED]", "[WITHHELD_REFERENCE]"))
        ):
            continue
        row.title = candidate if len(candidate) <= 72 else candidate[:71].rstrip() + "…"
        return


def session_dto(row: AgentSession) -> dict[str, Any]:
    """投影会话标识及显示元数据，员工归属只用于查询授权，界面可凭归档标记区分历史读取和可继续的会话。

    创建时间也参与历史分页，使用与游标相同的微秒精度。详情和创建响应使用这一投影，所以新客户端复用既有会话时可直接
    替换本地对象，不需要另发请求获取缺失的显示信息。
    """
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "title": row.title,
        "createdAt": stamp(row.created_at),
        "archived": row.archived,
    }


CONFIRMATION_SOURCE = "_proposalTurnId"


def receipt_dto(receipt: dict[str, Any] | None) -> dict[str, Any] | None:
    """确认重放所用的原始轮次标识只保存在服务端，回执输出仍维持现有的严格计划或 Run 业务字段。"""
    if receipt is None:
        return None
    return {key: value for key, value in receipt.items() if key != CONFIRMATION_SOURCE}


def turn_dto(row: AgentTurn) -> dict[str, Any]:
    """轮次只暴露界面需要的事实，重试身份和调用代际留在服务端；没有实际结果时省略对应字段，避免误报回执。

    创建时的供应商修订属于轮次固定信息，不能取当前设置替换。已验证的相关运行与本轮确认产生的回执作用不同：前者可用于
    回答对话内的问题，后者证明某次确认确实改变了计划或创建了运行。
    """
    optional = {
        "reply": row.reply,
        "errorCode": row.error_code,
        "providerId": row.provider_id,
        "providerRevision": row.provider_revision,
        "relatedRunId": row.related_run_id,
        "proposal": row.proposal,
        "receipt": receipt_dto(row.receipt),
        "thinking": row.reasoning_summary,
        "steps": row.steps,
        "attachments": row.attachments,
        "delegationMode": (
            row.delegation_mode
            if row.proposal
            and row.proposal.get("type") in {"RUN_ONCE", "TRIGGER_PLAN", "RERUN_RUN"}
            else None
        ),
    }
    return {
        "id": row.id,
        "text": row.text,
        "status": row.status,
        "createdAt": stamp(row.created_at),
        **{key: value for key, value in optional.items() if value is not None},
    }


def _history_page[T: (AgentSession, AgentTurn)](
    rows: Sequence[T], page: Page, dto: Callable[[T], dict[str, Any]]
) -> dict[str, Any]:
    """数据库最多查询一条额外记录判断后续页，游标取本页最后一条的微秒时间和标识，支持相同时间的稳定排序。

    所选第二排序键依赖 UUID 列的二进制校对规则，与 Python 写入游标的字符串值一致。页末没有额外记录时结束翻页；
    最后一个可见对象与游标不能来自不同记录，否则分页会漏掉实际存在的历史。
    """
    visible = rows[: page.limit]
    cursor = None
    if visible:
        last = visible[-1]
        cursor = page.next((stamp(last.created_at), last.id), len(rows) > page.limit)
    return {"items": [dto(row) for row in visible], "nextCursor": cursor}


class AgentSessionService:
    """把可复用的存储查询和权限边界放在同一服务中，写操作与现有供应商和工作区服务共用安装行锁，读取保持独立。

    轮次编排可在不同调用阶段分别进入短事务，重新获取当前员工、工作区权限与私有会话。
    """

    def __init__(
        self,
        db: Database,
        settings: Settings,
        identity: Callable[[AsyncSession], Awaitable[tuple[User, UserSession]]],
    ):
        """沿用请求绑定的真实员工会话和供应商出口白名单，入口无需解释密钥、配置内容或 Provider 归属。"""
        self.db = db
        self.identity = identity
        self.ai = AiService(db, settings, identity)

    @asynccontextmanager
    async def transaction(
        self,
        scope: WorkspaceScope,
        permission: Permission = Permission.VIEW,
        *,
        write: bool = False,
        lock: bool = False,
    ) -> AsyncIterator[tuple[AsyncSession, User]]:
        """每段短事务均重查登录身份与当前成员权限，写入先锁安装行再鉴权，以便成员、归档和供应商变更能够按同一顺序生效。

        调用者必须在进入远程模型调用前结束事务，避免处理器持锁等待外部网络响应。
        """
        async with self.db.sessions.begin() as session:
            if write or lock:
                await lock_installation(session)
            user, _ = await self.identity(session)
            await WorkspaceRepository(session, scope).authorize(user, permission, write=write)
            yield session, user

    async def read_settings(self, session: AsyncSession, scope: WorkspaceScope) -> dict[str, Any]:
        """成员设置读取仅投影选择标识和当前可用性，停用、删除或运营方收回出口权限时保留选择并返回受限错误码。"""
        row = await session.get(AgentSettings, scope.workspace_id)
        return await self._settings_dto(session, scope, row)

    async def write_settings(
        self, session: AsyncSession, scope: WorkspaceScope, user: User, data: dict[str, Any]
    ) -> dict[str, Any]:
        """在管理事务验证两个独立选择后一次写入，专用模型有效时也会校验默认引用，任一失败则整个设置保持原样。"""
        default, dedicated = (
            value.lower() if value is not None else None
            for value in (data["defaultProviderId"], data["agentProviderId"])
        )
        for provider_id in dict.fromkeys((default, dedicated)):
            if provider_id is not None:
                await self.ai.provider(session, scope, provider_id, enabled=True)

        # 初次配置可能由多个客户端同时提交，调用方持有的安装锁也保护这一尚无行可锁的创建路径。
        row = await session.get(AgentSettings, scope.workspace_id)
        if row is None:
            row = AgentSettings(workspace_id=scope.workspace_id)
            session.add(row)
        row.default_provider_id = default
        row.agent_provider_id = dedicated
        # 管理审计仅记录工作区设置变更这一事实，正文、连接配置和会话内容留在各自受约束的读取面。
        audit(
            session,
            "agent.settings.updated",
            user.id,
            scope.workspace_id,
            workspace_id=scope.workspace_id,
        )
        return await self._settings_dto(session, scope, row)

    async def _settings_dto(
        self, session: AsyncSession, scope: WorkspaceScope, row: AgentSettings | None
    ) -> dict[str, Any]:
        """以当前绑定计算公开状态，有专用标识时优先校验该标识，失效后依然保留足够信息让管理员重新选择。"""
        default = row.default_provider_id if row else None
        dedicated = row.agent_provider_id if row else None
        selected = dedicated or default
        result = {
            "defaultProviderId": default,
            "agentProviderId": dedicated,
            "resolvedProviderId": None,
            "providerStatus": "UNCONFIGURED",
        }
        if selected is None:
            return result
        # 供应商可由现有独立入口修改；每次读取设置都重新检查软删除、停用和运营方白名单，并让普通历史独立可读。
        try:
            provider = await self.ai.provider(session, scope, selected, enabled=True)
        except Problem as problem:
            return {**result, "providerStatus": "UNAVAILABLE", "errorCode": problem.code}
        if "supportsImages" in provider.config:
            result["supportsImages"] = provider.config["supportsImages"]
        return {**result, "providerStatus": "READY", "resolvedProviderId": selected}

    async def resolve_provider(self, session: AsyncSession, scope: WorkspaceScope) -> AiProvider:
        """供轮次编排在授权事务内取得可用供应商，专用选择无法使用时传播确定的原因，只有清空专用标识才继承默认值。

        这里读取的是当前选择；入队时产生的供应商修订用于后续重新检查。管理设置写入和供应商变化都会获取同一把锁，调用方可
        在短事务中安全冻结当前选择后再释放锁并发出调用。
        """
        row = await session.get(AgentSettings, scope.workspace_id)
        selected = (row.agent_provider_id or row.default_provider_id) if row else None
        if selected is None:
            raise Problem(
                409, "AGENT_PROVIDER_UNCONFIGURED", "No conversation Provider is configured"
            )
        return await self.ai.provider(session, scope, selected, enabled=True)

    def create_session(
        self, session: AsyncSession, scope: WorkspaceScope, user: User, title: str | None
    ) -> AgentSession:
        """新会话始终绑定到当前员工，显式给出的标题立即锁定，省略标题的会话允许根据后续成功轮次自动命名。"""
        row = AgentSession(
            id=str(uuid4()),
            workspace_id=scope.workspace_id,
            user_id=user.id,
            title=title.strip() if title is not None else _DEFAULT_TITLE,
            title_locked=title is not None,
            created_at=now(),
            archived=False,
        )
        session.add(row)
        return row

    async def require_owned_session(
        self,
        session: AsyncSession,
        scope: WorkspaceScope,
        user: User,
        session_id: str,
        *,
        active: bool = False,
    ) -> AgentSession:
        """同时按工作区、员工和会话标识选择授权行，陌生标识与不存在形状一致；需要继续写轮次的入口拒绝归档状态。"""
        row = await session.scalar(
            select(AgentSession).where(
                AgentSession.id == session_id.lower(),
                AgentSession.workspace_id == scope.workspace_id,
                AgentSession.user_id == user.id,
            )
        )
        if row is None:
            raise Problem(404, "AGENT_SESSION_NOT_FOUND", "Conversation session not found")
        # 归档由本人完成并保留历史读取，但提交和确认都要求活跃会话，避免跨客户端在已经归档的会话继续写入。
        if active and row.archived:
            raise Problem(409, "AGENT_SESSION_ARCHIVED", "Conversation session is archived")
        return row

    async def rename_session(
        self, session: AsyncSession, scope: WorkspaceScope, user: User, session_id: str, title: str
    ) -> AgentSession:
        """重命名更新个人会话并在同一写事务锁定标题，即使选用当前文本，较晚完成的模型调用也不会覆盖手工名称。"""
        row = await self.require_owned_session(session, scope, user, session_id)
        row.title = title
        row.title_locked = True
        return row

    async def require_owned_turn(
        self, session: AsyncSession, owned: AgentSession, turn_id: str
    ) -> AgentTurn:
        """轮次查找只接受当前已授权的会话行，提交确认时拒绝把同一员工的另一个会话中的轮次当作这里的提议。"""
        row = await session.scalar(
            select(AgentTurn).where(
                AgentTurn.id == turn_id.lower(), AgentTurn.session_id == owned.id
            )
        )
        if row is None:
            raise Problem(404, "AGENT_TURN_NOT_FOUND", "Conversation turn not found")
        return row

    async def list_sessions(
        self,
        session: AsyncSession,
        scope: WorkspaceScope,
        user: User,
        page: Page,
        *,
        archived: bool,
    ) -> dict[str, Any]:
        """历史会话按最近创建顺序显示，从所属员工及工作区的复合索引继续扫描，归档列表可独立翻页且不会混入活跃会话。"""
        query = select(AgentSession).where(
            AgentSession.workspace_id == scope.workspace_id,
            AgentSession.user_id == user.id,
            AgentSession.archived.is_(archived),
        )
        # 倒序从游标时间之前继续；同一时间仅接受较小的标识，防止重复读取已经出现在前一页中的会话。
        if page.last:
            timestamp, cursor_id = page.last
            before = datetime.fromisoformat(timestamp.removesuffix("Z"))
            query = query.where(
                or_(
                    AgentSession.created_at < before,
                    and_(AgentSession.created_at == before, AgentSession.id < cursor_id),
                )
            )
        rows = await session.scalars(
            query.order_by(AgentSession.created_at.desc(), AgentSession.id.desc()).limit(
                page.limit + 1
            )
        )
        return _history_page(rows.all(), page, session_dto)

    async def list_turns(
        self, session: AsyncSession, owned: AgentSession, user: User, page: Page
    ) -> dict[str, Any]:
        """按已授权会话的主键从最早轮次开始分页，任何新轮次都会顺延展示，遇到相同微秒时用标识作为第二排序键。"""
        query = select(AgentTurn).where(AgentTurn.session_id == owned.id)
        # 轮次采用正序以便追加显示，起点由服务端签名并读取，用户不能通过改写游标把历史读取切换到另一个会话。
        if page.last:
            timestamp, cursor_id = page.last
            after = datetime.fromisoformat(timestamp.removesuffix("Z"))
            query = query.where(
                or_(
                    AgentTurn.created_at > after,
                    and_(AgentTurn.created_at == after, AgentTurn.id > cursor_id),
                )
            )
        rows = await session.scalars(
            query.order_by(AgentTurn.created_at, AgentTurn.id).limit(page.limit + 1)
        )
        history = rows.all()
        scope = WorkspaceScope(owned.workspace_id)
        projected = {
            row.id: await self.visible_turn(session, scope, user, row)
            for row in history[: page.limit]
        }
        return _history_page(history, page, lambda row: projected[row.id])

    @staticmethod
    async def visible_turn(
        session: AsyncSession, scope: WorkspaceScope, user: User, row: AgentTurn
    ) -> dict[str, Any]:
        """从当前角色仍可使用的工作区操作重建入口；历史正文与当时的回复记录由既有会话权限管理。"""
        result = turn_dto(row)
        if row.status == "COMPLETED" and row.workspace_capability:
            try:
                result["workspaceForm"] = await workspace_form_card(
                    session, scope, user, row.workspace_capability
                )
            except Problem:
                pass
        return result

    async def recent_turns(self, session: AsyncSession, owned: AgentSession) -> list[AgentTurn]:
        """模型上下文仅可选已授权会话最近八条已完成的轮次，按对话顺序交给编排服务进一步筛选并限制投影字节数。

        正在调用模型的轮次可能尚未持久化回复，失败轮次也不代表可以继续应用的操作。按索引从最后一条向前读取有界窗口，
        再还原到对话顺序，使上下文的前后依赖不受分页次序影响。
        """
        rows = await session.scalars(
            select(AgentTurn)
            .where(AgentTurn.session_id == owned.id, AgentTurn.status == "COMPLETED")
            .order_by(AgentTurn.created_at.desc(), AgentTurn.id.desc())
            .limit(8)
        )
        return list(reversed(rows.all()))
