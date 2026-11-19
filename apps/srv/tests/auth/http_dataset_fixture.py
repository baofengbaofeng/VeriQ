"""浏览器验收服务在专用库创建示例凭证时登记固定读取目标，实际权限判断和密钥查询仍经过正式代码。"""

import httpx
from sqlalchemy import event, select

from veriq_server.datasets import request
from veriq_server.datasets.connection import DatasetConnection
from veriq_server.db import SecretVersion, User, Workspace


def install(settings):
    """用浏览器夹具刚生成的标识配置部署注册表，只替换最外层传输并逐字检查客户端实际发出的参数与认证。"""

    @event.listens_for(SecretVersion, "after_insert")
    def provision(_mapper, connection, row):
        if (
            row.secret_ref != "browser_catalog"
            or connection.scalar(select(Workspace.key).where(Workspace.id == row.workspace_id))
            != "remote-form"
        ):
            return
        actor = connection.scalar(select(User.id).where(User.email == "browser-admin@example.com"))
        settings.dataset_connections["00000000-0000-4000-8000-000000000001"] = DatasetConnection(
            workspace_id=row.workspace_id,
            environment_version_id="00000000-0000-4000-8000-000000000002",
            origin="https://catalog.example",
            address="93.184.216.34",
            routes={"/items": ["GET"]},
            identity_id="dataset-reader",
            user_ids=[actor],
            credentials={row.secret_ref: {"version_id": row.id, "purposes": ["BEARER"]}},
            auth_kinds=["BEARER"],
        )

    def upstream(req):
        if (
            req.url.raw_path != b"/items?q=first&q="
            or req.headers.get("Authorization") != "Bearer browser-only-material"
        ):
            return httpx.Response(403, stream=httpx.ByteStream(b""))
        return httpx.Response(
            200, stream=httpx.ByteStream(b'{"items":[{"id":"one","name":"browser-only-material"}]}')
        )

    request.open_transport = lambda: httpx.MockTransport(upstream)
