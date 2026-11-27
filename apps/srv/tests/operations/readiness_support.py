"""共享两组就绪测试的真实 HTTP 应用与响应检查，让存储策略只改变启动配置及各自替代的依赖边界。"""

from collections import abc
import contextlib
import pathlib
import runpy
from typing import Any, Literal, TypedDict

import httpx
import pydantic
import pytest
import sqlalchemy
from tornado import httpserver, netutil, web

from veriq_server import app, db, settings, validation

# 复用唯一守卫夹具，避免另造清库算法或绕过专用库检查；新应用只借用该夹具已经迁移的数据库句柄。
site_fixture = runpy.run_path(str(pathlib.Path(__file__).parents[1] / "auth" / "conftest.py"))[
    "site"
]


class ReadinessSite(TypedDict):
    """只保留当前生产应用及其实际依赖的句柄，让故障注入和恢复操作始终指向同一轮夹具的独占资源。"""

    client: httpx.AsyncClient
    application: web.Application
    config: settings.Settings
    artifacts: pathlib.Path
    static: pathlib.Path
    database: db.Database


class ReadinessStorageOptions(TypedDict, total=False):
    """允许测试在构造应用配置前选定存储策略，缺省字段交由生产模型填充并保持原有校验和失败行为。"""

    artifact_backend: Literal["FILE", "S3"]
    artifact_s3_bucket: str
    artifact_s3_endpoint: str
    artifact_s3_region: str
    readiness_s3_strategy: Literal["disabled", "read-object", "head-bucket"]
    readiness_s3_object_key: str
    readiness_s3_object_sha256: str
    readiness_s3_object_size: int


# 返回的启动器只接收待校验的存储选项；异步上下文按原顺序管理监听器、探针及应用后台任务。
type ReadinessServer = abc.Callable[
    [ReadinessStorageOptions], contextlib.AbstractAsyncContextManager[ReadinessSite]
]


@pytest.fixture(name="readiness_server")
def create_readiness_server(
    site: tuple[httpx.AsyncClient, db.Database],
    static_package: pathlib.Path,
    tmp_path: pathlib.Path,
) -> ReadinessServer:
    """每轮启动真实生产 HTTP 应用并预建隔离制品根，沿用静态安装库存而不修改生产探针或返回结果。

    认证夹具先在真实隔离库迁移并创建 Installation；这里不伪造数据库成功，不需要管理员会话。
    FILE 根在启动前创建，因为正式探针禁止静默创建丢失的目录。首次探针仍由各测试的实际 HTTP 请求触发。
    端口由系统分配，避免与复用夹具的固定认证端口冲突。客户端仅替代外部 TLS 终结，不启动浏览器。
    收尾等待监视器工作结束后再归还共享数据库，避免线程和连接池跨越 pytest 的事件循环。

    runpy 返回既有 site 定义，pytest 仍负责它的正常建立和拆除，不在这里重复手动调用夹具。
    新应用与 site 共用 Database，故必须先关闭本应用监视器，最后才让 site 释放连接池。
    生产配置使用 site 的同一专用 DSN，迁移目标与探测目标不会因第二套环境变量而分离。
    固定的合成加密密钥只满足应用配置，探针没有创建或读取任何业务密文。
    HTTP 客户端不发送 Cookie，因而健康检查的成功不能来自认证绕过或管理员身份。
    static_package 仅替换包资源定位，生产 load_published_site 仍校验真正落盘的库存与摘要。
    字典同时保留文件根和数据库句柄，故障注入能精确修改当前应用实际使用的那个依赖。
    关闭 reset_dispatcher 只回收此应用拥有的后台任务，不触碰外部服务或其它测试实例。
    """

    @contextlib.asynccontextmanager
    async def launch(storage: ReadinessStorageOptions) -> abc.AsyncIterator[ReadinessSite]:
        """在进入上下文时构造设置并绑定回环端口，退出时等待应用拥有的探针结束再归还共享数据库连接。"""
        database = site[1]
        artifacts = tmp_path / "readiness-artifacts"
        artifacts.mkdir()
        config = settings.Settings(
            database_url=pydantic.SecretStr(
                database.engine.url.render_as_string(hide_password=False)
            ),
            public_url="https://veriq.example.com",
            master_key=pydantic.SecretStr("a" * 64),
            signing_key=pydantic.SecretStr("b" * 64),
            artifact_directory=str(artifacts),
            **storage,
        )
        application = app.make_app(config, database)
        sockets = netutil.bind_sockets(0, "127.0.0.1")
        server = httpserver.HTTPServer(application)
        server.add_sockets(sockets)
        try:
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{sockets[0].getsockname()[1]}",
                trust_env=config.artifact_backend != "S3",
            ) as client:
                yield {
                    "client": client,
                    "application": application,
                    "config": config,
                    "artifacts": artifacts,
                    "static": static_package,
                    "database": database,
                }
        finally:
            server.stop()
            await server.close_all_connections()
            await application.settings["readiness_monitor"].close()
            await application.settings["reset_dispatcher"].close()

    return launch


def _json_strings(payload: object) -> abc.Iterator[str]:
    """遍历解码后的对象键与字符串叶节点，数组继续逐项展开，防止转义内容在嵌套结构中绕过隐私筛查。"""
    pending = [payload]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            pending.extend(value)
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)


def _assert_private_absent(surfaces: abc.Iterable[str], private: tuple[str | None, ...]) -> None:
    """先逐个扫描正文与响应头，解码后再扫描嵌套键和值；一旦发现配置片段即以固定消息终止诊断。"""
    for surface in surfaces:
        if any(value and value in surface for value in private):
            pytest.fail("Health response exposed private configuration", pytrace=False)


def health_payload(
    response: httpx.Response,
    config: settings.Settings,
    markers: tuple[str, ...] = (),
) -> dict[str, Any]:
    """筛查原始正文、响应头与解码字符串，所有健康别名在模式或字段断言前都遵守同一条诊断脱敏顺序。"""
    dsn = config.database_url.get_secret_value()
    url = sqlalchemy.engine.make_url(dsn)
    private = (
        dsn,
        url.render_as_string(hide_password=True),
        url.password,
        config.master_key.get_secret_value(),
        config.signing_key.get_secret_value(),
        config.artifact_directory,
        *markers,
    )
    _assert_private_absent((response.text, *response.headers.values()), private)
    # HTTP 头名不区分大小写，扫描前对两侧取相同的小写形式；正文和头值仍使用原始精确匹配。
    header_markers = tuple(value.lower() for value in private if value)
    _assert_private_absent((name.lower() for name in response.headers), header_markers)

    try:
        payload: object = response.json()
    except (ValueError, RecursionError):
        payload = None
    # 离开解码异常处理后再发出固定失败，避免原始 JSON 文档附着在异常上下文并随诊断一起输出。
    if not isinstance(payload, dict):
        pytest.fail("Health response did not contain a JSON object", pytrace=False)
    _assert_private_absent(_json_strings(payload), private)

    assert response.headers["content-type"].partition(";")[0] == "application/json"
    assert response.headers["cache-control"] == "no-store"
    request_id = response.headers["x-request-id"]
    assert request_id.strip()
    assert payload["requestId"] == request_id
    return payload


def assert_public_response(
    response: httpx.Response,
    config: settings.Settings,
    failed: str | None = None,
    markers: tuple[str, ...] = (),
) -> None:
    """核对完整五项依赖与标准信封，并用固定失败消息报告潜在泄漏，避免断言重写再次打印私有配置内容。

    正常结果必须精确包含五个布尔值；故障场景仅允许指定依赖变为 false，其余真实检查仍需成功。
    校验现有 HealthDTOEnvelope，禁止多出任意异常字段。缓存头保持 no-store，代理不应持久缓存运行状态。
    敏感项只在测试进程内比较；若泄漏，输出固定诊断而不把发现的私有地址、路径或口令放进失败日志。

    顶层只允许 data 与 requestId，避免新增异常诊断键绕过 checks 的精确相等断言。
    状态码与 data.status 同时比较，防止只改 JSON 文本却仍让负载均衡器把故障实例判为成功。
    Schema 校验约束字段类型，完整字典相等还约束字段数量和每个探针的独立取值。
    DSN 整串检查覆盖完整连接地址，另外提取口令，覆盖驱动只返回密码片段的泄漏方式。
    FILE 根路径单独检查，因为文件系统异常通常不会携带数据库 DSN 或加密密钥。
    两个合成密钥也参与比较，避免响应错误地序列化 Settings 的秘密字段。
    私有值不作为 assert 的操作数，pytest 的表达式展开不能因检测到泄漏而再次回显秘密。
    这里不检查服务日志或原始 Trace，HTTP 正文没有泄漏不能被推断为所有证据通道均已安全。
    解析前筛查原始正文和响应头，解码后筛查键和值，模式验证与请求号断言都在两次筛查之后执行。
    字段布局未知或同时违反多个规则时，也必须优先给出固定消息，不能让模式错误抢先公开额外字段。
    """
    payload = health_payload(response, config, markers)
    checks = dict.fromkeys(("database", "mysqlVersion", "schema", "static", "storage"), True)
    if failed:
        checks[failed] = False
    assert response.status_code == (503 if failed else 200)
    validation.validate_api("HealthDTOEnvelope", payload)
    assert set(payload) == {"data", "requestId"}
    assert payload["data"] == {
        "status": "degraded" if failed else "ok",
        "checks": checks,
    }


async def assert_legacy_ready(
    context: ReadinessSite, ready: bool, markers: tuple[str, ...] = ()
) -> None:
    """历史就绪保留独立的成功与错误信封，先筛查注入标记和私有配置，再核对请求号关联及完整正文。"""
    response = await context["client"].get("/api/v1/health/ready")
    payload = health_payload(response, context["config"], markers)
    request_id = response.headers["x-request-id"]
    if ready:
        assert response.status_code == 200
        validation.validate_api("ReadinessDTOEnvelope", payload)
        assert payload == {"data": {"ready": True}, "requestId": request_id}
    else:
        assert response.status_code == 500
        validation.validate_api("ErrorEnvelope", payload)
        assert payload == {
            "code": "READINESS_UNAVAILABLE",
            "message": "Readiness check failed",
            "details": {},
            "requestId": request_id,
        }


async def assert_live_aliases(context: ReadinessSite, markers: tuple[str, ...]) -> None:
    """依赖故障已经生效时两个存活入口仍返回各自的精确信封，避免只凭共同的状态码掩盖旧客户端回归。"""
    for path, schema, data in (
        ("/health/live", "HealthDTOEnvelope", {"status": "ok", "checks": {"process": True}}),
        ("/api/v1/health/live", "LivenessDTOEnvelope", {"alive": True}),
    ):
        response = await context["client"].get(path)
        payload = health_payload(response, context["config"], markers)
        assert response.status_code == 200
        validation.validate_api(schema, payload)
        assert payload == {"data": data, "requestId": response.headers["x-request-id"]}
