"""通过真实生产应用与专用 MySQL 检查五项就绪依赖，文件故障和迁移漂移必须降级而进程存活保持成功。

数据库沿用认证套件的专用库白名单和迁移流程，调用方必须持有共享 flock，不能与其它用库测试并发。
每个应用使用独立的小型安装包库存、临时 FILE 根和随机 HTTP 端口；不访问真实对象存储或模型服务。
故障在应用启动后、首次 readiness 请求前注入，因此不会命中先前成功结果的一秒缓存。
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

import pathlib
import runpy

import httpx
import pytest
import sqlalchemy
from tornado import httpserver, netutil

from veriq_server import app, settings, validation


# 复用唯一守卫夹具，避免另造清库算法或绕过专用库检查；新应用只借用该夹具已经迁移的数据库句柄。
site = runpy.run_path(str(pathlib.Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]


@pytest.fixture
async def readiness_site(site, static_package, tmp_path):
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
        database_url=database.engine.url.render_as_string(hide_password=False),
        public_url="https://veriq.example.com",
        master_key="a" * 64,
        signing_key="b" * 64,
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


def _assert_public_response(response, config, failed=None):
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
    私有值筛查先于 JSON 解析、模式验证及所有响应断言，因为这些失败诊断可能包含完整原始输入。
    字段布局未知或同时违反多个规则时，也必须优先给出固定消息，不能让模式错误抢先公开额外字段。
    """
    private = (
        config.database_url.get_secret_value(),
        sqlalchemy.engine.make_url(config.database_url.get_secret_value()).password,
        config.master_key.get_secret_value(),
        config.signing_key.get_secret_value(),
        config.artifact_directory,
    )
    if any(value and value in response.text for value in private):
        pytest.fail("Health response exposed private configuration")
    checks = dict.fromkeys(("database", "mysqlVersion", "schema", "static", "storage"), True)
    if failed:
        checks[failed] = False
    assert response.status_code == (503 if failed else 200)
    validation.validate_api("HealthDTOEnvelope", response.json())
    assert set(response.json()) == {"data", "requestId"}
    assert response.json()["data"] == {
        "status": "degraded" if failed else "ok",
        "checks": checks,
    }
    assert response.headers["cache-control"] == "no-store"


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
    checks = {"database": True, "mysqlVersion": True, "schema": True, "static": True, "storage": True}
    payload = {"data": {"status": "ok", "checks": checks}, "requestId": "synthetic-request"}
    target = payload if location == "top" else payload["data"]
    target["privateConfig"] = marker
    response = httpx.Response(200, json=payload, headers={"cache-control": "no-store"})
    with pytest.raises(pytest.fail.Exception) as caught:
        _assert_public_response(response, config)
    assert str(caught.value) == "Health response exposed private configuration"
    assert marker not in str(caught.value)


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
                sqlalchemy.text("UPDATE veriq_alembic_version SET version_num='invalid-readiness-head'")
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
    """任何存活请求触及此边界都立刻使测试失败，固定英文消息不会带入真实数据库地址或文件系统路径。
    """
    pytest.fail("Liveness called the dependency monitor")
