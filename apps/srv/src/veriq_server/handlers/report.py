"""读取工作区内已授权的报告及证据，在稳定的数据库快照内计算增量后向员工会话逐帧发送变化。"""

import asyncio
import json
from typing import Any
from tornado.iostream import StreamClosedError
from tornado.web import create_signed_value, decode_signed_value
from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes
from ..service import Problem, audit, lock_installation
from ..services.report import ReportService
from ..services.report_stream import ReportStreamState, observe_report
from ..services.artifact import ArtifactService, artifact_store, verify
from .base import API


def encode_cursor(secret: str, scope: dict[str, str], positions: dict[str, int]) -> str:
    """签发绑定 Workspace/Run/用户的报告流游标；位置数超 2000 强制客户端重新同步；签名名 veriq_report_v1，版本 2，
    绑定用户防止游标转借。
    encode_cursor 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """
    if len(positions) > 2000:
        raise Problem(400, "REPORT_RESYNC_REQUIRED", "Cursor exceeds admitted Run bound")
    return create_signed_value(
        secret,
        "veriq_report_v1",
        json.dumps({"scope": scope, "positions": positions}, separators=(",", ":")),
        version=2,
    ).decode()


def decode_cursor(
    secret: str, scope: dict[str, str], cursor: str, known: dict[str, int]
) -> dict[str, int]:
    """校验签名游标作用域与单调位置；过期、越界或未知 Attempt 一律要求重新同步；位置不得超过 known 序列，
    且一日后过期强制重同步。decode_cursor 处理报告或证据访问：原始制品与结构化报告权限需分开校验，

    避免越权下载 Trace。
    """
    try:
        if len(cursor) > 230000:
            raise ValueError
        decoded = decode_signed_value(
            secret, "veriq_report_v1", cursor, max_age_days=1, min_version=2
        )
        value = json.loads(decoded or b"null")
        positions = value["positions"]
        if (
            value["scope"] != scope
            or not isinstance(positions, dict)
            or len(positions) > 2000
            or any(
                k not in known
                or isinstance(v, bool)
                or not isinstance(v, int)
                or v < 0
                or v > 9007199254740991
                or v > known[k]
                for k, v in positions.items()
            )
        ):
            raise ValueError
        return positions
    except (ValueError, TypeError, KeyError):
        raise Problem(
            400,
            "REPORT_RESYNC_REQUIRED",
            "Cursor invalid or expired; reload authoritative report and history",
        ) from None


async def _stream_events(
    service: ReportService, scope: WorkspaceScope, known: dict[str, int], positions: dict[str, int]
) -> list[dict[str, Any]]:
    """按照当前快照已经确认的最大序列读取事件，同一帧的事件数和字节数共用预算，游标只推进已读取的部分。"""
    events: list[dict[str, Any]] = []
    event_bytes = 0
    for attempt_id, sequence in known.items():
        offset = positions.get(attempt_id, 0)
        if sequence <= offset:
            continue
        page = await service.events(
            scope, attempt_id, offset, 100 - len(events), 1024 * 1024 - event_bytes
        )
        events.extend(page["items"])
        event_bytes += sum(len(canonical_bytes(e)) for e in page["items"])
        positions[attempt_id] = page["nextSequence"]
        if len(events) >= 100 or event_bytes >= 1024 * 1024:
            break
    return events


def _report_frame(cursor: str, events: list[dict[str, Any]], report: dict[str, Any]) -> str:
    """在快照事务结束后才序列化报告和本帧事件，使用与该帧内容一致的签名游标支持断开连接后的重放。"""
    payload = json.dumps(
        {"events": events, "report": report}, separators=(",", ":"), ensure_ascii=False
    )
    return f"id: {cursor}\nevent: report\ndata: {payload}\n\n"


class ReportAPI(API):
    """报告与证据只读面：权威报告、展示片段、制品下载、事件历史以及 SSE 增量流；SSE 与制品下载共享 Workspace 授权，
    但事务持有策略不同。ReportAPI 必须坚持 Workspace 归属与成员授权，

    嵌套资源引用不得跨空间隐式放行。ReportAPI 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载
    Trace。
    """

    def prepare(self) -> None:
        """普通报告和原始证据入口仅接受员工 Cookie，显式 Bearer 头不会被忽略或借用同时存在的用户会话；受限 CI
        必须使用独立安全摘要与 JUnit 路径，避免认证协议混淆扩大证据访问权限。
        """
        super().prepare()
        if "Authorization" in self.request.headers:
            raise Problem(401, "EMPLOYEE_SESSION_REQUIRED", "Use the scoped CI report endpoint")

    body_limit = 256 * 1024
    disconnected = False

    async def get(self, workspace_id: str, subject_id: str = "", upload_id: str = "") -> None:
        """GET 分发报告/展示/制品列表/事件/审计；制品下载在校验哈希后沙箱附件输出；制品下载在外部读后再次授权并记
        artifact.download 审计。get 必须坚持 Workspace 归属与成员授权，

        嵌套资源引用不得跨空间隐式放行。get 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        scope = WorkspaceScope(workspace_id)
        if self.action == "report-artifact":
            await self._download(scope, subject_id, upload_id)
            return
        async with self.db.sessions.begin() as session:
            if self.action == "report":
                await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            else:
                await lock_installation(session)
            user, _ = await self.identity(session)
            service = ReportService(session, user, self.config)
            if self.action == "report":
                result = await service.get(scope, subject_id)
            elif self.action == "report-display":
                result = await service.display(scope, subject_id, upload_id)
            elif self.action == "report-artifacts":
                result = {"items": await service.artifacts(scope, subject_id)}
            elif self.action == "report-history":
                raw = self.get_query_argument("after", "0")
                if (
                    not raw.isascii()
                    or not raw.isdecimal()
                    or len(raw) > 16
                    or int(raw) > 9007199254740991
                ):
                    raise Problem(400, "INVALID_CURSOR", "Invalid event sequence")
                result = await service.events(scope, subject_id, int(raw))
            else:
                result = await service.audit(scope, self.get_query_argument("after", ""))
        self.respond(result)

    async def _download(self, scope: WorkspaceScope, subject_id: str, upload_id: str) -> None:
        """按已授权的证据实例读取并验证外部字节，在下载开始之前重新核对调用者的当前权限并提交审计记录。"""
        async with self.db.sessions.begin() as session:
            installation = await lock_installation(session)
            user, _ = await self.identity(session)
            _, artifact = await ArtifactService(session, user).authorized(
                scope, subject_id, upload_id
            )
            digest, size, backend, content, incarnation = (
                artifact.sha256,
                artifact.size_bytes,
                artifact.storage_backend,
                artifact.content,
                artifact.storage_incarnation,
            )
            store = (
                await artifact_store(session, installation, self.config, backend)
                if backend != "INLINE"
                else None
            )
        if store is not None:
            content = await store.read(scope.workspace_id, digest, size, incarnation)
        if content is None:
            raise Problem(409, "INVALID_ARTIFACT", "Artifact bytes missing")
        verify(content, digest, size)
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            user, _ = await self.identity(session)
            # 外部证据读取并校验后重新授权及记录审计，防止读取期间权限已被撤销，仍按旧授权交付下载内容。
            await ArtifactService(session, user).authorized(scope, subject_id, upload_id)
            audit(session, "artifact.download", user.id, upload_id, workspace_id=scope.workspace_id)
        self.set_header("Content-Type", "application/octet-stream")
        self.set_header("Cache-Control", "private, no-store")
        self.set_header("Content-Security-Policy", "sandbox; default-src 'none'")
        self.set_header("Content-Disposition", f'attachment; filename="{upload_id}.bin"')
        self.finish(content)

    def on_connection_close(self) -> None:
        """SSE 连接关闭时置位 disconnected，让流循环尽快退出而不再 flush；标志位供 post 循环检查，避免向已断开套接字
        flush。on_connection_close

        处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        self.disconnected = True

    async def _poll_report(
        self,
        scope: WorkspaceScope,
        run_id: str,
        positions: dict[str, int],
        previous: ReportStreamState | None,
        cursor: str | None,
    ) -> tuple[ReportStreamState, str | None]:
        """在同一个可重复读快照内确认用户和运行的归属，使用本轮实际读取的事件序列签发下一次恢复游标。"""
        async with self.db.sessions.begin() as session:
            await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            user, _ = await self.identity(session)
            service = ReportService(session, user, self.config)
            state = await observe_report(session, await service.run(scope, run_id))
            binding = {"workspaceId": scope.workspace_id, "runId": run_id, "userId": user.id}
            secret = self.config.signing_key.get_secret_value()
            if previous is None and cursor:
                positions.update(decode_cursor(secret, binding, cursor, state.known))
            events = await _stream_events(service, scope, state.known, positions)
            if not events and state == previous:
                return state, None
            report = await service.get(scope, run_id, authorities=state.authorities)
            encoded = encode_cursor(secret, binding, positions)
        return state, _report_frame(encoded, events, report)

    async def post(self, workspace_id: str, run_id: str) -> None:
        """每轮在新的可重复读快照中鉴权并比较运行、门禁和证据变化，事务结束后再发送数据或心跳。"""
        self.disconnected = False
        data = self.body("ReportStreamRequest")
        scope = WorkspaceScope(workspace_id)
        cursor = data.get("cursor")
        positions: dict[str, int] = {}
        previous: ReportStreamState | None = None
        first = True
        while not self.disconnected:
            try:
                state, frame = await self._poll_report(scope, run_id, positions, previous, cursor)
                # 事件正文组装完成后先离开数据库事务，再向客户端写入并等待刷新，避免网络背压期间继续持有事务或权威锁。
                if first:
                    self.set_header("Content-Type", "text/event-stream")
                    self.set_header("X-Accel-Buffering", "no")
                self.write(frame if frame is not None else ": keepalive\n\n")
                await self.flush()
                previous, first = state, False
                await asyncio.sleep(1)
            except Problem as error:
                if first:
                    raise
                self.write(f"event: authorization\ndata: {json.dumps({'code': error.code})}\n\n")
                await self.flush()
                break
            except StreamClosedError:
                break
