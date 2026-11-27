"""通过真实生产应用与专用 MySQL 检查五项就绪依赖，文件故障和迁移漂移必须降级而进程存活保持成功。

数据库沿用认证套件的专用库白名单和迁移流程，调用方必须持有共享 flock，不能与其它用库测试并发。
每个应用使用独立的小型安装包库存、临时 FILE 根和随机 HTTP 端口；不访问真实对象存储或模型服务。
普通故障在应用启动后、首次就绪请求前注入，每轮从空缓存独立探测。
缓存用例先取得健康结果，再移除 FILE 根并控制监视器时钟，验证两个别名在同一边界刷新。
响应只允许稳定契约字段，另检查配置中的数据库地址、口令、密钥及本地路径均没有出现在 HTTP 正文。
调度用例在真实应用中控制探针入口并测量等待预算；备份恢复、密钥轮换及正式发行仍需另行验收。

database 与 mysqlVersion 分别代表连接可用和版本匹配，schema 还要求迁移头与安装单例同时存在。
这里保留三个独立字段，因此迁移行错误不能被误报成数据库连接故障。
static 检查的是启动时绑定的安装身份及字节；文件仍然存在并不意味着库存继续有效。
storage 检查的是 FILE 目录中的实际读写能力，不能用配置字符串存在代替成功探测。
参数化故障每轮只破坏一个依赖，完整布尔映射能发现故障归因错误或其它探针被提前短路。
新模块不会调用 fixture 的登录助手，所以匿名探针不会意外依赖已有认证会话。
旧认证回归继续单独验证 Secure Cookie 和安装后的真实数据库结构。
"健康"只用于已有有效库存的生产应用，开发模式跳过静态库存的路径不在这些用例中。
"""

import asyncio
from collections import abc
import contextlib
import dataclasses
import hashlib
import json
import logging
import os
import pathlib
import threading
import time
import typing
from unittest import mock

import httpx
import pydantic
import pytest
import sqlalchemy
from sqlalchemy.ext import asyncio as sqlalchemy_asyncio
from tornado import escape, httputil

from veriq_server import db, readiness, settings, validation
from veriq_server.handlers import static

from apps.srv.tests.operations import readiness_support

# 显式绑定两项公共夹具，让 pytest 在本模块发现同一守卫和启动器并正常解析它们的依赖关系。
create_readiness_server = readiness_support.create_readiness_server
site = readiness_support.site_fixture


@pytest.fixture(name="readiness_site")
async def _readiness_site(
    readiness_server: readiness_support.ReadinessServer,
) -> abc.AsyncIterator[readiness_support.ReadinessSite]:
    """保留原就绪用例的夹具入口，进入共享应用上下文时使用默认 FILE 策略并由原认证夹具归还数据库。"""
    async with readiness_server({}) as context:
        yield context


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
        readiness_support.assert_public_response(response, config)
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
        readiness_support.assert_public_response(response, config)
    assert str(caught.value) == "Health response exposed private configuration"
    assert marker not in str(caught.value)
    assert caught.value.__context__ is None
    assert response.content == raw
    validate.assert_not_called()


@pytest.mark.parametrize(
    ("name", "tornado_headers", "expected_name", "reject"),
    (
        pytest.param(
            "FAKE-V02-READINESS-ACCESS", False, "FAKE-V02-READINESS-ACCESS", True, id="uppercase"
        ),
        pytest.param(
            "fake-v02-readiness-access", True, "Fake-V02-Readiness-Access", True, id="tornado-title"
        ),
        pytest.param("X-Readiness-Extra", True, "X-Readiness-Extra", False, id="ordinary-header"),
    ),
)
def test_health_header_names_reject_private_markers_before_decoding(
    name: str, tornado_headers: bool, expected_name: str, reject: bool
) -> None:
    """用真实头容器产生原始大写和标题式头名，验证其大小写规范化只用于隐私判定且不影响普通附加头。"""
    marker = "FAKE-V02-READINESS-ACCESS"
    config = _synthetic_health_config("/synthetic/readiness/artifacts")
    headers = {
        name: marker.lower(),
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-request-id": "synthetic-request",
    }
    if tornado_headers:
        headers = dict(httputil.HTTPHeaders(headers).get_all())
    raw = escape.json_encode(
        {
            "data": {
                "status": "ok",
                "checks": dict.fromkeys(
                    ("database", "mysqlVersion", "schema", "static", "storage"), True
                ),
            },
            "requestId": "synthetic-request",
        },
    ).encode("utf-8")
    response = httpx.Response(200, content=raw, headers=headers)
    original_headers = response.headers.raw
    assert (expected_name.encode("ascii"), marker.lower().encode("ascii")) in original_headers
    assert expected_name.lower() in tuple(response.headers)
    if reject:
        with mock.patch.object(response, "json", wraps=response.json) as parse:
            with pytest.raises(pytest.fail.Exception) as caught:
                readiness_support.assert_public_response(response, config, markers=(marker,))
            parse.assert_not_called()
        assert str(caught.value) == "Health response exposed private configuration"
        assert marker.lower() not in str(caught.value).lower()
        assert caught.value.__context__ is None
    else:
        readiness_support.assert_public_response(response, config, markers=(marker,))
    assert response.content == raw
    assert response.headers.raw == original_headers


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
        readiness_support.assert_public_response(response, config)
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
    readiness_support.assert_public_response(response, context["config"])
    assert not any(context["artifacts"].iterdir())
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
    readiness_support.assert_public_response(response, context["config"], failed)
    legacy = await context["client"].get("/api/v1/health/ready")
    assert legacy.status_code == 500
    assert set(legacy.json()) == {"code", "message", "details", "requestId"}
    assert legacy.json()["code"] == "READINESS_UNAVAILABLE"
    assert legacy.json()["message"] == "Readiness check failed"
    assert legacy.json()["details"] == {}


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


def _replace_static_inventory(context: readiness_support.ReadinessSite, marker: str) -> None:
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
    readiness_site: readiness_support.ReadinessSite,
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
        await readiness_support.assert_live_aliases(context, markers)
        response = await context["client"].get("/health/ready")
        readiness_support.assert_public_response(response, context["config"], failed, markers)
        await readiness_support.assert_legacy_ready(context, ready=False, markers=markers)


async def test_readiness_cache_expires_at_one_second(
    readiness_site: readiness_support.ReadinessSite, monkeypatch: pytest.MonkeyPatch
) -> None:
    """用公开入口建立成功缓存后以历史入口读到同一结果，并在精确一秒时观察 FILE 故障和下一轮恢复。"""
    context = readiness_site
    started = 32.0
    now = started
    monkeypatch.setattr(readiness, "monotonic", lambda: now)
    response = await context["client"].get("/health/ready")
    readiness_support.assert_public_response(response, context["config"])

    artifacts = context["artifacts"]
    artifacts.rmdir()
    try:
        # 历史入口首次请求发生在根目录移除之后，因此成功只能来自共享缓存而非历史入口单独启动的健康探测。
        now = started + 0.999
        await readiness_support.assert_legacy_ready(context, ready=True)
        response = await context["client"].get("/health/ready")
        readiness_support.assert_public_response(response, context["config"])

        now = started + 1.0
        response = await context["client"].get("/health/ready")
        readiness_support.assert_public_response(response, context["config"], "storage")
        await readiness_support.assert_legacy_ready(context, ready=False)
    finally:
        artifacts.mkdir()

    now = started + 2.0
    await readiness_support.assert_legacy_ready(context, ready=True)
    response = await context["client"].get("/health/ready")
    readiness_support.assert_public_response(response, context["config"])
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


_SCHEDULING_WATCHDOG = 10.0
_GATE_CEILING = 30.0
_DATABASE_CHECKS = ("database", "mysqlVersion", "schema")
_READINESS_CHECKS = (*_DATABASE_CHECKS, "static", "storage")
_LOGGER = logging.getLogger(__name__)


@dataclasses.dataclass
class _GatedDatabaseProbe:
    """记录真正进入数据库探针的监视器任务，等待测试主动释放后再查真实库，供取消和外层截止测试复用。"""

    entered: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    release: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    workers: list[asyncio.Task[dict[str, bool]]] = dataclasses.field(default_factory=list)

    def install(self, monitor: readiness.ReadinessMonitor, patch: pytest.MonkeyPatch) -> None:
        """只在当前应用的数据库边界控制开始时序，释放后仍由原探针执行版本、迁移头与安装单例的查询。"""
        method = "_database"
        original: abc.Callable[[], abc.Awaitable[dict[str, bool]]] = getattr(monitor, method)

        async def probe() -> dict[str, bool]:
            """把监视器启动的任务交给测试观察，等待上限只防止异常挂起，正常路径由测试明确释放事件。"""
            worker = asyncio.current_task()
            assert worker is not None
            self.workers.append(worker)
            self.entered.set()
            async with asyncio.timeout(_GATE_CEILING):
                await self.release.wait()
            return await original()

        patch.setattr(monitor, method, probe)


@dataclasses.dataclass
class _GatedFileProbe:
    """用线程事件阻塞真实存储探针的入口，通过循环事件分别报告工作线程的开始与退出并记录实际返回值。"""

    release: threading.Event = dataclasses.field(default_factory=threading.Event)
    returned: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    calls: int = 0
    results: list[bool] = dataclasses.field(default_factory=list)

    def install(self, monitor: readiness.ReadinessMonitor, patch: pytest.MonkeyPatch) -> None:
        """保留监视器创建线程及等待结果的逻辑，线程获得测试发出的释放信号后仍执行真实文件读写和清理。"""
        method = "_storage"
        original: abc.Callable[[], bool] = getattr(monitor, method)
        loop = asyncio.get_running_loop()

        def enter() -> None:
            """跨线程通知交给事件循环计数，实际工作线程每次到达探针边界时均登记，供响应和关闭阶段核对。"""
            self.calls += 1

        def probe() -> bool:
            """线程等待达到安全上限将直接失败，只有测试发出释放信号才执行真实探针并记录它的返回值。"""
            loop.call_soon_threadsafe(enter)
            try:
                if not self.release.wait(_GATE_CEILING):
                    raise AssertionError("FILE worker reached its test safety ceiling")
                result = original()
                self.results.append(result)
                return result
            finally:
                loop.call_soon_threadsafe(self.returned.set)

        patch.setattr(monitor, method, probe)


@dataclasses.dataclass
class _GatedQueryProbe:
    """只推迟指定引擎连接上的首条连通性语句，记录取消是否到达真正的数据库任务与借出的连接上下文。"""

    release: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    cancelled: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    calls: list[tuple[sqlalchemy_asyncio.AsyncConnection, asyncio.Task[dict[str, bool]]]] = (
        dataclasses.field(default_factory=list)
    )

    def install(self, engine: sqlalchemy_asyncio.AsyncEngine, patch: pytest.MonkeyPatch) -> None:
        """正常借出和归还数据库连接，只在该引擎的精确连通性语句处等待，其他执行全部根据原参数转发。"""
        original = sqlalchemy_asyncio.AsyncConnection.execute

        async def execute(
            connection: sqlalchemy_asyncio.AsyncConnection,
            statement: sqlalchemy.sql.Executable,
            parameters: (
                abc.Mapping[str, object] | abc.Sequence[abc.Mapping[str, object]] | None
            ) = None,
            *,
            execution_options: abc.Mapping[str, object] | None = None,
        ) -> sqlalchemy.CursorResult[tuple[object, ...]]:
            """测试只观察生产超时传来的取消，然后原样抛出，让数据库探针自行完成超时转换与连接回收。"""
            if (
                connection.engine is engine
                and isinstance(statement, sqlalchemy.sql.elements.TextClause)
                and statement.text == "SELECT 1"
            ):
                worker = asyncio.current_task()
                assert worker is not None
                self.calls.append((connection, worker))
                try:
                    await self.release.wait()
                except asyncio.CancelledError:
                    self.cancelled.set()
                    raise
            return await original(
                connection, statement, parameters, execution_options=execution_options
            )

        patch.setattr(sqlalchemy_asyncio.AsyncConnection, "execute", execute)


def _observe_static_probe(
    monitor: readiness.ReadinessMonitor, patch: pytest.MonkeyPatch
) -> mock.Mock:
    """记录真实静态探针的入口以区分缓存命中和新一轮检查，检查仍重新读取同一份启动时已验证的静态库存。"""
    method = "_static"
    observer = mock.Mock(wraps=getattr(monitor, method))
    patch.setattr(monitor, method, observer)
    return observer


def _assert_scheduling_degraded(
    response: httpx.Response, config: settings.Settings, failed: tuple[str, ...]
) -> None:
    """任何多项降级都先经过共享隐私筛查，再核对全部五项布尔值与公开信封，避免其他依赖的意外失败。"""
    payload = readiness_support.health_payload(response, config)
    assert response.status_code == 503
    validation.validate_api("HealthDTOEnvelope", payload)
    checks = {name: name not in failed for name in _READINESS_CHECKS}
    assert payload == {
        "data": {"status": "degraded", "checks": checks},
        "requestId": response.headers["x-request-id"],
    }


async def _request_at_deadline(
    client: httpx.AsyncClient, label: str, seconds: int
) -> httpx.Response:
    """独立单调时钟计时，留零点八秒调度余量，使两秒文件预算早于三秒外层兜底，十秒仅用于请求看门狗。"""
    started = time.monotonic()
    response = await client.get("/health/ready", timeout=_SCHEDULING_WATCHDOG)
    elapsed = time.monotonic() - started
    _LOGGER.info("Readiness %s deadline elapsed: %.3fs", label, elapsed)
    assert seconds - 0.1 <= elapsed < seconds + 0.8
    return response


async def test_readiness_concurrent_waiters_share_probe(
    readiness_site: readiness_support.ReadinessSite, monkeypatch: pytest.MonkeyPatch
) -> None:
    """两条真实就绪请求在同一探针等待期间均可读存活接口，明确取消第三个直接调用后，两条请求仍成功。"""
    monitor = readiness_site["application"].settings["readiness_monitor"]
    assert isinstance(monitor, readiness.ReadinessMonitor)
    probe = _GatedDatabaseProbe()
    probe.install(monitor, monkeypatch)
    static_probe = _observe_static_probe(monitor, monkeypatch)
    original_check = monitor.check
    aliases_entered = asyncio.Event()
    direct_entered = asyncio.Event()
    alias_calls = 0

    async def observe_alias() -> dict[str, bool]:
        """通知第二条请求已抵达后直接执行原检查，在让出循环前两条就绪路径均已进入实际的共享等待。"""
        nonlocal alias_calls
        alias_calls += 1
        if alias_calls == 2:
            aliases_entered.set()
        return await original_check()

    async def direct_check() -> dict[str, bool]:
        """从测试协程直接进入实际监视器，通知后运行到真实等待点才让出控制权，避免推断断开引发取消。"""
        direct_entered.set()
        return await original_check()

    monkeypatch.setattr(monitor, "check", observe_alias)
    async with asyncio.timeout(_SCHEDULING_WATCHDOG), asyncio.TaskGroup() as group:
        public = group.create_task(readiness_site["client"].get("/health/ready"))
        legacy = group.create_task(
            readiness_support.assert_legacy_ready(readiness_site, ready=True)
        )
        try:
            await aliases_entered.wait()
            await probe.entered.wait()
            await readiness_support.assert_live_aliases(readiness_site, ())
            assert not public.done() and not legacy.done()
            waiter = group.create_task(direct_check())
            await direct_entered.wait()
            assert not waiter.done()
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            assert len(probe.workers) == 1 and not probe.workers[0].done()
        finally:
            probe.release.set()
    readiness_support.assert_public_response(public.result(), readiness_site["config"])
    assert alias_calls == 2 and len(probe.workers) == 1
    static_probe.assert_called_once_with()


async def test_readiness_blocking_timeout_keeps_one_worker(
    readiness_site: readiness_support.ReadinessSite, monkeypatch: pytest.MonkeyPatch
) -> None:
    """线程跨过真实两秒后仍由监视器持有，过期检查不得再次启动存储线程，关闭要等受控释放后才完成。"""
    monitor = readiness_site["application"].settings["readiness_monitor"]
    assert isinstance(monitor, readiness.ReadinessMonitor)
    probe = _GatedFileProbe()
    probe.install(monitor, monkeypatch)
    static_probe = _observe_static_probe(monitor, monkeypatch)
    now = 32.0
    monkeypatch.setattr(readiness, "monotonic", lambda: now)
    closing: asyncio.Task[None] | None = None
    close_entered = asyncio.Event()

    async def observe_close() -> None:
        """先发出启动信号再执行原关闭方法，事件恢复时关闭任务已执行到真实等待点或已经过早结束。"""
        close_entered.set()
        await monitor.close()

    try:
        async with asyncio.timeout(_SCHEDULING_WATCHDOG):
            response = await _request_at_deadline(readiness_site["client"], "FILE", 2)
            readiness_support.assert_public_response(response, readiness_site["config"], "storage")
            assert probe.calls == 1 and not probe.returned.is_set()

            now += 1.0
            response = await readiness_site["client"].get("/health/ready")
            readiness_support.assert_public_response(response, readiness_site["config"], "storage")
            assert static_probe.call_count == 2
            assert probe.calls == 1 and not probe.returned.is_set()

            closing = asyncio.create_task(observe_close())
            await close_entered.wait()
            assert not closing.done() and not probe.returned.is_set()
    finally:
        probe.release.set()
        try:
            if closing is not None:
                await closing
                assert probe.returned.is_set()
        finally:
            if probe.calls:
                await asyncio.wait_for(probe.returned.wait(), _SCHEDULING_WATCHDOG)

    assert probe.calls == 1 and probe.results == [True]
    assert not any(readiness_site["artifacts"].iterdir())
    response = await readiness_site["client"].get("/health/ready")
    _assert_scheduling_degraded(response, readiness_site["config"], _READINESS_CHECKS)


async def test_readiness_response_deadline_keeps_one_database_worker(
    readiness_site: readiness_support.ReadinessSite, monkeypatch: pytest.MonkeyPatch
) -> None:
    """数据库协程晚于外层三秒完成时保留唯一工作者，晚到成功不会改写降级缓存，过期后真实查询可恢复。"""
    monitor = readiness_site["application"].settings["readiness_monitor"]
    assert isinstance(monitor, readiness.ReadinessMonitor)
    probe = _GatedDatabaseProbe()
    probe.install(monitor, monkeypatch)
    static_probe = _observe_static_probe(monitor, monkeypatch)
    now = 32.0
    monkeypatch.setattr(readiness, "monotonic", lambda: now)

    async with asyncio.timeout(_SCHEDULING_WATCHDOG):
        try:
            response = await _request_at_deadline(readiness_site["client"], "outer database", 3)
            _assert_scheduling_degraded(response, readiness_site["config"], _DATABASE_CHECKS)
            assert len(probe.workers) == 1 and not probe.workers[0].done()
            worker = probe.workers[0]
            await readiness_support.assert_legacy_ready(readiness_site, ready=False)
            static_probe.assert_called_once_with()

            now += 1.0
            response = await readiness_site["client"].get("/health/ready")
            _assert_scheduling_degraded(response, readiness_site["config"], _DATABASE_CHECKS)
            assert static_probe.call_count == 2
            assert probe.workers == [worker] and not worker.done()
        finally:
            probe.release.set()

        assert await asyncio.shield(worker) == dict.fromkeys(_DATABASE_CHECKS, True)
        response = await readiness_site["client"].get("/health/ready")
        _assert_scheduling_degraded(response, readiness_site["config"], _DATABASE_CHECKS)
        assert static_probe.call_count == 2 and probe.workers == [worker]

        now += 1.0
        response = await readiness_site["client"].get("/health/ready")
        readiness_support.assert_public_response(response, readiness_site["config"])
        assert static_probe.call_count == 3 and len(probe.workers) == 2
        assert probe.workers[1] is not worker and probe.workers[1].done()


async def test_readiness_database_query_deadline(
    readiness_site: readiness_support.ReadinessSite, monkeypatch: pytest.MonkeyPatch
) -> None:
    """实际一秒数据库预算取消挂起的查询入口并归还连接，恢复原执行方法后下一次过期探测重新验证数据库。"""
    engine = readiness_site["database"].engine
    pool = engine.pool
    assert isinstance(pool, sqlalchemy.pool.AsyncAdaptedQueuePool)
    probe = _GatedQueryProbe()
    now = 32.0
    monkeypatch.setattr(readiness, "monotonic", lambda: now)

    with monkeypatch.context() as patch:
        probe.install(engine, patch)
        try:
            response = await _request_at_deadline(readiness_site["client"], "database query", 1)
            _assert_scheduling_degraded(response, readiness_site["config"], _DATABASE_CHECKS)
            assert probe.cancelled.is_set() and len(probe.calls) == 1
            connection, worker = probe.calls[0]
            assert worker.done() and not worker.cancelled()
            assert connection.closed and pool.checkedout() == 0
        finally:
            probe.release.set()

    now += 1.0
    response = await readiness_site["client"].get("/health/ready")
    readiness_support.assert_public_response(response, readiness_site["config"])
    assert pool.checkedout() == 0 and not any(readiness_site["artifacts"].iterdir())
