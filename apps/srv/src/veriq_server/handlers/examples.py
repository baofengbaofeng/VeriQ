"""示例清单是经过员工会话认证的只读包资源入口，响应使用现有数据和 requestId 信封，不读取部署秘密或接受文件路径，也不在
HTTP 进程中执行导入、编译或后台长任务。

资产创建、引用验证及发布继续走各自 Workspace 授权端点。模板只提供固定公开示例，取得清单本身不授予任何空间编辑权限。
"""

from ..examples.resources import sample_package
from ..service import Problem
from .base import API


class SampleWorkspaceExampleAPI(API):
    """GET 返回实际安装 wheel 中的清单、七类文档和字节散列，要求当前有效员工会话；控制服务不依赖 Git、Node、
    仓库相对路径或设备身份来读取这些固定公开示例。
    """

    def prepare(self) -> None:
        """只接受现有员工协议下的 GET 请求，并保留基类的大小、请求标识和响应安全策略；其它动词失败关闭，
        不能通过该只读端点绕过正常资源写入与发布协议。
        """
        super().prepare()
        if self.request.method != "GET":
            raise Problem(405, "METHOD_NOT_ALLOWED", "Sample resources require GET")

    async def get(self) -> None:
        """先核验员工会话再读取固定包内资源，资源损坏或安装缺失返回明确不可用而不是空清单；HTTP
        错误不包含实际后端路径或底层异常正文，便于安全反馈安装问题。
        """
        async with self.db.sessions() as session:
            await self.identity(session)
        try:
            package = sample_package()
        except (OSError, ValueError, TypeError, AttributeError):
            raise Problem(
                503, "SAMPLE_RESOURCES_UNAVAILABLE", "Bundled sample resources are unavailable"
            ) from None
        self.respond(package)
