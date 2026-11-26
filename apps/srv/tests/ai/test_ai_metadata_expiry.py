"""通过真实员工会话检查到期生成内容的读取和写入边界，并验证历史仅保留独立核对过的状态与计费字段。"""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from hashlib import sha256
from typing import Any, NoReturn, cast
from uuid import uuid4

import httpx
import jsonschema
import pytest
from sqlalchemy import select

import test_auth
import test_workspace
from veriq_server import db as models
from veriq_server.infrastructure.providers import DraftContext, ProviderGateway
from veriq_server.services.jobs import database_time

from apps.srv.tests.report.test_metadata_expiry import _FixtureGuard

type Site = tuple[httpx.AsyncClient, models.Database]
type ResponseValidator = Callable[[httpx.Response], Awaitable[None]]
type ResponseGuardHook = Callable[[httpx.Response, ResponseValidator], Awaitable[None]]
_setup = cast(Callable[[httpx.AsyncClient], Awaitable[httpx.Response]], test_auth.setup)
_login = cast(Callable[[httpx.AsyncClient], Awaitable[httpx.Response]], test_auth.login)
workspace = cast(Callable[[httpx.AsyncClient, str], Awaitable[str]], test_workspace.workspace)

_PROVIDER_URL = "http://127.0.0.1:18890/v1"
_PROVIDER_KEY = "synthetic-expiry-provider-key"
_OLD_OUTPUT = {"suggestions": ["Check the empty field"], "basis": "Example requirement"}
_SIBLING_OUTPUT = {"suggestions": ["Check the enabled button"], "basis": "Sibling requirement"}
_GENERATION_MESSAGE = "Generation metadata retention has expired"
_FORBIDDEN = "WORKSPACE_FORBIDDEN"
_FORBIDDEN_MESSAGE = "Workspace permission required"
_BODY_KEYS = {"code", "message", "details", "requestId"}


def _body(response: httpx.Response) -> dict[str, Any]:
    """在失败时只报告响应结构不符，避免解析异常或差异展示携带尚未通过公开模式检查的原始响应内容。"""
    try:
        body = response.json()
    except ValueError:
        raise pytest.fail.Exception("Expected a JSON response envelope", pytrace=False) from None
    if not isinstance(body, dict):
        pytest.fail("Expected a JSON response object", pytrace=False)
    return body


def _request_id(response: httpx.Response, body: dict[str, Any]) -> None:
    """校验请求关联编号贯穿响应头与标准信封，出现缺失或不一致时只输出固定信息而不披露响应字段。"""
    if not body.get("requestId") or body["requestId"] != response.headers.get("x-request-id"):
        pytest.fail("Response request ID is missing or differs from the header", pytrace=False)


def error_response(response: httpx.Response, status: int, code: str, message: str) -> None:
    """固定错误信封必须没有旧业务正文或附加详情，避免过期投影意外进入响应以及测试失败报告的差异输出。"""
    assert response.status_code == status
    if (
        not response.headers.get("content-type", "").startswith("application/json")
        or response.headers.get("cache-control") != "no-store"
    ):
        pytest.fail("Unexpected public error response headers", pytrace=False)
    body = _body(response)
    if (
        body.keys() != _BODY_KEYS
        or body["code"] != code
        or body["message"] != message
        or body["details"] != {}
    ):
        pytest.fail("Unexpected public error envelope", pytrace=False)
    _request_id(response, body)


def success_data(response: httpx.Response, status: int = 200) -> dict[str, Any]:
    """读取已通过隐私检查和站点模式验证的成功信封，继续核对禁止缓存及请求编号一致的公开响应约定。"""
    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"
    body = _body(response)
    _request_id(response, body)
    return cast(dict[str, Any], body["data"])


class ExpiryResponseGuard:
    """在原站点模式钩子与造数助手读取正文之前扫描已知私有值，并用固定诊断拒绝预期外的状态与信封。"""

    def __init__(
        self,
        private: tuple[str, ...],
        expiry: tuple[str, str],
        setup_status: Callable[[httpx.Request], int | None] | None = None,
    ) -> None:
        """在站点构建之前保存已知合成凭据并准备登录守卫，后续才从同一客户端的首次真实响应登记密钥。"""
        self._auth = _FixtureGuard()
        self._private = private
        self._expiry = expiry
        self._setup_status = setup_status
        self._anonymous_csrf: str | None = None
        self._employee_cookie: str | None = None

    def _check_private(self, text: str) -> None:
        """检查当前请求未必携带的合成业务密钥与旧匿名令牌，失败时不输出候选私有值、消息内容或原始字节。"""
        if any(value in text for value in self._private) or (
            self._anonymous_csrf is not None and self._anonymous_csrf in text
        ):
            pytest.fail("Response exposed private expiry fixture data", pytrace=False)

    def _bootstrap_copy(self, response: httpx.Response) -> tuple[str, str]:
        """匿名安装态只豁免约定字段和一次配对的防伪 Cookie，副本中其他位置仍按已登记私值严格扫描。"""
        body = _body(response)
        data = body.get("data")
        if not isinstance(data, dict):
            pytest.fail("Setup response did not issue an anonymous CSRF token", pytrace=False)
        token = data.get("csrfToken")
        if not isinstance(token, str) or not token:
            pytest.fail("Setup response did not issue an anonymous CSRF token", pytrace=False)
        self._anonymous_csrf = token
        masked = {key: value for key, value in data.items() if key != "csrfToken"}
        return json.dumps({**body, "data": masked}), f"_xsrf={token};"

    def _check_employee_cookie(self, response: httpx.Response) -> None:
        """私下固定首次登录会话并核对之后每个请求实际发送的 Cookie，拒绝任何替换或移除且不展示值。"""
        request = response.request
        if self._employee_cookie is None:
            if (
                request.method == "POST"
                and request.url.path == "/api/v1/auth/login"
                and response.status_code == 200
            ):
                try:
                    self._employee_cookie = response.cookies.get("veriq_session")
                except httpx.CookieConflict:
                    raise pytest.fail.Exception(
                        "Login did not issue exactly one employee session cookie", pytrace=False
                    ) from None
                if not self._employee_cookie:
                    pytest.fail("Login did not issue an employee session cookie", pytrace=False)
            return

        pairs = [
            item.strip().partition("=") for item in request.headers.get("cookie", "").split(";")
        ]
        sent = [value for name, separator, value in pairs if name == "veriq_session" and separator]
        if sent != [self._employee_cookie]:
            pytest.fail("Request did not carry the original employee session", pytrace=False)
        if any(
            value.partition("=")[0].strip() == "veriq_session"
            for value in response.headers.get_list("set-cookie")
        ):
            pytest.fail("Employee session cookie was reissued or removed", pytrace=False)

    def check_archive(self, raw: bytes, request: httpx.Request) -> None:
        """逐个扫描压缩归档的文件名和解压字节，保留字节逐一对应关系以免二进制解码吞掉已知凭据。"""
        text = raw.decode("latin-1")
        self._check_private(text)
        self._auth.check(text, request)

    async def inspect_response(self, response: httpx.Response, validate: ResponseValidator) -> None:
        """从初次安装态开始先保护真实响应，再核对到期错误并运行原有模式钩子，始终保留响应原件不变。"""
        self._check_employee_cookie(response)
        await self._auth.buffered(response)
        self._check_private(response.content.decode("latin-1"))
        cookie_prefix = ""
        if (
            self._anonymous_csrf is None
            and response.request.method == "GET"
            and response.request.url.path == "/api/v1/setup"
            and response.status_code == 200
        ):
            masked_body, cookie_prefix = self._bootstrap_copy(response)
            self._check_private(masked_body)
        for field, value in response.headers.multi_items():
            if field == "set-cookie" and cookie_prefix and value.startswith(cookie_prefix):
                value = value.removeprefix(cookie_prefix)
                cookie_prefix = ""
            self._check_private(value)
        if self._setup_status:
            expected = self._setup_status(response.request)
            if expected is not None and response.status_code != expected:
                pytest.fail("Authoring fixture returned an unexpected HTTP status", pytrace=False)
        if response.status_code == 410:
            error_response(response, 410, *self._expiry)
        try:
            await validate(response)
        except (ValueError, jsonschema.ValidationError):
            raise pytest.fail.Exception(
                "Response did not match the public OpenAPI schema", pytrace=False
            ) from None


async def owner_login(client: httpx.AsyncClient) -> str:
    """在响应守卫就绪后通过真实安装和登录取得系统管理员员工会话，再从公开账户接口取得持久化主体标识。"""
    assert (await _setup(client)).status_code == 201
    assert (await _login(client)).status_code == 200
    account = success_data(await client.get("/api/v1/account"))
    assert account["systemAdmin"] is True
    return cast(str, account["id"])


async def change_membership(
    database: models.Database, workspace_id: str, actor_id: str, role: str | None
) -> None:
    """只调整已生效的目标空间与主体成员记录以控制访问前提，同一员工会话继续使用原有登录身份。"""
    async with database.sessions.begin() as session:
        member = await session.get(models.WorkspaceMember, (workspace_id, actor_id))
        assert member is not None and member.status == "ACTIVE"
        if role is None:
            await session.delete(member)
        else:
            member.role = role


@dataclass(frozen=True)
class _AiFixture:
    """将真实员工会话和工作区与合成生成记录关联，后续所有读取和事务都绑定到同一记录标识及空间。"""

    site: Site
    workspace_id: str
    generation: models.AiGeneration

    @property
    def history(self) -> str:
        """为详情、取消、人工审核与历史提供一致的工作区作用域路径，跨空间检查单独构造已授权的路径。"""
        return f"/api/v1/workspaces/{self.workspace_id}/ai/generations"

    @property
    def detail(self) -> str:
        """使用已持久化的合成生成记录标识定位公开详情，后续写入请求沿用这条路径而不重新寻找会话。"""
        return f"{self.history}/{self.generation.id}"


async def _deny_provider_call(gateway: ProviderGateway, context: DraftContext) -> NoReturn:
    """若访问边界误触发模型调用就在构造网络传输前终止，固定消息不包含供应商参数、密钥或上下文。"""
    del gateway, context
    pytest.fail("AI metadata expiry must never call a model", pytrace=False)


async def _create_provider(client: httpx.AsyncClient, workspace_id: str) -> dict[str, Any]:
    """通过真实所有者写入回环供应商配置并核对密钥已配置，测试不会尝试连通性验证或调用模型接口。"""
    response = await client.post(
        f"/api/v1/workspaces/{workspace_id}/ai/providers",
        json={
            "name": "Local metadata fixture",
            "adapter": "OPENAI_COMPATIBLE",
            "baseURL": _PROVIDER_URL,
            "model": "metadata-fixture",
            "apiKey": _PROVIDER_KEY,
            "enabled": True,
            "monthlyBudgetUsd": 1,
            "inputUsdPerMillion": 1,
            "outputUsdPerMillion": 2,
            "maxOutputTokens": 1024,
            "maxRequestUsd": 1,
        },
    )
    provider = success_data(response, 201)
    assert provider["baseURL"] == _PROVIDER_URL
    assert provider["enabled"] is provider["keyConfigured"] is True
    assert provider["revision"] == 1
    return provider


async def _seed_generation(
    database: models.Database,
    workspace_id: str,
    actor_id: str,
    provider: tuple[str, int],
    *,
    sibling: bool = False,
) -> models.AiGeneration:
    """按显式合成输出持久化成功记录，与真实供应商版本和员工主体关联，仅用实际数据库 UTC 确定记录年代。"""
    async with database.sessions.begin() as session:
        provider_id, revision = provider
        now = await database_time(session)
        created = now if sibling else now - timedelta(days=120)
        request_id = str(uuid4())
        row = models.AiGeneration(
            id=str(uuid4()),
            request_id=request_id,
            request_hash=sha256(request_id.encode()).hexdigest(),
            workspace_id=workspace_id,
            provider_id=provider_id,
            actor_id=actor_id,
            created_at=created,
            month=created.strftime("%Y-%m"),
            purpose="BOUNDARY_SUGGESTION",
            status="SUCCEEDED",
            reserved_micros=250_000,
            cost_micros=125_000,
            data={
                "providerRevision": revision,
                "output": _SIBLING_OUTPUT if sibling else _OLD_OUTPUT,
                "context": {"requirement": "Example form"},
                "provenance": [{"source": "Synthetic requirement"}],
                "diagnostics": [{"message": "Synthetic diagnostic"}],
                "inputTokens": 31,
                "outputTokens": 13,
                "pricing": {"inputUsdPerMillion": 1, "outputUsdPerMillion": 2},
            },
        )
        session.add(row)
        return row


@pytest.fixture(name="veriq_response_guard", autouse=True)
def _ai_site_hook(monkeypatch: pytest.MonkeyPatch) -> ResponseGuardHook:
    """在站点首个匿名请求之前登记供应商密钥、回环代理豁免与网关熔断，并让之后的响应复用同一守卫。"""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setattr(ProviderGateway, "generate", _deny_provider_call)
    guard = ExpiryResponseGuard((_PROVIDER_KEY,), ("AI_GENERATION_EXPIRED", _GENERATION_MESSAGE))
    return guard.inspect_response


@pytest.fixture(name="active_generation")
async def _active_generation(site: Site) -> _AiFixture:
    """创建真实供应商并写入合成的成功结果用于元数据验收，模型网关装有拒绝调用的回环测试熔断。"""
    client, database = site
    actor_id = await owner_login(client)
    workspace_id = await workspace(client, "ai-expiry")
    provider = await _create_provider(client, workspace_id)
    async with database.sessions() as session:
        row = await session.get(models.AiProvider, provider["id"])
        assert row is not None and row.workspace_id == workspace_id
        assert row.enabled and not row.deleted and row.revision == provider["revision"]
        assert row.nonce and row.ciphertext
        if _PROVIDER_KEY.encode() in row.ciphertext or "apiKey" in row.config:
            pytest.fail("Provider persisted plaintext fixture credentials", pytrace=False)
    generation = await _seed_generation(
        database, workspace_id, actor_id, (provider["id"], provider["revision"])
    )
    return _AiFixture(site, workspace_id, generation)


def _accounting(row: models.AiGeneration) -> dict[str, Any]:
    """使用已知夹具成本字面值与独立生成标识定义历史基本投影，同时保留原始 UTC 时间的公开精度。"""
    return {
        "id": row.id,
        "providerId": row.provider_id,
        "requestId": row.request_id,
        "createdAt": row.created_at.isoformat(timespec="microseconds") + "Z",
        "status": "SUCCEEDED",
        "purpose": "BOUNDARY_SUGGESTION",
        "reservedUsd": 0.25,
        "costUsd": 0.125,
        "costState": "ESTIMATED",
    }


def _live_output(dto: dict[str, Any]) -> None:
    """活跃详情必须实际交付合成输出以及将被历史过滤的各字段，先建立观察到的前态再写入到期墓碑。"""
    fields = {
        "output": _OLD_OUTPUT,
        "context": {"requirement": "Example form"},
        "provenance": [{"source": "Synthetic requirement"}],
        "diagnostics": [{"message": "Synthetic diagnostic"}],
        "inputTokens": 31,
        "outputTokens": 13,
        "pricing": {"inputUsdPerMillion": 1, "outputUsdPerMillion": 2},
    }
    assert {key: dto[key] for key in fields} == fields
    assert "errorCode" not in dto


async def _expire(fixture: _AiFixture) -> str:
    """仅在匹配工作区且保有成功载荷的记录上追加到期标记，旧输出和状态账务故意完整保留在数据库中。"""
    async with fixture.site[1].sessions.begin() as session:
        row = await session.scalar(
            select(models.AiGeneration).where(
                models.AiGeneration.id == fixture.generation.id,
                models.AiGeneration.workspace_id == fixture.workspace_id,
            )
        )
        assert row is not None and row.status == "SUCCEEDED"
        assert row.data == fixture.generation.data and "metadataExpiredAt" not in row.data
        retired_at = (await database_time(session)).isoformat(timespec="microseconds") + "Z"
        row.data = {**row.data, "metadataExpiredAt": retired_at}
        return retired_at


async def _assert_retained(fixture: _AiFixture, retired_at: str) -> None:
    """从新事务重读已到期生成记录及其审核取消审计，证明被拒绝的请求未改动状态、账务数据或旧载荷。"""
    initial = fixture.generation
    async with fixture.site[1].sessions() as session:
        row = await session.get(models.AiGeneration, initial.id)
        assert row is not None and row.workspace_id == fixture.workspace_id
        assert row.actor_id == initial.actor_id and row.provider_id == initial.provider_id
        assert row.request_id == initial.request_id and row.request_hash == initial.request_hash
        assert row.created_at == initial.created_at and row.month == initial.month
        assert row.data == {**initial.data, "metadataExpiredAt": retired_at}
        assert (row.reserved_micros, row.cost_micros) == (250_000, 125_000)
        assert (row.status, row.purpose) == ("SUCCEEDED", "BOUNDARY_SUGGESTION")
        actions = await session.scalars(
            select(models.AuditLog.action).where(
                models.AuditLog.workspace_id == fixture.workspace_id,
                models.AuditLog.target_id == row.id,
            )
        )
        assert actions.first() is None


async def _generation_request(
    client: httpx.AsyncClient, detail: str, action: str
) -> httpx.Response:
    """按公开方法发起真实详情读取、有效拒绝审核或无正文取消，使参数解析错误无法冒充生成到期拒绝。"""
    if action == "detail":
        return await client.get(detail)
    if action == "review":
        return await client.post(detail + "/review", json={"decision": "REJECT"})
    assert action == "cancel"
    return await client.post(detail + "/cancel")


@pytest.mark.parametrize("action", ["detail", "review", "cancel"])
async def test_expired_generation_route(active_generation: _AiFixture, action: str) -> None:
    """原员工会话可先读取完整成功记录，到期后指定入口必须拒绝且原会话、生成状态和审核审计保持完整。"""
    client = active_generation.site[0]
    live = success_data(await client.get(active_generation.detail))
    assert live["id"] == active_generation.generation.id
    _live_output(live)
    retired_at = await _expire(active_generation)
    response = await _generation_request(client, active_generation.detail, action)
    error_response(response, 410, "AI_GENERATION_EXPIRED", _GENERATION_MESSAGE)
    account = success_data(await client.get("/api/v1/account"))
    assert account["id"] == active_generation.generation.actor_id
    await _assert_retained(active_generation, retired_at)


async def test_history_keeps_accounting_and_withholds_expired_payload(
    active_generation: _AiFixture,
) -> None:
    """同空间历史仅交付到期行的会计摘要与错误码，另一条活跃记录的独立输出仍正常可见且外空间为空。"""
    client, database = active_generation.site
    generation = active_generation.generation
    sibling = await _seed_generation(
        database,
        active_generation.workspace_id,
        generation.actor_id,
        (generation.provider_id, generation.data["providerRevision"]),
        sibling=True,
    )
    before = success_data(await client.get(active_generation.history))
    initial = {row["id"]: row for row in before["items"]}
    assert initial.keys() == {generation.id, sibling.id}
    _live_output(initial[generation.id])
    assert initial[sibling.id]["output"] == _SIBLING_OUTPUT
    retired_at = await _expire(active_generation)

    history = success_data(await client.get(active_generation.history))
    rows = {row["id"]: row for row in history["items"]}
    assert len(history["items"]) == 2 and rows.keys() == initial.keys()
    assert history["nextCursor"] is None
    expected = {
        **_accounting(generation),
        "errorCode": "AI_GENERATION_EXPIRED",
    }
    if rows[generation.id] != expected:
        pytest.fail(
            "Expired history row did not retain exactly the accounting projection", pytrace=False
        )
    assert rows[sibling.id]["output"] == _SIBLING_OUTPUT
    assert "errorCode" not in rows[sibling.id]
    foreign = await workspace(client, "ai-foreign")
    assert success_data(await client.get(f"/api/v1/workspaces/{foreign}/ai/generations")) == {
        "items": [],
        "nextCursor": None,
    }
    await _assert_retained(active_generation, retired_at)


async def test_generation_authorizes_before_expiry(active_generation: _AiFixture) -> None:
    """相同 Cookie 在外空间得到不存在结果，在原空间仅查看成员不能写入，系统管理员失去成员关系后也拒绝读写。"""
    client, database = active_generation.site
    generation = active_generation.generation
    assert success_data(await client.get(active_generation.detail))["id"] == generation.id
    retired_at = await _expire(active_generation)
    foreign = await workspace(client, "ai-foreign")
    response = await client.get(f"/api/v1/workspaces/{foreign}/ai/generations/{generation.id}")
    error_response(response, 404, "AI_GENERATION_NOT_FOUND", "Generation not found")
    await change_membership(database, active_generation.workspace_id, generation.actor_id, "VIEWER")
    response = await client.get(active_generation.detail)
    error_response(response, 410, "AI_GENERATION_EXPIRED", _GENERATION_MESSAGE)
    for action in ("review", "cancel"):
        response = await _generation_request(client, active_generation.detail, action)
        error_response(response, 403, _FORBIDDEN, _FORBIDDEN_MESSAGE)
    await change_membership(database, active_generation.workspace_id, generation.actor_id, None)
    for action in ("detail", "review", "cancel"):
        response = await _generation_request(client, active_generation.detail, action)
        error_response(response, 403, _FORBIDDEN, _FORBIDDEN_MESSAGE)
    account = success_data(await client.get("/api/v1/account"))
    assert account["id"] == generation.actor_id and account["systemAdmin"] is True
    await _assert_retained(active_generation, retired_at)
