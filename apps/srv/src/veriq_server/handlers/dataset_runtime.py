"""私有数据通道只接受当前任务的设备租约证明，返回规范字节并禁止缓存，拒绝后不在错误正文中披露行内容。"""

import asyncio

from ..contracts import canonical_bytes
from ..datasets.request import fetch_rows
from ..service import now, stamp
from ..auth.authorization import WorkspaceScope
from ..repositories.resource import ResourceRepository
from ..service import Problem, lock_installation
from ..services.connected_datasets import static_bytes
from ..services.lease import LeaseService
from .execution import ExecutionAPI


class StaticDatasetAPI(ExecutionAPI):
    """沿用设备执行接口的证明解析和会话撤销语义，候选验证源可以在准备时读取，测试数据须等激活完成。"""

    async def post(self, attempt_id: str) -> None:
        """设备授权、工作区、围栏和取消状态均在读取不可变正文之前重新核对，整个读取使用同一安装锁和事务。"""
        selection = self.body("StaticDatasetSelection")
        async with self.db.sessions.begin() as session:
            await lock_installation(session)
            attempt, job, runtime, _ = await LeaseService(session, self.config).proof(
                attempt_id,
                self.header_proof(),
                active=selection["selection"] != "VALIDATION_SOURCE",
            )
            if job.state not in {"LEASED", "RUNNING"} or job.workspace_id != attempt.workspace_id:
                raise Problem(403, "DATASET_NOT_ASSIGNED", "Attempt is not current")
            if job.kind == "VALIDATE" and runtime.trust_status != "MANAGED":
                raise Problem(403, "MANAGED_RUNTIME_REQUIRED", "Managed validation required")
            body = await static_bytes(
                ResourceRepository(session, WorkspaceScope(job.workspace_id)),
                job,
                attempt.snapshot_hash,
                selection,
            )
        self.set_header("Content-Type", "application/octet-stream")
        self.set_header("Cache-Control", "no-store")
        self.finish(body)


class HttpDatasetAPI(ExecutionAPI):
    """只接受固定版本和类型化实参，读取所需地址、权限身份、环境及凭证全部从服务器自己的冻结执行记录取得。"""

    body_limit = 65536
    _disconnected = False
    _read: asyncio.Task | None = None

    def on_connection_close(self) -> None:
        """请求离开私有通道后只取消本处理器持有的上游读取，让连接池收回套接字和并发槽而不影响其它测试。"""
        self._disconnected = True
        if self._read is not None:
            self._read.cancel()
        super().on_connection_close()

    async def post(self, attempt_id: str) -> None:
        """读取前、每页或重试之前及返回前均使用新事务。网络请求期间没有打开安装锁，也没有长期数据库会话。"""
        selection = self.body("HttpDatasetSelection")
        proof = self.header_proof()
        vid = selection["versionId"]
        denied = Problem(403, "DATASET_NOT_ASSIGNED", "Dataset is not assigned to this Attempt")

        async def authorize(resolve=False):
            async with self.db.sessions.begin() as session:
                await lock_installation(session)
                return await LeaseService(session, self.config).http_dataset(
                    attempt_id, proof, vid, resolve=resolve
                )

        config, secret = await authorize(resolve=True)

        async def recheck():
            current, _ = await authorize()
            if current != config:
                raise denied

        if self._disconnected:
            return
        self._read = asyncio.create_task(
            fetch_rows(config, selection["parameters"], secret, recheck=recheck)
        )
        try:
            rows = await self._read
        except asyncio.CancelledError:
            if self._disconnected:
                return
            raise
        finally:
            self._read = None
        fetched_at = stamp(now())
        await recheck()
        if self._disconnected:
            return
        self.set_header("Cache-Control", "no-store")
        self.set_header("Content-Type", "application/json")
        self.finish(
            canonical_bytes({"sourceVersionId": vid, "fetchedAt": fetched_at, "rows": rows})
        )
