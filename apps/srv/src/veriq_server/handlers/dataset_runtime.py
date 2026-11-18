"""私有数据通道只接受当前任务的设备租约证明，返回规范字节并禁止缓存，拒绝后不在错误正文中披露行内容。"""

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
