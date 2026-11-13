import asyncio
import json
from hashlib import sha256
from typing import Any
from tornado.iostream import StreamClosedError
from tornado.web import create_signed_value, decode_signed_value
from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes
from ..service import Problem, audit, lock_installation
from ..services.report import ReportService
from ..services.artifact import ArtifactService, artifact_store, verify
from .base import API


def encode_cursor(secret: str, scope: dict[str, str], positions: dict[str, int]) -> str:
    """签发绑定 Workspace/Run/用户的报告流游标；位置数超 2000 强制客户端重新同步；签名名 veriq_report_v1，版本 2，绑定用户防止游标转借。
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
    """校验签名游标作用域与单调位置；过期、越界或未知 Attempt 一律要求重新同步；位置不得超过 known 序列，且一日后过期强制重同步。
    decode_cursor 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
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
                or type(v) is not int
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


class ReportAPI(API):
    """报告与证据只读面：权威报告、展示片段、制品下载、事件历史以及 SSE 增量流；SSE 与制品下载共享 Workspace 授权，但事务持有策略不同。
    ReportAPI 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    ReportAPI 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
    """

    def prepare(self) -> None:
        """普通报告和原始证据入口仅接受员工 Cookie，显式 Bearer 头不会被忽略或借用同时存在的用户会话；受限 CI 必须使用独立安全摘要与 JUnit 路径，避免认证协议混淆扩大证据访问权限。"""
        super().prepare()
        if "Authorization" in self.request.headers:
            raise Problem(401, "EMPLOYEE_SESSION_REQUIRED", "Use the scoped CI report endpoint")

    body_limit = 256 * 1024

    async def get(self, workspace_id: str, subject_id: str = "", upload_id: str = "") -> None:
        """GET 分发报告/展示/制品列表/事件/审计；制品下载在校验哈希后沙箱附件输出；制品下载在外部读后再次授权并记 artifact.download 审计。
        get 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        get 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        scope = WorkspaceScope(workspace_id)
        if self.action == "report-artifact":
            async with self.db.sessions.begin() as session:
                await lock_installation(session)
                user, _ = await self.identity(session)
                upload, artifact = await ArtifactService(session, user).authorized(
                    scope, subject_id, upload_id
                )
                digest, size, backend, content, incarnation = (
                    artifact.sha256,
                    artifact.size_bytes,
                    artifact.storage_backend,
                    artifact.content,
                    artifact.storage_incarnation,
                )
            if backend != "INLINE":
                content = await artifact_store(self.config, backend).read(
                    workspace_id, digest, size, incarnation
                )
            if content is None:
                raise Problem(409, "INVALID_ARTIFACT", "Artifact bytes missing")
            verify(content, digest, size)
            async with self.db.sessions.begin() as session:
                await lock_installation(session)
                user, _ = await self.identity(session)
                # 外部读取后再次授权并记审计，防止长 I/O 期间权限被撤销仍交付。
                await ArtifactService(session, user).authorized(scope, subject_id, upload_id)
                audit(session, "artifact.download", user.id, upload_id, workspace_id=workspace_id)
            self.set_header("Content-Type", "application/octet-stream")
            self.set_header("Cache-Control", "private, no-store")
            self.set_header("Content-Security-Policy", "sandbox; default-src 'none'")
            self.set_header("Content-Disposition", f'attachment; filename="{upload_id}.bin"')
            self.finish(content)
            return
        async with self.db.sessions.begin() as session:
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

    def on_connection_close(self) -> None:
        """SSE 连接关闭时置位 disconnected，让流循环尽快退出而不再 flush；标志位供 post 循环检查，避免向已断开套接字 flush。
        on_connection_close 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        self.disconnected = True

    async def post(self, workspace_id: str, run_id: str) -> None:
        """POST SSE：短事务拉增量事件后释放权威锁，再 flush；授权失效发 authorization 事件；每轮短事务取数后释放锁，再进入 sleep/flush 背压阶段。
        post 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        post 处理报告或证据访问：原始制品与结构化报告权限需分开校验，避免越权下载 Trace。
        """
        self.disconnected = False
        data = self.body("ReportStreamRequest")
        scope = WorkspaceScope(workspace_id)
        cursor = data.get("cursor")
        positions: dict[str, int] = {}
        signature = ""
        first = True
        while not self.disconnected:
            try:
                async with self.db.sessions.begin() as session:
                    await lock_installation(session)
                    user, _ = await self.identity(session)
                    service = ReportService(session, user, self.config)
                    report = await service.get(scope, run_id)
                    binding = {"workspaceId": workspace_id, "runId": run_id, "userId": user.id}
                    attempts = await service.attempts(scope, run_id)
                    known = {a.id: a.last_sequence for a in attempts}
                    if first and cursor:
                        positions = decode_cursor(
                            self.config.signing_key.get_secret_value(), binding, cursor, known
                        )
                    events: list[dict[str, Any]] = []
                    event_bytes = 0
                    for attempt in attempts:
                        if known[attempt.id] <= positions.get(attempt.id, 0):
                            continue
                        page = await service.events(
                            scope,
                            attempt.id,
                            positions.get(attempt.id, 0),
                            100 - len(events),
                            1024 * 1024 - event_bytes,
                        )
                        events.extend(page["items"])
                        event_bytes += sum(len(canonical_bytes(e)) for e in page["items"])
                        positions[attempt.id] = page["nextSequence"]
                        if len(events) >= 100 or event_bytes >= 1024 * 1024:
                            break
                    latest = sha256(canonical_bytes(report)).hexdigest()
                    encoded = encode_cursor(
                        self.config.signing_key.get_secret_value(), binding, positions
                    )
                # flush/网络背压期间不得继续持有事务或权威锁。
                if first:
                    self.set_header("Content-Type", "text/event-stream")
                    self.set_header("X-Accel-Buffering", "no")
                if events or first or latest != signature:
                    self.write(
                        f"id: {encoded}\nevent: report\ndata: {json.dumps({'events': events, 'report': report}, separators=(',', ':'), ensure_ascii=False)}\n\n"
                    )
                else:
                    self.write(": keepalive\n\n")
                await self.flush()
                signature, first = latest, False
                await asyncio.sleep(1)
            except Problem as error:
                if first:
                    raise
                self.write(f"event: authorization\ndata: {json.dumps({'code': error.code})}\n\n")
                await self.flush()
                break
            except StreamClosedError:
                break
