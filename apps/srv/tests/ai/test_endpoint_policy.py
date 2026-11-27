"""用本地部署配置和回环模拟器核对端点授权及撤销时的结果交付，测试不向外部模型供应商发出任何请求。"""

import asyncio

import anthropic
import httpx
import openai
import pytest
from emulator import emulator
from sqlalchemy import select
from test_generation import ai_setup, provider_config, request
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from tornado.web import Application, RequestHandler

from veriq_server.app import make_app
from veriq_server.db import AiGeneration, AiProvider
from veriq_server.infrastructure.providers import DraftContext, ProviderGateway
from veriq_server.services.ai_endpoints import endpoint_allowed
from veriq_server.settings import Settings


@pytest.mark.parametrize(
    ("environment", "registered", "candidate", "permitted"),
    [
        ("production", "https://model.example/Team/v1", "HTTPS://MODEL.EXAMPLE:443/Team/v1", True),
        ("production", "https://model.example/Team/v1", "https://model.example/team/v1", False),
        ("production", "https://model.example/v1", "https://model.example:8443/v1", False),
        ("production", "https://model.example/v1", "https://model.example/v1/", False),
        ("development", "http://127.0.0.1/v1", "http://127.0.0.1:80/v1", True),
        ("development", "http://[::1]/v1", "http://[0:0:0:0:0:0:0:1]/v1", True),
        ("production", "http://127.0.0.1/v1", "http://127.0.0.1/v1", False),
        ("development", "http://localhost/v1", "http://LOCALHOST:80/v1", True),
        ("development", "http://localhost/v1", "http://127.0.0.1/v1", False),
        ("development", "http://model.example/v1", "http://model.example/v1", False),
        ("production", "http://localhost/v1", "http://localhost/v1", False),
        (
            "production",
            "https://xn--mdel-qqa.example/café",
            "https://módel.example/caf%c3%a9",
            True,
        ),
        ("production", "https://model.example/a%20b/v1", "https://model.example/a%20b/v1", True),
    ],
)
def test_endpoint_authorization_compares_full_destinations(
    environment, registered, candidate, permitted
):
    """检查标准端口和主机名能够规范化匹配，大小写敏感的路径、端口边界和回环地址开发例外各自得到执行。"""
    settings = Settings.model_construct(environment=environment, ai_allowed_base_urls=[registered])
    assert endpoint_allowed(settings, candidate) is permitted


@pytest.mark.parametrize(
    "value",
    [
        None,
        "https://user@model.example/v1",
        "https://model.example/v1?",
        "https://model.example/v1#",
        "https://model.example/v1/../test",
        "https://model.example/%2Fv1",
        "https://model.example\\v1",
        "https://model.example/\nv1",
        "https://model.example:65536/v1",
        "https://model.example:/v1",
        "https://model..example/v1",
        "https://model.example/%xx",
        "https://model.example/%0D",
        "https://model.example/%2e%2E/test",
        "https://model.example/a%5Cb",
    ],
)
def test_invalid_endpoint_cannot_be_authorized_by_an_invalid_deployment_entry(value):
    """即使部署清单错误地包含相同字符串，含凭据、参数或歧义字符的地址也必须拒绝且不能授权其他非法值。"""
    settings = Settings.model_construct(environment="development", ai_allowed_base_urls=[value])
    assert not endpoint_allowed(settings, value)


@pytest.mark.parametrize("usage", [True, False], ids=["verified", "unknown"])
async def test_endpoint_revoked_during_generation_settles_without_exposing_output(site, usage):
    """回环服务已收到请求后撤销运营授权，确认事务只记录可核实的费用与失败状态，不能保存或交付模型正文。"""
    client, db = site
    async with emulator() as model:
        _, base, provider = await ai_setup(client, model.base_url)
        config = Settings(
            database_url=db.engine.url.render_as_string(hide_password=False),
            public_url=str(client.base_url).rstrip("/"),
            master_key="a" * 64,
            signing_key="b" * 64,
            environment="development",
            ai_allowed_base_urls=[model.base_url],
        )
        app = make_app(config, db)
        server = HTTPServer(app)
        sockets = bind_sockets(0, "127.0.0.1")
        server.add_sockets(sockets)
        try:
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{sockets[0].getsockname()[1]}",
                cookies=client.cookies,
                headers=dict(client.headers),
            ) as control:
                model.wait, model.usage = True, usage
                model.output = {"suggestions": ["withheld advice"], "basis": "controlled reply"}
                model.release.clear()
                pending = asyncio.create_task(
                    control.post(base + "/generations", json=request(provider["id"]))
                )
                try:
                    await asyncio.wait_for(model.started.wait(), 5)
                    config.ai_allowed_base_urls = []
                finally:
                    model.release.set()
                response = await pending
                assert response.status_code == 422
                assert response.json()["code"] == "AI_ENDPOINT_FORBIDDEN"
                history = (await control.get(base + "/generations")).json()["data"]["items"][0]
                assert history["errorCode"] == "AI_OUTPUT_WITHHELD" and "output" not in history
                async with db.sessions() as session:
                    ledger = (
                        await session.scalars(
                            select(AiGeneration).where(AiGeneration.id == history["id"])
                        )
                    ).one()
                    assert (
                        ledger.status == "FAILED"
                        and ledger.data["errorCode"] == "AI_ENDPOINT_FORBIDDEN"
                    )
                    assert "output" not in ledger.data
                    assert (ledger.cost_micros is not None) == usage
                disabled = provider_config(model.base_url, enabled=False)
                disabled.pop("apiKey")
                route = base + "/providers/" + provider["id"]
                assert (await control.put(route, json=disabled)).is_success
                assert (
                    await control.put(route, json={**disabled, "enabled": True})
                ).status_code == 422
                assert (await control.delete(route)).is_success
                assert len(model.calls) == 1
        finally:
            server.stop()
            await server.close_all_connections()
            await app.settings["notification_watcher"].close()


@pytest.mark.parametrize("adapter", ["OPENAI_COMPATIBLE", "ANTHROPIC"])
async def test_vendor_sdk_refuses_redirect_before_second_request(adapter):
    """本机监听器返回指向另一条本机路径的跳转，确认两种真实供应商客户端都只提交一次请求并报告跳转状态。"""
    calls = []

    class Redirect(RequestHandler):
        """接收两种协议在回环地址上的初次请求，用路径计数记录客户端是否再次访问本机重定向目的地。"""

        def post(self):
            """在初始请求中指定本机跳转目标，目标处理程序只记录回调，以便测试区分首个响应和自动跳转。"""
            calls.append(self.request.path)
            if self.request.path != "/redirected":
                self.set_status(307)
                self.set_header("Location", "/redirected")
            self.finish()

    server = HTTPServer(Application([(r"/.*", Redirect)]))
    sockets = bind_sockets(0, "127.0.0.1")
    server.add_sockets(sockets)
    try:
        endpoint = f"http://127.0.0.1:{sockets[0].getsockname()[1]}/v1"
        gateway = ProviderGateway(provider_config(endpoint, adapter=adapter), "synthetic-test-key")
        with pytest.raises((openai.APIStatusError, anthropic.APIStatusError)) as failure:
            await gateway.generate(DraftContext({}, {}, 64))
        assert failure.value.status_code == 307
        assert len(calls) == 1 and "/redirected" not in calls
    finally:
        server.stop()
        await server.close_all_connections()


async def test_malformed_legacy_config_and_price_receipt_remain_safe_to_read_and_repair(site):
    """模拟早期记录中含凭据的旧地址，确认列表与历史收据均隐藏敏感地址，同时仍可停用、修复并读取冻结费率。"""
    client, db = site
    async with emulator() as model:
        _, base, provider = await ai_setup(client, model.base_url)
        model.output = {"suggestions": ["prior advice"], "basis": "controlled reply"}
        history = (await client.post(base + "/generations", json=request(provider["id"]))).json()
        generation_id = history["data"]["id"]
        legacy = model.base_url.replace("http://", "http://fixture-user:fixture-secret@")
        async with db.sessions.begin() as session:
            row = await session.get(AiProvider, provider["id"])
            ledger = await session.get(AiGeneration, generation_id)
            row.config = {**row.config, "baseURL": legacy}
            ledger.data = {**ledger.data, "pricing": {**ledger.data["pricing"], "baseURL": legacy}}
        listing = await client.get(base + "/providers")
        detail = await client.get(base + "/providers/" + provider["id"])
        receipt = await client.get(base + "/generations/" + generation_id)
        for response in (listing, detail, receipt):
            assert response.status_code == 200
            assert "fixture-secret" not in response.text
        displayed = detail.json()["data"]["baseURL"]
        assert listing.json()["data"]["items"][0]["baseURL"] == displayed == "[REDACTED]"
        masked = receipt.json()["data"]
        assert masked["errorCode"] == "AI_OUTPUT_WITHHELD" and "output" not in masked
        assert masked["pricing"]["baseURL"] == displayed
        assert masked["pricing"]["model"] == "emulator"
        assert (
            masked["pricing"]["currency"] == "USD" and masked["pricing"]["inputUsdPerMillion"] == 1
        )
        route = base + "/providers/" + provider["id"]
        candidate = request(provider["id"])
        for path, payload in [
            (base + "/context", candidate),
            (base + "/generations", candidate),
            (route + "/connection-tests", {"requestId": candidate["requestId"]}),
            (base + "/generations/" + generation_id + "/review", {"decision": "REJECT"}),
        ]:
            denied = await client.post(path, json=payload)
            assert denied.status_code == 422 and denied.json()["code"] == "AI_ENDPOINT_FORBIDDEN"
            assert "fixture-secret" not in denied.text
        disabled = provider_config(displayed, enabled=False)
        assert (await client.put(route, json=disabled)).status_code == 422
        disabled.pop("apiKey")
        assert (await client.put(route, json=disabled)).is_success
        assert (await client.put(route, json={**disabled, "baseURL": model.base_url})).is_success
        assert len(model.calls) == 1
