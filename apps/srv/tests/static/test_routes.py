"""通过实际应用工厂与真实 HTTP 请求验证发布目录服务，不建立替代路由或文件服务器；测试将已登记前端刷新、静态缓存及错误边界与缺包启动行为分开观察。

所有文件响应都经过实际 HTTP，避免只比较路由表文本。
生产配置保持 HTTPS 公网源，局部客户端仅替代外部 TLS 终结。
正常包与损坏包分开测试，避免仅靠异常处理获得虚假的通过。
路径攻击保持编码形式，静态缓存使用真实 ETag。
完整库存覆盖图外公开资源，Vite 模块图仍需检查引用闭包。
测试不连接生产或隔离 MySQL，生产鉴权另由 auth 套件验证。
真实前端浏览器集成读取构建产物，文件单测只使用小型测试资源。
HEAD 错误必须与 GET 保持真实 404，不因兜底动词缺失变成 405。
公开健康别名同时核对存活与数据库降级，避免错误接口回退到页面。
此模块不实现发布 writer，也不声称验证了正式 wheel。
"""

import hashlib
import json

import httpx
import pytest
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets

from veriq_server.app import make_app
from veriq_server.db import Database
from veriq_server.settings import Settings
from veriq_server.validation import validate_api


@pytest.fixture
def production_settings():
    """路由检查仅创建未连接的数据库句柄并使用生产 HTTPS 公网源，避免用开发模式掩盖缺包检查或 Secure Cookie 差异；需要鉴权的集成另由现有真实 MySQL 测试承担。

    数据库地址只满足 Settings 的驱动校验。
    这些测试没有迁移、用户或真实 SQL 查询。
    因此错误数据库连接不能偶然影响文件路由断言。
    public_url 保留正式 HTTPS 约束。
    两个合成密钥只用于初始化现有签名配置。
    没有读取私有 test-env 或外部 Provider。
    需要身份状态的场景留给 auth 目录的真实库 fixture。
    文件测试仍使用生产模式，不能省略缺包校验。
    """
    return Settings(
        database_url="mysql+asyncmy://unused:unused@127.0.0.1/unused",
        public_url="https://veriq.example.com",
        master_key="a" * 64,
        signing_key="b" * 64,
    )


@pytest.fixture
async def published(static_package, production_settings):
    """启动真实 Tornado 应用监听随机端口并确保连接与数据库池关闭，HTTP 客户端只替代外部 TLS 终结层；清单与静态文件仍从模拟安装包资源目录读取。

    临时文件由 static_package 生成，接口仍由 make_app 注册。
    监听端口由系统分配，避免和开发代理或其它测试争抢固定端口。
    Database 对象只提供现有处理器初始化需要的依赖。
    测试请求不需要为匿名静态文件伪造用户。
    HTTP 客户端在 yield 范围内共享连接池。
    退出时先停止监听，再关闭尚存连接。
    最后释放数据库句柄，避免跨事件循环留存连接池。
    这里不模拟 StaticFileHandler、路由或请求结果。
    """
    db = Database(production_settings)
    app = make_app(production_settings, db)
    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(app)
    server.add_sockets(sockets)
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
        ) as client:
            yield client, app
    finally:
        server.stop()
        await server.close_all_connections()
        await db.close()


@pytest.mark.parametrize(
    "path",
    (
        "/ /login /setup /reset /reset/confirm /account /admin/users /workspaces "
        "/runtimes /resources /environments /ai /bundles /reports /execution-plans /invitations/accept"
    ).split(),
)
async def test_registered_spa_refresh_and_head(published, static_package, path):
    """逐一刷新实际 React 路由并核对相同入口字节，查询参数不得影响路由资格；HEAD 必须保留正确长度且无正文，入口禁止长期缓存以便新发布版本及时生效。

    参数清单逐项对应真实前端注册页，包括 T16 的执行计划页。
    每次 GET 都携带查询参数，确认资格只取决于路径。
    返回字节必须等于同一份 index，而非仅检查成功状态。
    Content-Type 必须是 HTML，不能把 JSON 错误误认为入口。
    入口明确 no-cache，避免旧发布页面永久引用旧脚本。
    HEAD 要走同一个资格判断。
    HEAD 正文必须为空。
    Content-Length 必须仍等于 GET 入口字节长度。
    匿名刷新成功只说明前端可以加载，业务授权由页面 API 负责。
    """
    client, _ = published
    response = await client.get(path + "?page=2")
    assert response.status_code == 200
    assert response.content == (static_package / "index.html").read_bytes()
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"
    head = await client.head(path)
    assert head.status_code == 200 and head.content == b""
    assert head.headers["content-length"] == str(len(response.content))


@pytest.mark.parametrize(
    "path",
    (
        "/api/missing /api/v1/missing /internal/v1/missing /unknown-page /reports/missing "
        "/assets/missing.js /missing.css /missing.png /build-info.json /static-manifest.json "
        "/.vite/manifest.json /raw-evidence.html"
    ).split(),
)
async def test_unknown_and_missing_files_never_fallback(published, static_package, path):
    """未知接口、未登记页面和缺失资源即使声明接受 HTML 仍须得到结构化错误；额外放在发布目录的用户证据与内部清单不能因物理文件存在而变成同源可执行内容。

    先在启动后的目录加入原始 HTML，模拟不应被公开的文件。
    目录新增文件不能自动取得发布资格。
    参数覆盖 API、内部入口和未登记的页面子路径。
    JS、CSS、图片不存在时也必须是实际 404。
    两个发布元数据及隐藏的 Vite 图不能直接读取。
    Accept 为 HTML 不改变任何错误分支。
    JSON Content-Type 排除意外返回入口的情况。
    ErrorEnvelope 校验 requestId 字段，而不假设错误响应保留额外头。
    这保留既有 API.send_error 的实际响应语义。
    """
    (static_package / "raw-evidence.html").write_text("untrusted evidence")
    response = await published[0].get(path, headers={"Accept": "text/html"})
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["code"] == "NOT_FOUND"
    validate_api("ErrorEnvelope", response.json())


async def test_published_cache_range_and_conditional_requests(published):
    """带内容指纹的 Vite 资源允许一年 immutable 缓存，普通公开资源保持重新验证；继承 Tornado 的范围和条件请求行为，证明适配层没有自行重写文件传输协议。

    指纹脚本必须是成功文件响应，避免只检查错误缓存头。
    immutable 策略有明确的一年有效期。
    nosniff 必须沿用 API 安全头。
    favicon 刻意没有列进 Vite 图，但列进完整库存。
    它证明图外公开文件可以读取。
    人为添加 v 参数仍不能将普通文件升级成长期缓存。
    Range 只请求前七字节，响应必须为 206 且字节一致。
    ETag 从真实响应获取，不在测试重造缓存标识。
    第二次条件请求必须返回 304，由 Tornado 承担协议实现。
    """
    client, _ = published
    js = await client.get("/assets/app-Abc123xy.js")
    assert js.status_code == 200
    assert js.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert js.headers["x-content-type-options"] == "nosniff"
    assert (await client.get("/favicon.svg?v=anything")).headers["cache-control"] == "no-cache"
    partial = await client.get("/assets/app-Abc123xy.js", headers={"Range": "bytes=0-6"})
    assert partial.status_code == 206 and partial.content == js.content[:7]
    assert (
        await client.get("/assets/app-Abc123xy.js", headers={"If-None-Match": js.headers["etag"]})
    ).status_code == 304


@pytest.mark.parametrize(
    "path",
    [
        "/assets/%2e%2e/index.html",
        "/assets/%252e%252e/index.html",
        "/assets/%2f..%2findex.html",
        "/assets/%5c..%5cindex.html",
        "/assets/%00.js",
    ],
)
async def test_encoded_paths_are_rejected(published, path):
    """编码点段、编码斜杠、双重编码及空字节不得在适配器或文件系统层再次解释成合法资源；使用真实 HTTP URL 保留转义字节，避免客户端先行归一化导致虚假通过。

    点段的编码形式不能回到静态根入口。
    双重编码保留百分号时也必须拒绝。
    编码斜杠不能成为额外的路径分隔符。
    反斜杠不能依赖宿主平台的路径解释。
    空字节不能传入文件打开调用并触发服务器错误。
    请求使用保留转义形式的 URL，而不是先构建本机文件路径。
    403 与 404 都符合封闭要求。
    任何 200 或 500 都说明缺少路径约束。
    测试不接受 HTML 页面内容作为错误替代。
    """
    assert (await published[0].get(path)).status_code in {403, 404}


async def test_symlink_file_is_rejected_after_startup(published, static_package, tmp_path):
    """发布资源被替换成符号链接后即使目标仍在静态目录内也不能被服务，防止链接绕过发布清单职责；处理器每次访问检查路径组件，而非只在启动时检查一次。

    fixture 已让应用用正常文件完成启动校验。
    随后删除清单中的脚本并换成链接。
    链接目标故意仍在同一发布目录里。
    因此仅检查 resolve 后是否位于根目录并不够。
    客户端访问的是原先合法的脚本 URL。
    服务必须拒绝链接本身，而不是跟随目标返回 HTML。
    这个场景覆盖启动检查与实际读取之间的文件变化。
    目标是否越界不改变所有链接拒绝的约定。
    不要求攻击者能够写生产安装目录作为正常部署条件。
    """
    target = static_package / "assets" / "app-Abc123xy.js"
    target.unlink()
    target.symlink_to(static_package / "index.html")
    assert (await published[0].get("/assets/app-Abc123xy.js")).status_code in {403, 404}


async def test_build_info_is_exact_manifest_bound_public_projection(published, static_package):
    """公开构建信息只返回既有四个非敏感字段并绑定清单原始字节哈希，版本来源必须与安装包一致；应用原有导出槽、投递调度与证明校验器也应保持注入。

    响应必须通过已有公开 DTO 信封校验。
    额外字段与缺少字段都会由严格 schema 拒绝。
    公开值必须与安装包元数据完全相同。
    staticManifestHash 重新对完整库存原始字节计算。
    不对解析后的 JSON 重排或重新序列化。
    应用同时必须保留导出并发槽。
    密码重置投递调度仍由原有工厂注入。
    身份注册表和尝试证明校验器不得被新静态装配覆盖。
    因此测试也防止以简化的新工厂替换原有应用。
    """
    client, app = published
    response = await client.get("/api/v1/build-info")
    assert response.status_code == 200
    validate_api("BuildInfoDTOEnvelope", response.json())
    assert response.json()["data"] == json.loads((static_package / "build-info.json").read_text())
    assert (
        response.json()["data"]["staticManifestHash"]
        == hashlib.sha256((static_package / "static-manifest.json").read_bytes()).hexdigest()
    )
    assert all(
        key in app.settings
        for key in [
            "bundle_export_slots",
            "reset_dispatcher",
            "identity_reference_registry",
            "attempt_proof_verifier",
        ]
    )


@pytest.mark.parametrize(
    "missing",
    [
        "index.html",
        ".vite/manifest.json",
        "static-manifest.json",
        "build-info.json",
        "assets/app-Abc123xy.js",
    ],
)
async def test_incomplete_production_package_fails_startup(
    static_package, production_settings, missing
):
    """正式应用在接收请求前拒绝缺入口、清单、元数据或清单引用资源的安装包，错误必须稳定说明如何重建发行包；该边界不能降级到仅在页面访问时返回文件不存在。

    逐项删除入口、两种清单、构建信息和脚本依赖。
    每个参数只删除一个必需文件。
    应用还没有绑定监听端口，错误必须在装配阶段出现。
    返回 404 的文件请求不能替代正式启动失败。
    异常消息固定说明安装包不完整或非法。
    原始缺失路径由异常原因保留供本地诊断。
    测试不放宽为开发模式。
    数据库对象未连接，因此此失败不能来自迁移或库可用性。
    最后仍释放句柄，以便后续参数使用独立事件循环。
    """
    (static_package / missing).unlink()
    db = Database(production_settings)
    try:
        with pytest.raises(ValueError, match="Production static package is incomplete or invalid"):
            make_app(production_settings, db)
    finally:
        await db.close()


@pytest.mark.parametrize(
    "change", ["hash", "version", "secret", "path", "missing-entry", "symlink"]
)
async def test_invalid_package_metadata_is_rejected(static_package, production_settings, change):
    """清单哈希、包版本及公开字段约束必须在生产启动时核实，清单路径不可越界且入口必须登记；故意损坏每个独立不变量以免合法文件掩盖错误的发布元数据。

    hash 参数只破坏公开身份与库存之间的绑定。
    version 参数让前后端声明不同发行版本。
    secret 参数验证严格公开 DTO 拒绝额外密钥字段。
    path 参数写入越界的 Vite 输出引用。
    missing-entry 参数让 Vite 图不再登记 index。
    图被修改时同步更新库存字节哈希和长度。
    随后重算完整库存身份，让失败真正到达图验证分支。
    symlink 参数只替换入口文件，覆盖启动阶段链接拒绝。
    这些错误均应在创建可服务的 Application 前出现。
    """
    metadata_path = static_package / "build-info.json"
    metadata = json.loads(metadata_path.read_text())
    if change == "hash":
        metadata["staticManifestHash"] = "0" * 64
    elif change == "version":
        metadata["version"] = "999.0.0"
    elif change == "secret":
        metadata["masterKey"] = "synthetic-private-value"
    elif change in {"path", "missing-entry"}:
        manifest_path = static_package / ".vite/manifest.json"
        manifest = (
            {"index.html": {"file": "../outside.js", "isEntry": True}} if change == "path" else {}
        )
        raw = json.dumps(manifest).encode()
        manifest_path.write_bytes(raw)
        inventory_path = static_package / "static-manifest.json"
        inventory = json.loads(inventory_path.read_text())
        for entry in inventory["files"]:
            if entry["path"] == ".vite/manifest.json":
                entry.update(sha256=hashlib.sha256(raw).hexdigest(), sizeBytes=len(raw))
        inventory_raw = json.dumps(inventory).encode()
        inventory_path.write_bytes(inventory_raw)
        metadata["staticManifestHash"] = hashlib.sha256(inventory_raw).hexdigest()
    else:
        index = static_package / "index.html"
        index.unlink()
        index.symlink_to(static_package / "favicon.svg")
    metadata_path.write_text(json.dumps(metadata))
    db = Database(production_settings)
    try:
        with pytest.raises(ValueError, match="Production static package is incomplete or invalid"):
            make_app(production_settings, db)
    finally:
        await db.close()


async def test_development_boots_without_dist_and_does_not_claim_release(
    production_settings, monkeypatch, tmp_path
):
    """开发后端可在完全没有前端产物时独立启动并提供健康检查，构建信息明确不可用而不编造正式哈希；开发页面由 Vite 提供，因此 API 端口不接管 SPA。

    资源定位替换为一个完全不存在的包目录。
    开发 public_url 采用浏览器 Vite 源。
    同一真实工厂必须能成功装配。
    liveness 不需要真实数据库连接。
    构建信息不能用空字符串或全零摘要伪造正常发行。
    它必须返回约定的 503 和稳定错误码。
    登录页在后端开发端口仍然是结构化 404。
    这说明前后端可以分别调试而无需预先 stage。
    测试结束关闭连接，避免随机端口持续占用。
    """
    from importlib import resources

    monkeypatch.setattr(resources, "files", lambda anchor: tmp_path / "absent-package")
    settings = production_settings.model_copy(
        update={"environment": "development", "public_url": "http://127.0.0.1:5173"}
    )
    db = Database(settings)
    sockets = bind_sockets(0, "127.0.0.1")
    server = HTTPServer(make_app(settings, db))
    server.add_sockets(sockets)
    try:
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{sockets[0].getsockname()[1]}"
        ) as client:
            assert (await client.get("/api/v1/health/live")).status_code == 200
            info = await client.get("/api/v1/build-info")
            assert info.status_code == 503
            assert info.json()["code"] == "BUILD_INFO_UNAVAILABLE"
            assert (await client.get("/login")).status_code == 404
    finally:
        server.stop()
        await server.close_all_connections()
        await db.close()


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def test_spa_unsafe_methods_never_return_html(published, method):
    """页面与资源路由只允许读取入口，非读取动词必须由既有 Origin 与 CSRF 门禁或方法检查拒绝；即使攻击者声明 HTML 也不能得到成功页面并隐藏写操作失败。

    参数覆盖所有常见写动词和 OPTIONS。
    请求目标是已经登记且 GET 会成功的计划页面。
    没有 CSRF 或同源上下文的写请求应先被拒绝。
    OPTIONS 虽是安全方法，也不能作为 SPA 读取入口。
    允许 403 是因为现有安全检查先于方法分发。
    允许 405 是因为不支持的方法应被明确拒绝。
    两种错误都必须返回 JSON。
    禁止接受页面 200 掩盖无效写操作。
    测试不禁用应用原有的 xsrf_cookies。
    """
    response = await published[0].request(
        method, "/execution-plans", headers={"Accept": "text/html"}
    )
    assert response.status_code in {403, 405}
    assert response.headers["content-type"].startswith("application/json")


@pytest.mark.parametrize(
    "change",
    ["bytes", "size", "duplicate", "extra-field", "traversal", "missing-index", "unlisted-file"],
)
async def test_complete_inventory_is_verified_before_boot(
    static_package, production_settings, change
):
    """完整发布清单独立于 Vite 模块图覆盖复制的公开文件，精确字节、长度及路径必须全部核实；额外文件或重复项也拒绝，防止旧产物与用户证据混入后被误认作同一发行包。

    bytes 参数只改图外公开资源，证明完整库存需要校验内容。
    size 参数保留摘要但篡改声明长度。
    duplicate 参数添加完全重复记录，不能被集合静默折叠。
    extra-field 参数检查库存项的严格字段边界。
    traversal 参数将一项路径改成父目录引用。
    missing-index 参数删除必需入口记录。
    unlisted-file 参数加入未登记的 worker。
    变更库存后总会重算顶层构建哈希。
    因此拒绝不能仅由旧顶层摘要不匹配造成。
    目录文件集合必须与库存及两个内部元数据完全一致。
    """
    inventory_path = static_package / "static-manifest.json"
    inventory = json.loads(inventory_path.read_text())
    if change == "bytes":
        (static_package / "favicon.svg").write_text("changed public bytes")
    elif change == "size":
        inventory["files"][0]["sizeBytes"] += 1
    elif change == "duplicate":
        inventory["files"].append(inventory["files"][0])
    elif change == "extra-field":
        inventory["files"][0]["privateValue"] = "synthetic"
    elif change == "traversal":
        inventory["files"][0]["path"] = "../outside"
    elif change == "missing-index":
        inventory["files"] = [
            entry for entry in inventory["files"] if entry["path"] != "index.html"
        ]
    else:
        (static_package / "forgotten-worker.js").write_text("unexpected output")
    raw = json.dumps(inventory).encode()
    inventory_path.write_bytes(raw)
    info_path = static_package / "build-info.json"
    info = json.loads(info_path.read_text())
    info["staticManifestHash"] = hashlib.sha256(raw).hexdigest()
    info_path.write_text(json.dumps(info))
    db = Database(production_settings)
    try:
        with pytest.raises(ValueError, match="Production static package is incomplete or invalid"):
            make_app(production_settings, db)
    finally:
        await db.close()


async def test_complete_inventory_allows_public_file_absent_from_vite_graph(
    static_package, production_settings, monkeypatch, tmp_path
):
    """合法完整清单应允许 Vite 模块图之外的复制公开文件通过启动与 HTTP 读取，确保库存格式变化的 RED 是真实缺功能而非非法测试输入；不把模块导入图当成完整产物闭包。

    fixture 的 favicon 有完整库存记录，却没有 Vite 模块引用。
    这是合法的公开复制资源，不能因此阻止生产启动。
    切换到无关工作目录后再调用真实工厂。
    资源定位必须继续使用安装包，不能退回仓库相对路径。
    不打开监听端口即可精确观察启动是否接受新格式。
    旧的 Vite 图哈希适配器会在此给出实质 RED。
    捕获错误后转为清晰的断言失败，避免把缺功能误记成 fixture 拼写错误。
    文件 HTTP 可访问性另由 favicon 缓存测试验证。
    这里保留测试名称与历史 RED 的对应关系。
    """
    monkeypatch.chdir(tmp_path)
    db = Database(production_settings)
    try:
        try:
            make_app(production_settings, db)
        except ValueError as error:
            pytest.fail(f"Valid complete static inventory was rejected: {error}")
    finally:
        await db.close()


async def test_declared_health_aliases_keep_canonical_outage_envelopes(published):
    """公开健康别名必须遵守既有 status 与 checks 契约，数据库不可用只令 readiness 降级，进程存活仍成功；旧 API 探针响应保持兼容，不能借别名修复重写既有客户端协议。

    published 中数据库账号刻意不可用。
    进程 live 不应尝试连接这个数据库。
    live 必须仍返回标准 ok 与 process 检查。
    ready 的已知数据库错误应成为可识别的 503。
    降级信封仍通过 HealthDTOEnvelope 验证。
    只能暴露 database:false，不能泄露驱动异常。
    历史 API liveness 保留 alive 字段。
    真实数据库成功时的 canonical readiness 由生产 Cookie 集成测试覆盖。
    这里只验证最小数据库探测，其余存储与运行依赖监控属于 T21。
    """
    client, _ = published
    live = await client.get("/health/live")
    assert live.status_code == 200
    validate_api("HealthDTOEnvelope", live.json())
    assert live.json()["data"] == {"status": "ok", "checks": {"process": True}}
    ready = await client.get("/health/ready")
    assert ready.status_code == 503
    validate_api("HealthDTOEnvelope", ready.json())
    assert ready.json()["data"] == {"status": "degraded", "checks": {"database": False}}
    assert (await client.get("/api/v1/health/live")).json()["data"] == {"alive": True}


@pytest.mark.parametrize(
    "path", ["/api/v1/missing", "/internal/v1/missing", "/assets/missing.js", "/unknown-page"]
)
async def test_unknown_head_is_real_404_without_html(published, path):
    """未知接口、静态资源和未登记页面的 HEAD 也必须保持真实 404，不能因兜底缺少 HEAD 别名变成方法错误；错误头仍为 JSON 且不携带 HTML 正文，避免探测与 GET 语义分裂。

    请求不提供 Accept，不能依赖内容协商触发正确分支。
    HEAD 对未知路径不应返回 SPA 入口。
    没有正文是 HEAD 协议要求，而不是成功页面的替代信号。
    状态必须明确为 404，不能放宽接受任意客户端错误。
    该检查针对兜底路径，不改变业务接口的方法契约。
    """
    response = await published[0].head(path)
    assert response.status_code == 404
    assert response.content == b""
    assert response.headers["content-type"].startswith("application/json")


@pytest.mark.parametrize(
    "path,custom_mime",
    [
        (f"raw-evidence{suffix}", None)
        for suffix in ".html .htm .HTML .HTM .hTm .shtml .SHTML .xhtml .XHTML .xht .XHT".split()
    ]
    + [
        ("INDEX.HTML", None),
        ("Index.html", None),
        ("nested/index.html", None),
        ("raw-evidence.custom-html", "text/html"),
        ("raw-evidence.custom-xhtml", "application/xhtml+xml"),
        ("raw-evidence.custom-html", "TEXT/HTML"),
        ("raw-evidence.custom-xhtml", "APPLICATION/XHTML+XML"),
        ("raw-evidence.mimefile-html", "text/html;charset=utf-8"),
        ("raw-evidence.mimefile-xhtml", "application/xhtml+xml;charset=utf-8"),
        ("raw-evidence.parameter-html", " \tTeXt/HtMl \t; charset=UTF-8 "),
        ("raw-evidence.parameter-xhtml", "  APPLICATION/XHTML+XML ; charset=utf-8 "),
        ("raw-evidence.parameter-html", 'text/html; charset=utf-8; profile="a;b"'),
        ("raw-evidence.parameter-xhtml", 'application/xhtml+xml;profile="format;v=1"'),
    ],
)
async def test_non_entry_html_mime_is_rejected_with_valid_inventory(
    static_package, production_settings, monkeypatch, tmp_path, path, custom_mime
):
    """除精确根入口 index.html 外，完整合法库存中的 HTML 与 XHTML 文档必须在生产启动时被拒绝；逐个变体重算文件长度、文件哈希和构建库存哈希，确保失败真正来自发布类型门禁。

    扩展名参数覆盖小写、大写、混合大小写及两种 XHTML 后缀。
    shtml 与定制 MIME 别名使用和 Tornado 相同的标准库类型映射。
    MIME 值大小写同样不能改变浏览器对 HTML 文档的解释。
    参数化别名还通过真实 mime.types 文件解析，不能假设标准库会丢弃 charset。
    无空格的参数形式是普通宿主类型文件可保留的真实值。
    其它注册值覆盖外层空白、混合大小写和多个参数。
    参数中的引号或分号不得改变第一个分隔符之前的媒体类型本体。
    这些情况仍然使用同一份合法库存，不因注册内容变化绕过文件完整性校验。
    定制映射代表宿主机注册的附加 HTML 类型，而非替换文件处理器。
    先触发标准库初始化，再在测试范围内修改并自动恢复公开映射表。
    INDEX.HTML 与 Index.html 不能借大小写比较成为另一个入口。
    nested/index.html 也不能因为文件名相同而获得根入口资格。
    文件确实写入包目录，并被列入完整库存。
    清单字节身份随新增记录更新，不能依赖旧顶层哈希误判通过。
    Vite 模块图与正常根入口保持有效。
    异常原因也必须明确指出非入口 HTML，而不是其它库存错误。
    现有正常 favicon、脚本、CSS 与范围缓存测试继续承担公开资源正向检查。
    此检查不扫描内容，不试图推断普通文本中的潜在脚本。
    测试不把附加文件写到隐藏目录，保证它会进入候选公共集合。
    index.html 保持原有字节及清单声明，合法入口没有被破坏。
    附加文档没有 Vite 模块引用，模拟复制而非打包导入的文件。
    内容不含运行时凭据或真实业务数据。
    新文件路径使用相对 POSIX 形式。
    目录实际文件集合与库存记录同步变化。
    生产配置保持原有 HTTPS 约束与合成密钥。
    启动前拒绝无需浏览器或数据库身份参与。
    """
    import mimetypes

    # MIME 类型表由标准库懒加载，先完成初始化再修改公开映射，确保定制后缀确实走真实文件处理器采用的类型判断；monkeypatch 只恢复当前测试注册的后缀，不替换查询函数。
    # 全部别名分别覆盖 HTML 和 XHTML，不靠硬编码后缀列表通过。
    # 普通默认扩展名不进行任何类型表修改。
    mimetypes.guess_type("index.html")
    if custom_mime is not None:
        extension = "." + path.rsplit(".", 1)[1]
        # 宿主类型文件按空白分列，但紧贴媒体类型的 charset 参数仍会保留；通过标准库实际文件解析和注册 API 还原这一入口，不替换 MIME 查询函数或 Tornado 的 Content-Type 生成。
        # 外层带空白的注册值另走真实类型注册 API，避免让文件分列规则改变待验证输入。
        # 临时占位记录只用于让 monkeypatch 自动恢复后续 add_type 对同一公开表的改动。
        if extension.startswith(".mimefile-"):
            mime_file = tmp_path / "host.mime.types"
            mime_file.write_text(f"{custom_mime} {extension[1:]}\n")
            parsed = mimetypes.read_mime_types(mime_file)
            assert parsed is not None and parsed[extension] == custom_mime
            custom_mime = parsed[extension]
        monkeypatch.setitem(mimetypes.types_map, extension, "application/octet-stream")
        mimetypes.add_type(custom_mime, extension)
    target = static_package / path
    target.parent.mkdir(parents=True, exist_ok=True)
    content = b"<!doctype html><html><body>Copied evidence</body></html>"
    target.write_bytes(content)
    inventory_path = static_package / "static-manifest.json"
    inventory = json.loads(inventory_path.read_text())
    # 先创建附加文档再补充完整库存中的精确文件记录，使目录闭包、字节长度与 SHA-256 保持一致；这里不会故意损坏旧文件或省略记录来触发其它更早的失败关闭分支。
    # Vite 图无需引用普通复制公开文件。
    # 原有所有必需文件仍然存在，只有发布类型发生变化。
    inventory["files"].append(
        {
            "path": path,
            "sha256": hashlib.sha256(content).hexdigest(),
            "sizeBytes": len(content),
        }
    )
    raw = json.dumps(inventory).encode()
    inventory_path.write_bytes(raw)
    info_path = static_package / "build-info.json"
    info = json.loads(info_path.read_text())
    # 顶层构建哈希必须随库存原始字节重算，否则负样本会在身份绑定阶段提前失败，无法证明非入口 HTML 门禁；保留现有版本、commit 和 buildId，只更新真正变化的库存身份。
    # 不解析后再次格式化库存再参与哈希。
    # 写盘字节与服务器读取字节完全相同。
    info["staticManifestHash"] = hashlib.sha256(raw).hexdigest()
    info_path.write_text(json.dumps(info))
    db = Database(production_settings)
    try:
        with pytest.raises(
            ValueError, match="Production static package is incomplete or invalid"
        ) as failure:
            make_app(production_settings, db)
        # 外层启动错误刻意统一，因此还须核对保留的异常原因确实命中非入口 HTML 分支，不能让其它未发现的无效测试输入提前失败后仍满足宽泛的 ValueError 断言。
        # 该原因只供本地异常诊断，不通过匿名 HTTP 健康或构建信息返回。
        # 没有产生可服务的应用，因此被拒绝文档不会进入公开文件路由。
        assert str(failure.value.__cause__) == "Non-entry HTML in static inventory"
    finally:
        await db.close()
