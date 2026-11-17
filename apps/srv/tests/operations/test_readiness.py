"""通过真实生产应用与专用 MySQL 检查五项就绪依赖，文件故障和迁移漂移必须降级而进程存活保持成功。

数据库沿用认证套件的专用库白名单和迁移流程，调用方必须持有共享 flock，不能与其它用库测试并发。
每个应用使用独立的小型安装包库存、临时 FILE 根和随机 HTTP 端口；不访问真实对象存储或模型服务。
普通故障在应用启动后、首次就绪请求前注入，每轮从空缓存独立探测。
缓存用例先取得健康结果，再移除 FILE 根并控制监视器时钟，验证两个别名在同一边界刷新。
响应只允许稳定契约字段，另检查配置中的数据库地址、口令、密钥及本地路径均没有出现在 HTTP 正文。
这些场景只证明有界就绪回归，不替代超时并发、备份恢复、密钥轮换或正式发行的验收。

database 与 mysqlVersion 分别代表连接可用和版本匹配，schema 还要求迁移头与安装单例同时存在。
这里保留三个独立字段，因此迁移行错误不能被误报成数据库连接故障。
static 检查的是启动时绑定的安装身份及字节；文件仍然存在并不意味着库存继续有效。
storage 检查的是 FILE 目录中的实际读写能力，不能用配置字符串存在代替成功探测。
参数化故障每轮只破坏一个依赖，完整布尔映射能发现故障归因错误或其它探针被提前短路。
新模块不会调用 fixture 的登录助手，所以匿名探针不会意外依赖已有认证会话。
旧认证回归继续单独验证 Secure Cookie 和安装后的真实数据库结构。
"健康"只用于已有有效库存的生产应用，开发模式跳过静态库存的路径不在这些用例中。
"""

from collections import abc
import contextlib
import hashlib
import json
import os
import pathlib
import runpy
import typing
from unittest import mock

import httpx
import pydantic
import pytest
import sqlalchemy
from tornado import escape, httpserver, netutil, web

from veriq_server import app, db, readiness, settings, validation
from veriq_server.handlers import static

# 复用唯一守卫夹具，避免另造清库算法或绕过专用库检查；新应用只借用该夹具已经迁移的数据库句柄。
site = runpy.run_path(str(pathlib.Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]


class _ReadinessSite(typing.TypedDict):
    """只保留当前生产应用及其实际依赖的句柄，让故障注入和恢复操作始终指向同一轮夹具的独占资源。"""

    client: httpx.AsyncClient
    application: web.Application
    config: settings.Settings
    artifacts: pathlib.Path
    static: pathlib.Path
    database: db.Database


@pytest.fixture(name="readiness_site")
async def _readiness_site(
    site: tuple[httpx.AsyncClient, db.Database],
    static_package: pathlib.Path,
    tmp_path: pathlib.Path,
) -> abc.AsyncIterator[_ReadinessSite]:
    """每轮启动真实生产 HTTP 应用并显式提供已有 FILE 根，沿用静态安装库存而不修改生产探针或返回结果。

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
    database = site[1]
    artifacts = tmp_path / "readiness-artifacts"
    artifacts.mkdir()
    config = settings.Settings(
        database_url=pydantic.SecretStr(database.engine.url.render_as_string(hide_password=False)),
        public_url="https://veriq.example.com",
        master_key=pydantic.SecretStr("a" * 64),
        signing_key=pydantic.SecretStr("b" * 64),
        artifact_directory=str(artifacts),
    )
    application = app.make_app(config, database)
    sockets = netutil.bind_sockets(0, "127.0.0.1")
    server = httpserver.HTTPServer(application)
    server.add_sockets(sockets)
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
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


def _health_payload(
    response: httpx.Response,
    config: settings.Settings,
    markers: tuple[str, ...] = (),
) -> dict[str, typing.Any]:
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
    surfaces = (response.text, *response.headers.values())
    if any(value and value in surface for value in private for surface in surfaces):
        pytest.fail("Health response exposed private configuration", pytrace=False)

    try:
        payload: object = response.json()
    except (ValueError, RecursionError):
        payload = None
    # 离开解码异常处理后再发出固定失败，避免原始 JSON 文档附着在异常上下文并随诊断一起输出。
    if not isinstance(payload, dict):
        pytest.fail("Health response did not contain a JSON object", pytrace=False)
    if any(value and value in surface for surface in _json_strings(payload) for value in private):
        pytest.fail("Health response exposed private configuration", pytrace=False)

    assert response.headers["content-type"].partition(";")[0] == "application/json"
    assert response.headers["cache-control"] == "no-store"
    request_id = response.headers["x-request-id"]
    assert request_id.strip()
    assert payload["requestId"] == request_id
    return payload


def _assert_public_response(
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
    payload = _health_payload(response, config, markers)
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


@pytest.mark.parametrize("location", ("top", "nested"))
def test_private_response_is_rejected_before_schema_diagnostics(location):
    """在顶层与嵌套额外字段放入合成口令，真实校验助手必须先给出固定失败消息，不能先输出含口令的模式诊断。

    这里直接构造真实 HTTP 响应对象，不启动服务，也不请求或清空数据库。
    两个位置都违反公开 DTO；这正是旧顺序会先进入 jsonschema 错误诊断的输入。
    顶层字段模拟额外的私有配置转储，嵌套字段模拟错误地附加到 data 的诊断信息。
    响应的其它字段保持正常，避免无关状态码、缓存头或必需字段缺失提前中断测试。
    Settings 完全使用此函数中的合成配置，禁止读取私有测试环境文件或复用真实数据库地址。
    合成密码同时出现在配置和响应中，能触发实际私有值比较，而不是模拟助手的返回结果。
    两种字段布局单独执行，避免第一个预期异常阻止第二种布局受到验证。
    pytest 必须捕获固定失败类型，普通模式错误或 JSON 比较失败不能被当作成功拦截。
    错误文本还需完全固定，防止追加原响应、私有字段名或底层校验异常。
    明确比较标记不在错误消息中，使以后修改诊断文本仍须保持这条不泄漏约束。
    本例只验证助手的异常消息，不声称任何服务日志、追踪或第三方错误输出已经脱敏。
    """
    marker = "synthetic-readiness-leak-marker"
    config = settings.Settings(
        database_url=f"mysql+asyncmy://synthetic:{marker}@127.0.0.1/veriq_test",
        public_url="https://veriq.example.com",
        master_key="a" * 64,
        signing_key="b" * 64,
        artifact_directory="/synthetic/readiness/artifacts",
    )
    checks = {
        "database": True,
        "mysqlVersion": True,
        "schema": True,
        "static": True,
        "storage": True,
    }
    payload = {"data": {"status": "ok", "checks": checks}, "requestId": "synthetic-request"}
    target = payload if location == "top" else payload["data"]
    target["privateConfig"] = marker
    response = httpx.Response(200, json=payload, headers={"cache-control": "no-store"})
    with pytest.raises(pytest.fail.Exception) as caught:
        _assert_public_response(response, config)
    assert str(caught.value) == "Health response exposed private configuration"
    assert marker not in str(caught.value)


def _synthetic_health_config(
    artifact_directory: str, password: str = "synthetic-unused-password"
) -> settings.Settings:
    """只使用函数内构造的合成连接参数和路径，确保测试失败诊断不会携带真实库凭据或者操作者配置。"""
    url = sqlalchemy.engine.URL.create(
        "mysql+asyncmy",
        username="synthetic",
        password=password,
        host="127.0.0.1",
        database="veriq_test",
    )
    return settings.Settings(
        database_url=pydantic.SecretStr(url.render_as_string(hide_password=False)),
        public_url="https://veriq.example.com",
        master_key=pydantic.SecretStr("a" * 64),
        signing_key=pydantic.SecretStr("b" * 64),
        artifact_directory=artifact_directory,
    )


@pytest.mark.parametrize(
    ("location", "marker"),
    (
        pytest.param("member", 'synthetic"quoted-password', id="quoted-top-value"),
        pytest.param("key", "/synthetic/path\\nested-key", id="backslash-nested-key"),
        pytest.param("item", "/synthetic/私有路径", id="unicode-list-value"),
        pytest.param("request-id", "/synthetic/请求标记", id="unicode-request-id"),
    ),
)
def test_json_escaped_private_response_is_rejected_before_diagnostics(
    location: str, marker: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """与生产响应使用同一序列化器构造转义值，确认字段名、数组成员与请求号都不会先进入诊断路径。"""
    config = _synthetic_health_config(marker)
    request_id = "synthetic-request"
    data: dict[str, object] = {
        "status": "ok",
        "checks": dict.fromkeys(("database", "mysqlVersion", "schema", "static", "storage"), True),
    }
    payload: dict[str, object] = {"data": data, "requestId": request_id}
    match location:
        case "member":
            config = _synthetic_health_config("/synthetic/readiness", password=marker)
            payload["privateConfig"] = marker
        case "key":
            data["extra"] = [{marker: True}]
        case "item":
            data["extra"] = [{"values": [marker]}]
        case "request-id":
            payload["requestId"] = marker
    raw = escape.json_encode(payload).encode("utf-8")
    response = httpx.Response(
        200,
        content=raw,
        headers={
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-request-id": request_id,
        },
    )
    assert marker not in response.text
    validate = mock.Mock(side_effect=AssertionError("Schema validation preceded the privacy guard"))
    monkeypatch.setattr(validation, "validate_api", validate)

    with pytest.raises(pytest.fail.Exception) as caught:
        _assert_public_response(response, config)
    assert str(caught.value) == "Health response exposed private configuration"
    assert marker not in str(caught.value)
    assert caught.value.__context__ is None
    assert response.content == raw
    validate.assert_not_called()


@pytest.mark.parametrize(
    "raw",
    (
        pytest.param(b'{"synthetic-parse-failure":', id="malformed"),
        pytest.param(b'["synthetic-non-object"]', id="non-object"),
    ),
)
def test_invalid_health_payload_has_fixed_diagnostic(
    raw: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """在不完整正文和非对象正文上核对相同固定诊断与空异常上下文，防止解码错误回显原响应实例。"""
    config = _synthetic_health_config("/synthetic/readiness")
    response = httpx.Response(
        200,
        content=raw,
        headers={
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-request-id": "synthetic-request",
        },
    )
    validate = mock.Mock(side_effect=AssertionError("Invalid JSON reached schema validation"))
    monkeypatch.setattr(validation, "validate_api", validate)

    with pytest.raises(pytest.fail.Exception) as caught:
        _assert_public_response(response, config)
    assert str(caught.value) == "Health response did not contain a JSON object"
    assert caught.value.__context__ is None
    assert response.content == raw
    validate.assert_not_called()


async def test_healthy_readiness_checks_real_dependencies_and_removes_probe(readiness_site):
    """真实 MySQL 版本、迁移头、Installation、安装库存和临时 FILE 根全部可用时，就绪接口返回精确成功信封。

    同时读取历史接口证明两个入口共享依赖结果；该步骤允许命中同一秒缓存，但不能省略任意检查字段。
    探针之后临时根仍为空，证明随机读写探针完成同步和删除，没有把诊断文件留作业务制品。

    空目录断言放在首次成功响应之后，能够观察 FILE 探针的真实副作用和收尾结果。
    目录由夹具独占，所以残留任何文件都属于本轮探测，不能被其它测试的制品误伤。
    历史接口保留 ready 布尔值，不应把新接口的详细 checks 混入旧客户端契约。
    此处不等待缓存失效；后续故障场景用全新应用，避免依赖两次请求之间的偶然耗时。
    未安装初始化管理员不妨碍就绪，但迁移已创建的 Installation 单例必须真实存在。
    FILE 探针成功意味着当前文件系统接受读写和同步调用，不能据此证明断电后的持久性。
    根目录为空也不能单独证明同步顺序；这里结合成功的真实探针响应检查完整正常路径。
    内核 I/O 卡住及 fsync 失败需要另设故障注入环境，不从本例的本地磁盘成功推断。
    """
    context = readiness_site
    response = await context["client"].get("/health/ready")
    _assert_public_response(response, context["config"])
    assert list(context["artifacts"].iterdir()) == []
    legacy = await context["client"].get("/api/v1/health/ready")
    assert legacy.status_code == 200
    assert legacy.json()["data"] == {"ready": True}


@pytest.mark.parametrize("failed", ("storage", "schema", "static"))
async def test_dependency_failure_degrades_ready_and_preserves_live(readiness_site, failed):
    """分别删除真实存储根、修改真实迁移头及损坏静态字节，逐项验证降级检查且存活和历史失败语义保持稳定。

    故障发生在首次 readiness 请求前，无需 sleep 或篡改监视器缓存；应用启动时已校验的静态身份保持原值。
    数据库故障只改专用库版本行，不迁移生产库；每轮复用夹具会重置隔离 schema，避免影响相邻场景。
    静态故障直接改实际文件而非 mock 读取结果，缺失 FILE 根同样经过真实文件系统失败路径。

    storage 分支只移除空的任务目录，不删除制品或其它测试的路径；失败时探针也不应自动修复目录。
    schema 分支提交不存在的版本标记，而数据库仍能正常 SELECT，故 database 与 mysqlVersion 必须为真。
    迁移行修改在独立事务中提交，监视器自己的连接才会读到真实漂移，不能仅依靠会话内未提交状态。
    static 分支保留文件和有效 HTML，故失败应来自原库存摘要不符，而非启动工厂已提前拒绝缺包。
    首个 live 请求先于 ready，有助于暴露把依赖探针错误搬到所有请求公共前置逻辑的回归。
    降级 ready 之后再读历史路由，两条路由必须对同一依赖故障给出各自约定的 HTTP 状态。
    legacy 的错误 code、message 和 details 都精确检查，不能把底层异常字符串当作历史错误正文。
    各场景未再次恢复依赖并探测，因此没有声称验证了缓存过期后的故障恢复速度。
    """
    context = readiness_site
    if failed == "storage":
        context["artifacts"].rmdir()
    elif failed == "schema":
        async with context["database"].engine.begin() as connection:
            await connection.execute(
                sqlalchemy.text(
                    "UPDATE veriq_alembic_version SET version_num='invalid-readiness-head'"
                )
            )
    else:
        (context["static"] / "index.html").write_text("<html>Changed after startup</html>")
    # 先读进程存活再读依赖状态，确认真实故障不会把公开 live 错误转为就绪失败或静态 HTML 回退页面。
    live = await context["client"].get("/health/live")
    assert live.status_code == 200
    assert live.json()["data"] == {"status": "ok", "checks": {"process": True}}
    response = await context["client"].get("/health/ready")
    _assert_public_response(response, context["config"], failed)
    legacy = await context["client"].get("/api/v1/health/ready")
    assert legacy.status_code == 500
    assert set(legacy.json()) == {"code", "message", "details", "requestId"}
    assert legacy.json()["code"] == "READINESS_UNAVAILABLE"
    assert legacy.json()["message"] == "Readiness check failed"
    assert legacy.json()["details"] == {}


async def _assert_legacy_ready(
    context: _ReadinessSite, ready: bool, markers: tuple[str, ...] = ()
) -> None:
    """历史就绪保留独立的成功与错误信封，先筛查注入标记和私有配置，再核对请求号关联及完整正文。"""
    response = await context["client"].get("/api/v1/health/ready")
    payload = _health_payload(response, context["config"], markers)
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


async def _assert_live_aliases(context: _ReadinessSite, markers: tuple[str, ...]) -> None:
    """依赖故障已经生效时两个存活入口仍返回各自的精确信封，避免只凭共同的状态码掩盖旧客户端回归。"""
    for path, schema, data in (
        ("/health/live", "HealthDTOEnvelope", {"status": "ok", "checks": {"process": True}}),
        ("/api/v1/health/live", "LivenessDTOEnvelope", {"alive": True}),
    ):
        response = await context["client"].get(path)
        payload = _health_payload(response, context["config"], markers)
        assert response.status_code == 200
        validation.validate_api(schema, payload)
        assert payload == {"data": data, "requestId": response.headers["x-request-id"]}


@contextlib.asynccontextmanager
async def _without_installation(database: db.Database) -> abc.AsyncIterator[None]:
    """提交删除安装单例以便独立探测连接读到缺失，并在断言失败时仍用新事务恢复夹具的原始行内容。"""
    installation = db.Installation
    async with database.engine.begin() as connection:
        original = (
            (
                await connection.execute(
                    sqlalchemy.select(
                        installation.id, installation.initialized, installation.setup_secret_hash
                    ).where(installation.id == 1)
                )
            )
            .mappings()
            .one()
        )
        removal = await connection.execute(
            sqlalchemy.delete(installation).where(installation.id == 1)
        )
    try:
        assert removal.rowcount == 1
        yield
    finally:
        async with database.engine.begin() as connection:
            await connection.execute(sqlalchemy.insert(installation).values(dict(original)))


@contextlib.contextmanager
def _wrong_mysql_version(database: db.Database, marker: str) -> abc.Iterator[None]:
    """只在专用引擎替换版本查询的结果来源，探测连接与迁移及安装查询仍交给真实数据库执行和提交。"""
    rewrites = 0

    def rewrite_version(*event_arguments: typing.Any) -> tuple[str, typing.Any]:
        """按 SQLAlchemy 游标事件的参数顺序读取语句和绑定参数，无关查询原样传递给同一个专用引擎。"""
        nonlocal rewrites
        statement = event_arguments[2]
        parameters = event_arguments[3]
        if statement == "SELECT VERSION()":
            rewrites += 1
            return f"SELECT '5.7.0-{marker}'", parameters
        return statement, parameters

    engine = database.engine.sync_engine
    sqlalchemy.event.listen(engine, "before_cursor_execute", rewrite_version, retval=True)
    try:
        yield
        assert rewrites == 1
    finally:
        sqlalchemy.event.remove(engine, "before_cursor_execute", rewrite_version)


def _replace_static_inventory(context: _ReadinessSite, marker: str) -> None:
    """保留发布路径与构建版本，仅替换图外公开文件并同步库存摘要，使实际加载器承认新库存且身份确实变更。"""
    root = context["static"]
    asset = root / "favicon.svg"
    inventory_path = root / "static-manifest.json"
    info_path = root / "build-info.json"
    replacement = f'<svg xmlns="http://www.w3.org/2000/svg"><desc>{marker}</desc></svg>'.encode()
    asset.write_bytes(replacement)
    inventory = json.loads(inventory_path.read_bytes())
    entry = next(item for item in inventory["files"] if item["path"] == asset.name)
    entry["sizeBytes"] = len(replacement)
    entry["sha256"] = hashlib.sha256(replacement).hexdigest()
    inventory_bytes = json.dumps(inventory).encode()
    inventory_path.write_bytes(inventory_bytes)
    info = json.loads(info_path.read_bytes())
    info["staticManifestHash"] = hashlib.sha256(inventory_bytes).hexdigest()
    info_path.write_text(json.dumps(info), encoding="utf-8")

    admitted = context["application"].settings["published_site"]
    current = static.load_published_site(context["config"])
    assert admitted is not None and current is not None
    assert current.public_files == admitted.public_files
    assert current.build_info["staticManifestHash"] != admitted.build_info["staticManifestHash"]


@contextlib.contextmanager
def _linked_file_root(artifacts: pathlib.Path) -> abc.Iterator[pathlib.Path]:
    """只重定向夹具拥有的空根目录；探测后保留链接并检查目标未留下任何写入，以验证拒绝跟随的边界。"""
    target = artifacts.with_name("readiness-linked-target")
    target.mkdir()
    artifacts.rmdir()
    artifacts.symlink_to(target, target_is_directory=True)
    yield target
    assert artifacts.is_symlink()
    assert artifacts.readlink() == target
    assert not any(target.iterdir())


@contextlib.contextmanager
def _refuse_probe_creation(
    artifacts: pathlib.Path, monkeypatch: pytest.MonkeyPatch, marker: str
) -> abc.Iterator[None]:
    """只在目录描述符确实属于当前 FILE 根时拒绝创建探针，沿途目录打开与其它文件操作继续调用真实系统边界。"""
    original_open = os.open
    expected = artifacts.stat()
    refusals = 0

    def refuse_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        """同时核对创建标志、探针名前缀与已打开目录的设备及索引号，避免将合成权限故障传播到其它路径。"""
        nonlocal refusals
        if flags & os.O_CREAT and isinstance(path, str) and path.startswith(".veriq-readiness-"):
            if dir_fd is not None and os.path.samestat(os.fstat(dir_fd), expected):
                refusals += 1
                raise PermissionError(marker)
        return original_open(path, flags, mode, dir_fd=dir_fd)

    with monkeypatch.context() as patch:
        patch.setattr("veriq_server.readiness.os.open", refuse_open)
        yield
    assert refusals == 1
    assert not any(artifacts.iterdir())


@pytest.mark.parametrize(
    ("fault", "failed", "marker"),
    (
        pytest.param("installation", "schema", "", id="missing-installation"),
        pytest.param(
            "version", "mysqlVersion", "synthetic-readiness-version-marker", id="wrong-version"
        ),
        pytest.param("manifest", "static", "synthetic-readiness-invalid-manifest", id="manifest"),
        pytest.param(
            "replacement", "static", "synthetic-readiness-static-replacement", id="replacement"
        ),
        pytest.param("symlink", "storage", "readiness-linked-target", id="linked-file-root"),
        pytest.param(
            "open", "storage", "synthetic-readiness-file-open-refusal", id="readonly-file-open"
        ),
    ),
)
async def test_readiness_new_dependency_fault(
    readiness_site: _ReadinessSite,
    monkeypatch: pytest.MonkeyPatch,
    fault: str,
    failed: str,
    marker: str,
) -> None:
    """在成功启动之后逐项破坏一个依赖，公开就绪必须精确归因，历史就绪保持错误信封且两个存活入口保持成功。"""
    context = readiness_site
    markers: tuple[str, ...] = (marker,) if marker else ()
    async with contextlib.AsyncExitStack() as cleanup:
        match fault:
            case "installation":
                await cleanup.enter_async_context(_without_installation(context["database"]))
            case "version":
                cleanup.enter_context(_wrong_mysql_version(context["database"], marker))
            case "manifest":
                (context["static"] / "static-manifest.json").write_text(marker, encoding="utf-8")
            case "replacement":
                _replace_static_inventory(context, marker)
            case "symlink":
                target = cleanup.enter_context(_linked_file_root(context["artifacts"]))
                markers += (str(target),)
            case "open":
                cleanup.enter_context(
                    _refuse_probe_creation(context["artifacts"], monkeypatch, marker)
                )
            case _:
                pytest.fail("Unknown readiness dependency fault")
        await _assert_live_aliases(context, markers)
        response = await context["client"].get("/health/ready")
        _assert_public_response(response, context["config"], failed, markers)
        await _assert_legacy_ready(context, ready=False, markers=markers)


async def test_readiness_cache_expires_at_one_second(
    readiness_site: _ReadinessSite, monkeypatch: pytest.MonkeyPatch
) -> None:
    """用公开入口建立成功缓存后以历史入口读到同一结果，并在精确一秒时观察 FILE 故障和下一轮恢复。"""
    context = readiness_site
    started = 32.0
    now = started
    monkeypatch.setattr(readiness, "monotonic", lambda: now)
    response = await context["client"].get("/health/ready")
    _assert_public_response(response, context["config"])

    artifacts = context["artifacts"]
    artifacts.rmdir()
    try:
        # 历史入口首次请求发生在根目录移除之后，因此成功只能来自共享缓存而非历史入口单独启动的健康探测。
        now = started + 0.999
        await _assert_legacy_ready(context, ready=True)
        response = await context["client"].get("/health/ready")
        _assert_public_response(response, context["config"])

        now = started + 1.0
        response = await context["client"].get("/health/ready")
        _assert_public_response(response, context["config"], "storage")
        await _assert_legacy_ready(context, ready=False)
    finally:
        artifacts.mkdir()

    now = started + 2.0
    await _assert_legacy_ready(context, ready=True)
    response = await context["client"].get("/health/ready")
    _assert_public_response(response, context["config"])
    assert not any(artifacts.iterdir())


async def test_liveness_never_calls_dependency_monitor(readiness_site, monkeypatch):
    """给依赖监视器装入必定失败的调用边界后读取两条存活路由，证明存活处理器不会委派任何依赖探测工作。

    应用和路由仍来自真实生产工厂，数据库与文件夹具保持真实；替换点只用于发现不应发生的跨边界调用。
    此测试不替代上述实际故障探测，而是防止未来重构把 live 与 ready 合并后悄悄引入数据库或存储访问。

    只替换该应用实例的 check 方法，其它应用和类定义均保持原样，monkeypatch 在本轮结束后自动还原。
    两个存活入口使用不同 DTO，因此分别比较其公开字段，不能只凭共同的 200 状态判断兼容。
    探针替身没有返回值；一旦调用，固定失败立即使路由请求暴露问题，不能偶然模拟为健康结果。
    真实依赖已由前面的场景检查，此处不通过断网或修改全局驱动制造与路由无关的噪音。
    """
    monkeypatch.setattr(
        readiness_site["application"].settings["readiness_monitor"], "check", _unexpected_probe
    )
    for path, data in (
        ("/health/live", {"status": "ok", "checks": {"process": True}}),
        ("/api/v1/health/live", {"alive": True}),
    ):
        response = await readiness_site["client"].get(path)
        assert response.status_code == 200
        assert response.json()["data"] == data


async def _unexpected_probe():
    """任何存活请求触及此边界都立刻使测试失败，固定英文消息不会带入真实数据库地址或文件系统路径。"""
    pytest.fail("Liveness called the dependency monitor")
