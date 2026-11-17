"""通过真实员工会话读取在线报告并观察元数据到期，覆盖首帧前的错误响应与首帧后的流式授权事件。
场景只使用合成的执行事件和上传字节，报告保留期与原始制品的访问规则分别验证。
"""

import asyncio
import dataclasses
import json
import pathlib
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, cast

import httpx
import jsonschema
import pytest
import sqlalchemy

import test_completion_mysql
import test_lease_mysql
import test_lifecycle_http_mysql as lifecycle
from veriq_server import db as models
from veriq_server import service
from veriq_server import validation

_PRIVATE = "synthetic-private-report-expiry-proof"
_RAW_TRACE = f"protocol-fixture-bytes: {_PRIVATE}".encode()
_WAIT = 10
_EXPIRY_MESSAGES = {
    "REPORT_EXPIRED": "Report metadata retention has expired",
    "ARTIFACT_EXPIRED": "Evidence retention has expired",
}
_FIXTURE_POSTS = {
    "/api/v1/setup": (201, ()),
    "/api/v1/auth/login": (200, ("csrfToken",)),
    "/api/v1/workspaces": (201, ()),
    "/api/v1/runtime-enrollments": (201, ("deviceCode", "userCode")),
    "/api/v1/runtime-enrollments/poll": (200, ("deviceToken",)),
    "/internal/v1/jobs/claim": (200, ("leaseToken",)),
}

# 旧助手使用动态类型，保留原有创建与传输行为，只在调用处明确已核对的参数和返回值供静态检查使用。
_queue_jobs = cast(
    Callable[[httpx.AsyncClient, models.Database, str, int], Awaitable[list[str]]],
    test_lease_mysql.queued_browser_jobs,
)
_device_auth = cast(Callable[[dict[str, Any]], dict[str, str]], test_lease_mysql.auth)
_claim_body = cast(Callable[[dict[str, Any]], dict[str, Any]], test_lease_mysql.claim_body)
_upload = cast(
    Callable[[httpx.AsyncClient, dict[str, Any], dict[str, Any], bytes, str, str], Awaitable[str]],
    test_completion_mysql.upload,
)


def _fixture_response(request: httpx.Request) -> tuple[int | None, tuple[str, ...]]:
    """识别复用夹具的造数请求并预先验证预期状态，正常签发只能在明确成功的指定字段返回一次性凭据。"""
    path = request.url.path
    if request.method == "POST":
        if path.startswith("/api/v1/runtime-enrollments/") and path.endswith("/approve"):
            return 200, ()
        if path.startswith("/internal/v1/attempts/") and path.endswith("/artifact-uploads"):
            return 201, ()
        return _FIXTURE_POSTS.get(path, (None, ()))
    if request.method == "PUT" and "/artifact-uploads/" in path:
        return 200, ()
    return None, ()


def _read_json(response: httpx.Response) -> dict[str, Any]:
    """解析信封时使用固定失败信息，未知的非结构化正文以及未成功登记的一次性凭据不会进入回溯。"""
    try:
        value = response.json()
    except ValueError:
        raise pytest.fail.Exception("Fixture response was not valid JSON", pytrace=False) from None
    if not isinstance(value, dict):
        pytest.fail("Fixture response must be a JSON object", pytrace=False)
    return value


class _FixtureGuard:
    """跟踪同一夹具已知的设备、会话及租约凭据，员工读取不发送这些令牌时也继续保护响应诊断。"""

    def __init__(self) -> None:
        """初始化隔离的合成私有值集合，每个 HTTP 夹具只记录自己的签发值并在其所有请求期间复用。"""
        self._known = {_PRIVATE, "a" * 64, "b" * 64, "operator-secret", "Long password 123!"}

    def check(self, text: str, request: httpx.Request) -> None:
        """同时检查当前请求所用的凭据和之前签发的值，正文与流帧均在 JSON 解析及断言比较之前扫描。"""
        candidates = (
            *self._known,
            request.headers.get("authorization", "").removeprefix("Bearer "),
            request.headers.get("x-veriq-lease-token", ""),
            request.headers.get("x-csrf-token", ""),
            *(
                part.partition("=")[2].strip()
                for part in request.headers.get("cookie", "").split(";")
            ),
        )
        if any(value and value in text for value in candidates):
            pytest.fail("Response exposed private fixture data", pytrace=False)

    def _issued_text(self, response: httpx.Response, fields: tuple[str, ...]) -> str:
        """仅从签发成功信封的约定字段摘除预期明文，同一值出现在其它字段或之后的响应时仍触发保护。"""
        body = _read_json(response)
        data = body.get("data")
        if not isinstance(data, dict):
            pytest.fail("Fixture issuance response is missing its data object", pytrace=False)
        masked = data.copy()
        for field in fields:
            value = masked.pop(field, None)
            if not isinstance(value, str) or not value:
                pytest.fail("Fixture issuance response is missing its credential", pytrace=False)
            self._known.add(value)
        return json.dumps({**body, "data": masked})

    def _check_headers(self, response: httpx.Response, session_cookie: str | None = None) -> None:
        """只豁免正常登录成功时明确定义的会话 Cookie 值，其它响应头保持与正文相同的凭据保护。"""
        for field, value in response.headers.multi_items():
            if field == "set-cookie" and session_cookie:
                value = value.removeprefix(f"veriq_session={session_cookie};")
            self.check(value, response.request)

    async def buffered(self, response: httpx.Response) -> None:
        """在旧造数助手读取正文之前保护响应并截住状态失败，实时流只在之后逐行读取以避免提前缓冲。"""
        request = response.request
        if response.status_code == 200 and request.url.path.endswith("/events/stream"):
            self._check_headers(response)
            return
        await response.aread()
        expected, fields = _fixture_response(request)
        if response.status_code == expected and fields:
            self.check(self._issued_text(response, fields), request)
        elif not (
            request.method == "GET"
            and "/artifacts/" in request.url.path
            and response.status_code == 200
            and response.content == _RAW_TRACE
        ):
            self.check(response.text, request)
        cookie = None
        if fields == ("csrfToken",) and response.status_code == expected:
            cookie = response.cookies.get("veriq_session")
            if cookie:
                self._known.add(cookie)
        self._check_headers(response, cookie)
        if expected is not None and response.status_code != expected:
            pytest.fail("Fixture HTTP request returned an unexpected status", pytrace=False)


@dataclasses.dataclass(frozen=True)
class _OnlineRun:
    """线上读取夹具保存同一个员工客户端及当前运行标识，设备凭据与领取证明不进入夹具的失败表示。"""

    site: lifecycle.Site
    workspace_id: str
    run_id: str
    case_id: str
    credential: dict[str, Any] = dataclasses.field(repr=False)
    claim: dict[str, Any] = dataclasses.field(repr=False)
    guard: _FixtureGuard = dataclasses.field(repr=False)

    @property
    def client(self) -> httpx.AsyncClient:
        """将造数和报告读取复用同一个已登记响应守卫的客户端，后续会话断言继续检查原登录身份。"""
        return self.site[0]

    @property
    def database(self) -> models.Database:
        """到期和撤权事务沿用独立测试站点提供的数据库连接，继续保留原夹具的表白名单和迁移保护。"""
        return self.site[1]

    @property
    def attempt_id(self) -> str:
        """从已通过契约验证的领取回执读取 Attempt 标识，避免重复存储并意外混用其他派单的标识。"""
        return cast(str, self.claim["attemptId"])

    @property
    def run_url(self) -> str:
        """运行路径携带原始 Workspace 作用域，报告、展示和实时流在这个共同前缀下读取该次运行。"""
        return f"/api/v1/workspaces/{self.workspace_id}/runs/{self.run_id}"

    @property
    def attempt_url(self) -> str:
        """独立 Attempt 路径用于历史及两类证据入口，这些读取直接在当前 Workspace 下校验归属。"""
        return f"/api/v1/workspaces/{self.workspace_id}/attempts/{self.attempt_id}"


def _validate(schema: str, value: Any) -> None:
    """仍以完整公开模式验证响应，只在失败时压下校验器可能包含的实例内容，避免未知值进入日志。"""
    try:
        validation.validate_api(schema, value)
    except jsonschema.ValidationError:
        raise pytest.fail.Exception(
            "Response did not match the public schema", pytrace=False
        ) from None


def _json(
    response: httpx.Response, schema: str, status: int = 200, *, message: str | None = None
) -> dict[str, Any]:
    """响应钩子先扫描私有值，再检查公开状态与信封；到期消息在模式校验前用固定诊断拒绝旧投影。"""
    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"
    body = _read_json(response)
    if message is not None and body.get("message") != message:
        pytest.fail("Expiry response message differs from the public contract", pytrace=False)
    _validate(schema, body)
    if not body["requestId"] or body["requestId"] != response.headers["x-request-id"]:
        pytest.fail("Response request ID does not match its header", pytrace=False)
    return body


def _error(response: httpx.Response, status: int, code: str) -> None:
    """报告到期与越界拒绝必须只有标准错误信封，连错误详情也不得携带旧展示、事件或证据元数据。"""
    body = _json(response, "ErrorEnvelope", status, message=_EXPIRY_MESSAGES.get(code))
    if body["code"] != code:
        pytest.fail("Error response code differs from the public contract", pytrace=False)
    if body["details"] != {}:
        pytest.fail("Error response details must be empty", pytrace=False)


def _synthetic_error(message: str, code: str = "REPORT_EXPIRED") -> httpx.Response:
    """用合成错误隔离测试自身的诊断路径，员工请求不携带曾经由设备协议签发的租约与设备令牌。"""
    return httpx.Response(
        410,
        json={"code": code, "message": message, "details": {}, "requestId": "request"},
        headers={"Cache-Control": "no-store", "X-Request-Id": "request"},
        request=httpx.Request("GET", "https://veriq.invalid/report"),
    )


@pytest.mark.parametrize(
    ("path", "field", "credential"),
    (
        ("/api/v1/runtime-enrollments/poll", "deviceToken", "synthetic-fixture-device-token"),
        ("/internal/v1/jobs/claim", "leaseToken", "synthetic-fixture-lease-token"),
    ),
    ids=("device", "lease"),
)
async def test_known_fixture_credentials_are_rejected_before_diagnostics(
    path: str, field: str, credential: str
) -> None:
    """员工响应夹带设备或租约凭据时，合规的错误信封也必须在模式校验和断言差异之前安全失败。"""
    guard = _FixtureGuard()
    request = httpx.Request("POST", f"https://veriq.invalid{path}")
    issued = httpx.Response(200, json={"data": {field: credential}}, request=request)
    await guard.buffered(issued)
    response = _synthetic_error(credential)
    with pytest.raises(pytest.fail.Exception, match="Response exposed private fixture data"):
        await guard.buffered(response)
    with pytest.raises(pytest.fail.Exception, match="Response exposed private fixture data"):
        guard.check(credential, response.request)

    repeated = httpx.Response(
        200, json={"data": {field: credential}, "unexpected": credential}, request=request
    )
    with pytest.raises(pytest.fail.Exception, match="Response exposed private fixture data"):
        await guard.buffered(repeated)


@pytest.mark.parametrize("code", ("REPORT_EXPIRED", "ARTIFACT_EXPIRED"))
def test_expiry_messages_cannot_expose_old_metadata(code: str) -> None:
    """结构正确的错误消息也不能回显先前投影的合成哈希，失败诊断须使用不含消息原文的固定文本。"""
    response = _synthetic_error("Old projection synthetic-fixture-projection-hash", code)
    with pytest.raises(pytest.fail.Exception, match="Expiry response message differs"):
        _error(response, 410, code)


async def test_failed_workspace_fixture_keeps_body_out_of_diagnostics() -> None:
    """夹具的真实状态检查在合成失败路径上使用固定信息，即使服务器故障正文含未知值也保持私有。"""
    transport = httpx.MockTransport(
        lambda request: httpx.Response(409, text="synthetic-fixture-helper-body", request=request)
    )
    async with httpx.AsyncClient(
        base_url="https://veriq.invalid",
        transport=transport,
        event_hooks={"response": [_FixtureGuard().buffered]},
    ) as client:
        with pytest.raises(pytest.fail.Exception, match="Fixture HTTP request returned"):
            await lifecycle.create_workspace(client, "alpha")


async def _record_events(run: _OnlineRun, proof: dict[str, Any], headers: dict[str, str]) -> None:
    """用真实设备事件接口写入两个连续事件，其中日志私有标记用于检查历史和实时流的读取边界。"""
    envelope = {
        "schemaVersion": "1.0",
        "attemptId": run.attempt_id,
        "timestamp": service.stamp(service.now()),
    }
    events = [
        {
            **envelope,
            "sequence": 1,
            "type": "ATTEMPT_STARTED",
            "payload": {"engineVersion": "0.1.0", "sourceHash": "0" * 64},
        },
        {
            **envelope,
            "sequence": 2,
            "type": "LOG",
            "payload": {"level": "INFO", "message": _PRIVATE},
        },
    ]
    response = await run.client.post(
        f"/internal/v1/attempts/{run.attempt_id}/events",
        json={**proof, "events": events},
        headers=headers,
    )
    _json(response, "EventBatchDTOEnvelope")


@pytest.fixture(name="active_run")
async def _active_run(site: lifecycle.Site) -> _OnlineRun:
    """复用带迁移守护的真实服务和小型队列夹具，以员工和设备各自的身份完成登记、领取与激活。"""
    client, database = site
    guard = _FixtureGuard()
    client.event_hooks["response"][:] = [guard.buffered]
    assert (await lifecycle.setup_admin(client)).status_code == 201
    assert (await lifecycle.login_admin(client)).status_code == 200
    workspace_id = await lifecycle.create_workspace(client, "alpha")
    (job_id,) = await _queue_jobs(client, database, workspace_id, 1)
    credential = await lifecycle.create_device(client, workspace_id)
    headers = _device_auth(credential)
    claim = _json(
        await client.post(
            "/internal/v1/jobs/claim",
            headers=headers,
            json=_claim_body(credential),
        ),
        "ClaimDTOEnvelope",
    )["data"]
    attempt_id = claim["attemptId"]
    proof = {key: claim[key] for key in ("leaseToken", "fencingToken")}
    activation = await client.post(
        f"/internal/v1/attempts/{attempt_id}/activate", json=proof, headers=headers
    )
    _json(activation, "ActivationDTOEnvelope")
    async with database.sessions() as session:
        job = await session.get(models.Job, job_id)
        assert job is not None and job.run_id and job.case_execution_id
        assert job.active_attempt_id == attempt_id
        run = _OnlineRun(
            site,
            workspace_id,
            job.run_id,
            job.case_execution_id,
            credential,
            claim,
            guard,
        )
    await _record_events(run, proof, headers)
    return run


@pytest.fixture(name="uploaded_trace")
async def _uploaded_trace(
    active_run: _OnlineRun, monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path
) -> AsyncIterator[models.AttemptUpload]:
    """在本进程私有临时路径使用真实文件后端，保留受限制品读取和内容校验并在用例结束后清理字节。"""
    run = active_run
    with tempfile.TemporaryDirectory(dir=tmp_path) as directory, monkeypatch.context() as scoped:
        scoped.chdir(directory)
        digest = await _upload(
            run.client, run.credential, run.claim, _RAW_TRACE, "trace.zip", "TRACE"
        )
        async with run.database.sessions() as session:
            upload = await session.scalar(
                sqlalchemy.select(models.AttemptUpload).where(
                    models.AttemptUpload.attempt_id == run.attempt_id,
                    models.AttemptUpload.sha256 == digest,
                )
            )
            artifact = await session.get(models.Artifact, (run.workspace_id, digest))
            assert upload is not None and upload.complete
            assert artifact is not None and artifact.storage_backend == "FILE"
        yield upload


async def _expire_attempt(run: _OnlineRun) -> None:
    """独立事务只写 Attempt 的保留期事实，继续保留原始事件和制品供读取路径自行判定是否拒绝。"""
    async with run.database.sessions.begin() as session:
        await service.lock_installation(session)
        attempt = await session.get(models.Attempt, run.attempt_id)
        assert attempt is not None
        attempt.facts = {**attempt.facts, "metadataExpiredAt": service.stamp(service.now())}


async def _account(client: httpx.AsyncClient) -> dict[str, Any]:
    """通过普通账户端点验证当前员工会话，读取用户标识和系统管理员标志以判断授权与保留期的独立性。"""
    response = await client.get("/api/v1/account")
    return cast(dict[str, Any], _json(response, "AdminUserDTOEnvelope")["data"])


def _session_digest(client: httpx.AsyncClient) -> str:
    """只比较员工会话 Cookie 的摘要，原始值既不进入断言差异也不随测试夹具公开给失败日志。"""
    cookie = client.cookies.get("veriq_session")
    if not cookie:
        pytest.fail("Employee session cookie is missing", pytrace=False)
    return service.digest(cookie)


async def _other_report(run: _OnlineRun) -> str:
    """以同一员工在另一个已授权空间建立独立的有效运行，使到期响应后的后续报告读取可观察。"""
    workspace_id = await lifecycle.create_workspace(run.client, "still-visible")
    (job_id,) = await _queue_jobs(run.client, run.database, workspace_id, 1)
    async with run.database.sessions() as session:
        job = await session.get(models.Job, job_id)
        assert job is not None and job.run_id
        return f"/api/v1/workspaces/{workspace_id}/runs/{job.run_id}/report"


async def _assert_session(
    run: _OnlineRun, actor: str, session_digest: str, other_report: str
) -> None:
    """使用原员工客户端继续读取账户和另一空间的有效报告，防止领域到期被解释为整条登录会话失效。"""
    assert _session_digest(run.client) == session_digest
    assert (await _account(run.client))["id"] == actor
    report = _json(await run.client.get(other_report), "RunReportDTOEnvelope")["data"]
    assert report["run"]["id"] == other_report.split("/")[-2]
    assert report["run"]["state"] == "QUEUED"
    assert _session_digest(run.client) == session_digest


def _assert_events(events: list[dict[str, Any]], run: _OnlineRun) -> None:
    """首次读取必须真的包含设备提交的两个事件，日志仍保留事件位置但私有正文不得进入报告投影。"""
    for event in events:
        _validate("ReportEventDTO", event)
    assert [(event["sequence"], event["type"], event["attemptId"]) for event in events] == [
        (1, "ATTEMPT_STARTED", run.attempt_id),
        (2, "LOG", run.attempt_id),
    ]
    assert events[1]["payload"] == {"withheld": True}


async def _frame(
    lines: AsyncIterator[str], request: httpx.Request, guard: _FixtureGuard
) -> dict[str, str]:
    """读取一个由空行截断的真实流事件，逐行保护私有数据并跳过保活注释，保留可验证的原始事件名。"""
    frame: dict[str, str] = {}
    async for line in lines:
        guard.check(line, request)
        if not line:
            if frame:
                return frame
        elif not line.startswith(":"):
            field, delimiter, value = line.partition(": ")
            assert delimiter and field in ("id", "event", "data") and field not in frame
            frame[field] = value
    pytest.fail("Stream closed before the expected event", pytrace=False)


async def test_case_metadata_expiry_precedes_first_sse_frame(active_run: _OnlineRun) -> None:
    """用例自身的保留期标记关闭运行报告和首帧前的订阅，并保留原员工在另一个空间的现有访问权。"""
    run = active_run
    actor = (await _account(run.client))["id"]
    cookie_digest = _session_digest(run.client)
    other_report = await _other_report(run)
    report_path = run.run_url + "/report"
    before = _json(await run.client.get(report_path), "RunReportDTOEnvelope")["data"]
    assert before["run"]["id"] == run.run_id
    assert before["cases"][0]["id"] == run.case_id
    attempt = before["cases"][0]["attempts"][0]
    assert attempt["id"] == run.attempt_id and attempt["finishedAt"] is None
    async with run.database.sessions.begin() as session:
        await service.lock_installation(session)
        case = await session.get(models.CaseExecution, run.case_id)
        assert case is not None
        case.provenance = {**case.provenance, "metadataExpiredAt": service.stamp(service.now())}
    _error(await run.client.get(report_path), 410, "REPORT_EXPIRED")
    response = await run.client.post(run.run_url + "/events/stream", json={}, timeout=_WAIT)
    _error(response, 410, "REPORT_EXPIRED")
    assert "event: report" not in response.text
    await _assert_session(run, actor, cookie_digest, other_report)


async def test_attempt_metadata_expiry_hides_live_report_projections(
    active_run: _OnlineRun, uploaded_trace: models.AttemptUpload
) -> None:
    """历史和证据列表先返回真实事件与上传元数据，再根据 Attempt 自身标记一致返回无旧内容的错误。"""
    run = active_run
    report_path = run.run_url + "/report"
    history_path = run.attempt_url + "/history"
    artifacts_path = run.attempt_url + "/artifacts"
    display_path = f"{run.run_url}/attempts/{run.attempt_id}/display"
    report = _json(await run.client.get(report_path), "RunReportDTOEnvelope")["data"]
    assert report["cases"][0]["attempts"][0]["id"] == run.attempt_id
    history = _json(await run.client.get(history_path), "ReportHistoryDTOEnvelope")["data"]
    _assert_events(history["items"], run)
    assert history["nextSequence"] == 2 and history["hasMore"] is False
    evidence = _json(await run.client.get(artifacts_path), "ReportArtifactsDTOEnvelope")["data"]
    assert evidence["items"] == [
        {
            "id": uploaded_trace.id,
            "attemptId": run.attempt_id,
            "sha256": uploaded_trace.sha256,
            "kind": "TRACE",
            "sensitivity": "CREDENTIAL_RESTRICTED",
            "sizeBytes": len(_RAW_TRACE),
            "state": "AVAILABLE",
        }
    ]
    display = _json(await run.client.get(display_path), "ReportDisplayDTOEnvelope")["data"]
    assert display["metadataStatus"] == "ABSENT"
    await _expire_attempt(run)
    for path in (report_path, history_path, artifacts_path, display_path):
        _error(await run.client.get(path), 410, "REPORT_EXPIRED")


async def test_open_stream_emits_expiry_and_closes(active_run: _OnlineRun) -> None:
    """等到真实报告帧送达后才提交保留期标记，客户端随后收到到期领域事件及干净的流结束。"""
    run = active_run
    actor = (await _account(run.client))["id"]
    cookie_digest = _session_digest(run.client)
    other_report = await _other_report(run)
    async with run.client.stream(
        "POST", run.run_url + "/events/stream", json={}, timeout=_WAIT
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"] == "text/event-stream"
        assert response.headers["cache-control"] == "no-store"
        lines = response.aiter_lines()
        first = await asyncio.wait_for(_frame(lines, response.request, run.guard), _WAIT)
        assert first["event"] == "report" and first["id"]
        payload = json.loads(first["data"])
        _validate("RunReportDTO", payload["report"])
        assert payload["report"]["run"]["id"] == run.run_id
        _assert_events(payload["events"], run)
        await _expire_attempt(run)
        final = await asyncio.wait_for(_frame(lines, response.request, run.guard), _WAIT)
        assert final["event"] == "authorization" and "id" not in final
        assert json.loads(final["data"]) == {"code": "REPORT_EXPIRED"}
        if await asyncio.wait_for(anext(lines, None), _WAIT) is not None:
            pytest.fail("Stream continued after the expiry event", pytrace=False)
    await _assert_session(run, actor, cookie_digest, other_report)


async def test_expired_report_respects_workspace_authorization(active_run: _OnlineRun) -> None:
    """管理员也须具备目标空间的当前成员资格，跨空间引用与成员撤销均优先于报告保留期判定。"""
    run = active_run
    account = await _account(run.client)
    assert account["systemAdmin"] is True
    other = await lifecycle.create_workspace(run.client, "foreign")
    stream_path = run.run_url + "/events/stream"
    paths = (
        (run.run_url + "/report", "RUN_NOT_FOUND"),
        (f"{run.run_url}/attempts/{run.attempt_id}/display", "RUN_NOT_FOUND"),
        (run.attempt_url + "/history", "ATTEMPT_NOT_FOUND"),
        (run.attempt_url + "/artifacts", "ATTEMPT_NOT_FOUND"),
    )
    await _expire_attempt(run)
    for path, code in paths:
        _error(await run.client.get(path), 410, "REPORT_EXPIRED")
        foreign = path.replace(run.workspace_id, other, 1)
        _error(await run.client.get(foreign), 404, code)
    foreign_stream = stream_path.replace(run.workspace_id, other, 1)
    _error(await run.client.post(foreign_stream, json={}), 404, "RUN_NOT_FOUND")

    # 先保留撤销记录，再移除成员行，两个已提交状态都应拒绝仍有效的系统管理员会话访问原空间。
    for absent in (False, True):
        async with run.database.sessions.begin() as session:
            await service.lock_installation(session)
            member = await session.get(models.WorkspaceMember, (run.workspace_id, account["id"]))
            assert member is not None
            if absent:
                await session.delete(member)
            else:
                member.status = "REMOVED"
        for path, _code in paths:
            _error(await run.client.get(path), 403, "WORKSPACE_FORBIDDEN")
        _error(await run.client.post(stream_path, json={}), 403, "WORKSPACE_FORBIDDEN")


def _assert_download(response: httpx.Response, upload_id: str) -> None:
    """仅在授权下载成功时比较合成原始字节，同时验证隔离内容的沙箱、附件、禁缓存与禁止嗅探响应头。"""
    assert response.status_code == 200
    if response.content != _RAW_TRACE:
        pytest.fail("Downloaded bytes differ from the synthetic fixture", pytrace=False)
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert response.headers["content-disposition"] == f'attachment; filename="{upload_id}.bin"'
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_raw_evidence_keeps_independent_acl_and_expiry(
    active_run: _OnlineRun, uploaded_trace: models.AttemptUpload
) -> None:
    """元数据到期后原始字节仍取决于环境管理权限与制品自身期限，分别验证上传和存储行的到期。"""
    run = active_run
    actor = (await _account(run.client))["id"]
    path = f"{run.attempt_url}/artifacts/{uploaded_trace.id}"
    _assert_download(await run.client.get(path), uploaded_trace.id)
    await _expire_attempt(run)
    _error(await run.client.get(run.attempt_url + "/artifacts"), 410, "REPORT_EXPIRED")
    _assert_download(await run.client.get(path), uploaded_trace.id)
    async with run.database.sessions.begin() as session:
        await service.lock_installation(session)
        member = await session.get(models.WorkspaceMember, (run.workspace_id, actor))
        assert member is not None
        member.role = "EXECUTOR"
    _error(await run.client.get(path), 403, "WORKSPACE_FORBIDDEN")

    # 恢复环境管理权限并逐次提交两种原始制品到期状态，各自独立返回原始制品保留期的专用错误。
    for expire_upload in (True, False):
        async with run.database.sessions.begin() as session:
            await service.lock_installation(session)
            member = await session.get(models.WorkspaceMember, (run.workspace_id, actor))
            upload = await session.get(models.AttemptUpload, uploaded_trace.id)
            artifact = await session.get(models.Artifact, (run.workspace_id, uploaded_trace.sha256))
            assert member is not None and upload is not None and artifact is not None
            member.role = "OWNER"
            upload.expired_at = service.now() if expire_upload else None
            artifact.expired_at = None if expire_upload else service.now()
        _error(await run.client.get(path), 410, "ARTIFACT_EXPIRED")
