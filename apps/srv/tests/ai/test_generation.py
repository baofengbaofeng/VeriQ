"""AI acceptance on the real HTTP boundary and guarded MySQL."""

from uuid import uuid4
from copy import deepcopy
import asyncio
import json
import pytest
from emulator import emulator, CASE
from test_workspace import new_member, client
from test_publish import create

from test_auth import setup, login
from test_workspace import workspace


async def test_provider_list_is_scoped_and_empty_without_keys(site):
    c, _ = site
    assert (await setup(c)).status_code == 201
    assert (await login(c)).status_code == 200
    ws = await workspace(c)
    response = await c.get(f"/api/v1/workspaces/{ws}/ai/providers")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["items"] == []


async def test_provider_key_is_write_only_and_generation_disabled(site):
    c, _ = site
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}/ai"
    config = {
        "name": "Example",
        "adapter": "OPENAI_COMPATIBLE",
        "baseURL": "https://api.openai.com/v1",
        "model": "explicit-user-model",
        "apiKey": "synthetic-provider-key",
        "enabled": False,
        "monthlyBudgetUsd": 1,
        "inputUsdPerMillion": 1,
        "outputUsdPerMillion": 2,
        "maxOutputTokens": 1024,
        "maxRequestUsd": 1,
    }
    response = await c.post(base + "/providers", json=config)
    assert response.status_code == 201, response.text
    provider = response.json()["data"]
    assert provider["keyConfigured"] is True
    assert "synthetic-provider-key" not in response.text
    from uuid import uuid4

    response = await c.post(
        base + "/generations",
        json={
            "requestId": str(uuid4()),
            "providerId": provider["id"],
            "purpose": "BOUNDARY_SUGGESTION",
            "prompt": "Suggest login boundaries",
        },
    )
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "AI_PROVIDER_DISABLED"


def provider_config(endpoint, **changes):
    return {
        "name": "Local protocol emulator",
        "adapter": "OPENAI_COMPATIBLE",
        "baseURL": endpoint,
        "model": "emulator",
        "apiKey": "synthetic-provider-key",
        "enabled": True,
        "monthlyBudgetUsd": 1,
        "inputUsdPerMillion": 1,
        "outputUsdPerMillion": 2,
        "maxOutputTokens": 1024,
        "maxRequestUsd": 1,
        **changes,
    }


async def ai_setup(c, endpoint, **changes):
    await setup(c)
    await login(c)
    ws = await workspace(c)
    base = f"/api/v1/workspaces/{ws}/ai"
    r = await c.post(base + "/providers", json=provider_config(endpoint, **changes))
    assert r.status_code == 201, r.text
    return ws, base, r.json()["data"]


def request(pid, **changes):
    return {
        "requestId": str(uuid4()),
        "providerId": pid,
        "purpose": "BOUNDARY_SUGGESTION",
        "prompt": "Boundary suggestions based on REQ-1: login accepts valid passwords.",
        **changes,
    }


@pytest.mark.parametrize("adapter", ["OPENAI_COMPATIBLE", "ANTHROPIC"])
async def test_sdk_real_http_usage_context_and_idempotency(site, adapter):
    c, db = site
    async with emulator() as model:
        model.output = {"suggestions": ["Empty password is rejected"], "basis": "REQ-1"}
        ws, base, p = await ai_setup(c, model.base_url, adapter=adapter)
        req = request(p["id"], data={"password": "do-not-send", "safe": 42})
        preview = await c.post(base + "/context", json=req)
        assert preview.status_code == 200, preview.text
        assert not model.calls
        ctx = preview.json()["data"]
        assert ctx["context"]["data"]["password"] == "[REDACTED]"
        req["contextHash"] = ctx["contextHash"]
        result = await c.post(base + "/generations", json=req)
        assert result.status_code == 201, result.text
        g = result.json()["data"]
        assert g["status"] == "SUCCEEDED", g
        assert (g["inputTokens"], g["outputTokens"]) == (80, 40)
        assert g["costUsd"] == 0.00016 and g["costState"] == "ESTIMATED"
        assert g["output"] == model.output
        assert len(model.calls) == 1
        assert "do-not-send" not in str(model.calls[0]["body"])
        again = await c.post(base + "/generations", json=req)
        assert again.json()["data"]["id"] == g["id"]
        assert len(model.calls) == 1
        conflict = await c.post(base + "/generations", json={**req, "prompt": "changed"})
        assert conflict.status_code == 409
        assert len(model.calls) == 1
        denied = await c.post(
            base + "/generations/" + g["id"] + "/review", json={"decision": "ACCEPT_DRAFT"}
        )
        assert denied.status_code == 422
        assert (
            await c.post(base + "/generations/" + g["id"] + "/review", json={"decision": "REJECT"})
        ).json()["data"]["status"] == "REJECTED"
        from sqlalchemy import select
        from veriq_server.db import AiProvider

        async with db.sessions() as s:
            row = await s.scalar(select(AiProvider))
            assert b"synthetic-provider-key" not in row.ciphertext


async def test_canonical_case_review_writes_only_draft(site):
    c, db = site
    async with emulator() as model:
        ws, base, p = await ai_setup(c, model.base_url)
        catalog_path = await create(c, ws)
        # Existing T04 helper publishes an immutable catalogue with a test-only receipt.
        from test_publish import publish

        version, _, _ = await publish(c, db, catalog_path)
        model.output = deepcopy(CASE)
        model.output["document"]["catalogVersionId"] = version["id"]
        req = request(p["id"], purpose="CASE_DRAFT", versionIds=[version["id"]])
        result = await c.post(base + "/generations", json=req)
        assert result.status_code == 201, result.text
        g = result.json()["data"]
        assert g["status"] == "SUCCEEDED", g
        resources = await c.get(f"/api/v1/workspaces/{ws}/resources?kind=CASE")
        assert resources.json()["data"]["items"] == []
        accepted = await c.post(
            base + "/generations/" + g["id"] + "/review",
            json={"decision": "ACCEPT_DRAFT", "key": "generated", "name": "Generated"},
        )
        assert accepted.status_code == 200, accepted.text
        generation = accepted.json()["data"]
        assert generation["resourceState"] == "DRAFT"
        resource = await c.get(f"/api/v1/workspaces/{ws}/resources/{generation['resourceId']}")
        assert resource.json()["data"]["status"] == "DRAFT"
        assert "latestVersionId" not in resource.json()["data"]
        assert len(model.calls) == 1


async def test_concurrent_budget_cancel_unknown_cost_and_revocation(site):
    c, _ = site
    async with emulator() as model:
        model.output = {"suggestions": [], "basis": "REQ-1"}
        ws, base, p = await ai_setup(c, model.base_url, monthlyBudgetUsd=0.012)
        req = request(p["id"])
        preview = await c.post(base + "/context", json=req)
        reserve = preview.json()["data"]["reservedUsd"]
        assert reserve > 0.006
        model.wait = True
        model.release.clear()
        first = asyncio.create_task(c.post(base + "/generations", json=req))
        await asyncio.wait_for(model.started.wait(), 5)
        rejected = await c.post(base + "/generations", json=request(p["id"]))
        assert rejected.status_code == 429, rejected.text
        history = (await c.get(base + "/generations")).json()["data"]["items"]
        assert len(history) == 1 and history[0]["costState"] == "UNKNOWN"
        cancelled = await c.post(base + "/generations/" + history[0]["id"] + "/cancel")
        assert cancelled.json()["data"]["status"] == "CANCELLED"
        budget = (await c.get(base + "/providers/" + p["id"])).json()["data"]["budget"]
        assert budget["heldUsd"] == reserve
        model.usage = False
        model.release.set()
        done = await first
        assert done.json()["data"]["status"] == "CANCELLED"
        assert "costUsd" not in done.json()["data"]
        assert len(model.calls) == 1
        update = provider_config(model.base_url, enabled=False)
        update.pop("apiKey")
        assert (await c.put(base + "/providers/" + p["id"], json=update)).status_code == 200
        denied = await c.post(base + "/generations", json=req)
        assert denied.status_code == 409


async def test_roles_scopes_endpoint_and_output_redaction(site):
    c, _ = site
    async with emulator() as model:
        ws, base, p = await ai_setup(c, model.base_url)
        await new_member(c, ws, role="VIEWER")
        async with client(c, "member@example.com") as viewer:
            assert (await viewer.get(base + "/providers")).status_code == 200
            assert (
                await viewer.post(base + "/generations", json=request(p["id"]))
            ).status_code == 403
            assert (
                await viewer.post(base + "/providers", json=provider_config(model.base_url))
            ).status_code == 403
        other = await workspace(c, "other")
        response = await c.post(f"/api/v1/workspaces/{other}/ai/generations", json=request(p["id"]))
        assert response.status_code == 404
        for endpoint in [
            "https://example.com/v1",
            "http://169.254.169.254/v1",
            model.base_url + "/escape",
            model.base_url + "?redirect=x",
        ]:
            assert (
                await c.post(base + "/providers", json=provider_config(endpoint))
            ).status_code == 422
        model.output = {"suggestions": ["synthetic-provider-key"], "basis": "REQ-1"}
        result = await c.post(base + "/generations", json=request(p["id"]))
        assert result.json()["data"]["output"]["suggestions"] == ["[REDACTED]"]
        model.status = 500
        error = await c.post(base + "/generations", json=request(p["id"]))
        assert error.json()["data"]["status"] == "FAILED"
        assert error.json()["data"]["costState"] == "UNKNOWN"
        assert "secret-must-never-leak" not in error.text
        assert len(model.calls) == 2  # SDK automatic retries are disabled.


async def test_invalid_output_unknown_usage_and_context_revision_guards(site):
    c, db = site
    async with emulator() as model:
        ws, base, p = await ai_setup(c, model.base_url)
        model.output = {
            "synthetic-provider-key": "unsafe dynamic member",
            "suggestions": [],
            "basis": "REQ",
        }
        result = await c.post(base + "/generations", json=request(p["id"]))
        g = result.json()["data"]
        assert g["status"] == "FAILED" and g["errorCode"] == "AI_OUTPUT_INVALID"
        assert "synthetic-provider-key" not in result.text
        assert "output" not in g
        model.output = {"suggestions": [], "basis": "REQ"}
        model.usage = False
        result = await c.post(base + "/generations", json=request(p["id"]))
        assert result.json()["data"]["costState"] == "UNKNOWN"
        assert "costUsd" not in result.json()["data"]
        lower = provider_config(model.base_url, monthlyBudgetUsd=0)
        lower.pop("apiKey")
        assert (await c.put(base + "/providers/" + p["id"], json=lower)).status_code == 409
        mismatch = request(p["id"], contextHash="0" * 64)
        assert (await c.post(base + "/generations", json=mismatch)).status_code == 409
        assert len(model.calls) == 2


async def test_revocation_during_http_keeps_reservation_and_withholds_output(site):
    c, _ = site
    async with emulator() as model:
        ws, base, p = await ai_setup(c, model.base_url)
        model.output = {"suggestions": ["private result"], "basis": "REQ"}
        model.wait = True
        model.release.clear()
        pending = asyncio.create_task(c.post(base + "/generations", json=request(p["id"])))
        await asyncio.wait_for(model.started.wait(), 5)
        config = provider_config(model.base_url, enabled=False)
        config.pop("apiKey")
        disabled = await c.put(base + "/providers/" + p["id"], json=config)
        assert disabled.status_code == 200, disabled.text
        model.release.set()
        result = await pending
        assert result.status_code == 409
        history = (await c.get(base + "/generations")).json()["data"]["items"]
        assert history[0]["costState"] == "UNKNOWN" and "output" not in history[0]
        assert history[0]["errorCode"] == "AI_OUTPUT_WITHHELD"
        assert len(model.calls) == 1


async def test_zero_budget_even_with_zero_price_blocks_http(site):
    c, _ = site
    async with emulator() as model:
        _, base, p = await ai_setup(
            c, model.base_url, monthlyBudgetUsd=0, inputUsdPerMillion=0, outputUsdPerMillion=0
        )
        response = await c.post(base + "/generations", json=request(p["id"]))
        assert response.status_code == 429, response.text
        assert not model.calls


async def test_provider_delete_matches_contract_and_history_is_withheld(site):
    c, _ = site
    async with emulator() as model:
        _, base, p = await ai_setup(c, model.base_url)
        model.output = {"suggestions": [], "basis": "REQ"}
        generated = await c.post(base + "/generations", json=request(p["id"]))
        assert generated.status_code == 201
        deleted = await c.delete(base + "/providers/" + p["id"])
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["data"] == {}
        assert (await c.get(base + "/providers")).json()["data"]["items"] == []
        history = (await c.get(base + "/generations")).json()["data"]["items"]
        assert "output" not in history[0]
        assert history[0]["errorCode"] == "AI_OUTPUT_WITHHELD"


async def test_candidate_changed_during_model_http_rejects_stale_output(site):
    c, db = site
    async with emulator() as model:
        ws, base, p = await ai_setup(c, model.base_url)
        from test_publish import publish

        catalog_path = await create(c, ws)
        version, _, _ = await publish(c, db, catalog_path)
        model.output = deepcopy(CASE)
        model.output["document"]["catalogVersionId"] = version["id"]
        candidate = await create(c, ws, "target", model.output)
        model.wait = True
        model.release.clear()
        pending = asyncio.create_task(
            c.post(
                base + "/generations",
                json=request(p["id"], purpose="CASE_DRAFT", resourceId=candidate.split("/")[-1]),
            )
        )
        await asyncio.wait_for(model.started.wait(), 5)
        content = deepcopy(model.output)
        content["document"]["title"] = "User changed the candidate"
        updated = await c.put(candidate + "/draft", json={"revision": 1, "content": content})
        assert updated.status_code == 200, updated.text
        model.release.set()
        result = await pending
        assert result.status_code == 201, result.text
        assert result.json()["data"]["status"] == "FAILED"
        assert result.json()["data"]["errorCode"] == "AI_CONTEXT_CHANGED"
        assert "output" not in result.json()["data"]


async def test_invalid_model_json_retains_known_usage_and_cost(site):
    c, _ = site
    async with emulator() as model:
        _, base, p = await ai_setup(c, model.base_url)
        model.raw_content = "invalid JSON containing synthetic-provider-key"
        response = await c.post(base + "/generations", json=request(p["id"]))
        assert response.status_code == 201, response.text
        g = response.json()["data"]
        assert g["status"] == "FAILED"
        assert g["costState"] == "ESTIMATED" and g["costUsd"] == 0.00016
        assert (g["inputTokens"], g["outputTokens"]) == (80, 40)
        assert "synthetic-provider-key" not in response.text


async def test_operator_endpoint_revocation_withholds_output_and_allows_config_repair(site):
    import httpx
    from tornado.httpserver import HTTPServer
    from veriq_server.app import make_app
    from veriq_server.settings import Settings

    c, db = site
    async with emulator() as model:
        _, base, p = await ai_setup(c, model.base_url)
        model.output = {"suggestions": ["prior advice"], "basis": "REQ"}
        assert (await c.post(base + "/generations", json=request(p["id"]))).status_code == 201
        settings = Settings(
            database_url=db.engine.url.render_as_string(hide_password=False),
            public_url=str(c.base_url).rstrip("/"),
            master_key="a" * 64,
            signing_key="b" * 64,
            environment="development",
        )
        server = HTTPServer(make_app(settings, db))
        server.listen(18891, "127.0.0.1")
        try:
            async with httpx.AsyncClient(
                base_url="http://127.0.0.1:18891", cookies=c.cookies, headers=dict(c.headers)
            ) as restarted:
                history = (await restarted.get(base + "/generations")).json()["data"]["items"]
                assert "output" not in history[0]
                assert history[0]["errorCode"] == "AI_OUTPUT_WITHHELD"
                repaired = provider_config("https://api.openai.com/v1", enabled=False)
                repaired.pop("apiKey")
                updated = await restarted.put(base + "/providers/" + p["id"], json=repaired)
                assert updated.status_code == 200, updated.text
                assert len(model.calls) == 1
        finally:
            server.stop()
            await server.close_all_connections()


async def test_nonfinite_prices_are_rejected_as_invalid_json_without_provider_row(site):
    import json

    c, _ = site
    async with emulator() as model:
        _, base, _ = await ai_setup(c, model.base_url)
        invalid = provider_config(model.base_url, monthlyBudgetUsd=float("nan"))
        response = await c.post(
            base + "/providers",
            content=json.dumps(invalid),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 400, response.text
        assert response.json()["code"] == "INVALID_REQUEST"
        assert len((await c.get(base + "/providers")).json()["data"]["items"]) == 1
        assert not model.calls


@pytest.mark.parametrize("unusable", ["nested_case", "surrogate_advice", "surrogate_key"])
async def test_fix1_unusable_output_finalizes_known_usage_without_draft(site, unusable):
    c, db = site
    async with emulator() as model:
        ws, base, p = await ai_setup(c, model.base_url)
        purpose = "BOUNDARY_SUGGESTION"
        if unusable == "nested_case":
            purpose = "CASE_DRAFT"
            nested = 0
            for _ in range(200):
                nested = [nested]
            model.output = deepcopy(CASE)
            model.output["document"]["steps"][0]["afterAssertions"] = [
                {
                    "id": "nested",
                    "type": "responseField",
                    "source": "response:read",
                    "pointer": "/ok",
                    "operator": "equals",
                    "expected": nested,
                    "severity": "BLOCK",
                    "expectedSource": "REQ-1",
                }
            ]
        elif unusable == "surrogate_advice":
            model.output = {"suggestions": [], "basis": "\ud800"}
        else:
            model.output = {"suggestions": [], "basis": "REQ-1", "\ud800": "unsafe"}
        response = await c.post(base + "/generations", json=request(p["id"], purpose=purpose))
        assert response.status_code == 201, response.text
        g = response.json()["data"]
        assert g["status"] == "FAILED", g
        assert g["costState"] == "ESTIMATED" and g["costUsd"] == 0.00016
        assert (g["inputTokens"], g["outputTokens"]) == (80, 40)
        assert g["errorCode"] == "AI_OUTPUT_INVALID"
        assert g["diagnostics"][0]["code"] == (
            "AI_OUTPUT_NESTING_LIMIT" if unusable == "nested_case" else "AI_OUTPUT_NOT_PORTABLE"
        )
        assert "output" not in g
        assert (await c.get(base + "/generations/" + g["id"])).json()["data"] == g
        assert (await c.get(f"/api/v1/workspaces/{ws}/resources?kind=CASE")).json()["data"][
            "items"
        ] == []
        budget = (await c.get(base + "/providers/" + p["id"])).json()["data"]["budget"]
        assert budget["heldUsd"] == 0 and budget["estimatedUsedUsd"] == 0.00016
        from sqlalchemy import select
        from veriq_server.db import AiGeneration

        async with db.sessions() as session:
            persisted = (await session.scalars(select(AiGeneration))).one()
            assert persisted.status == "FAILED" and persisted.cost_micros == 160
        assert len(model.calls) == 1


@pytest.mark.parametrize("adapter", ["OPENAI_COMPATIBLE", "ANTHROPIC"])
async def test_fix1_truncated_sdk_reply_retains_verified_usage(site, adapter):
    c, _ = site
    async with emulator() as model:
        _, base, p = await ai_setup(c, model.base_url, adapter=adapter, maxOutputTokens=32)
        model.raw_content = '{"unfinished":'
        model.finish_reason = "length"
        model.stop_reason = "max_tokens"
        model.output_tokens = 32
        response = await c.post(base + "/generations", json=request(p["id"]))
        assert response.status_code == 201, response.text
        g = response.json()["data"]
        assert g["status"] == "FAILED" and g["errorCode"] == "AI_INCOMPLETE_OUTPUT"
        assert g["costState"] == "ESTIMATED" and g["costUsd"] == 0.000144
        assert (g["inputTokens"], g["outputTokens"]) == (80, 32)
        assert "output" not in g
        budget = (await c.get(base + "/providers/" + p["id"])).json()["data"]["budget"]
        assert budget["heldUsd"] == 0 and budget["estimatedUsedUsd"] == 0.000144
        assert (await c.get(base + "/generations/" + g["id"])).json()["data"] == g
        assert len(model.calls) == 1


@pytest.mark.parametrize("raw", ["\ud800", None], ids=["raw_unicode", "parser_nesting"])
async def test_fix1_parser_failure_finalizes_known_usage(site, raw):
    c, _ = site
    if raw is None:
        # Python 3.12's C JSON decoder has its own recursion threshold.
        depth = 10000
        raw = "[" * depth + "0" + "]" * depth
        assert len(raw.encode()) < 128 * 1024
        with pytest.raises(RecursionError):
            json.loads(raw)
    async with emulator() as model:
        _, base, p = await ai_setup(c, model.base_url)
        model.raw_content = raw
        response = await c.post(base + "/generations", json=request(p["id"]))
        assert response.status_code == 201, response.text
        g = response.json()["data"]
        assert g["status"] == "FAILED" and g["errorCode"] == "AI_INVALID_JSON"
        assert g["costState"] == "ESTIMATED" and g["costUsd"] == 0.00016
        assert (g["inputTokens"], g["outputTokens"]) == (80, 40)
        assert "output" not in g
        assert (await c.get(base + "/generations/" + g["id"])).json()["data"] == g
        assert (await c.get(base + "/providers/" + p["id"])).json()["data"]["budget"][
            "heldUsd"
        ] == 0


@pytest.mark.parametrize("usage", ["missing", "over_limit"])
async def test_fix1_truncated_unverified_usage_keeps_reservation(site, usage):
    c, _ = site
    async with emulator() as model:
        _, base, p = await ai_setup(c, model.base_url, maxOutputTokens=32)
        model.finish_reason = "length"
        model.usage = usage != "missing"
        model.output_tokens = 33
        response = await c.post(base + "/generations", json=request(p["id"]))
        assert response.status_code == 201, response.text
        g = response.json()["data"]
        assert g["status"] == "FAILED" and g["errorCode"] == "AI_INCOMPLETE_OUTPUT"
        assert g["costState"] == "UNKNOWN" and "costUsd" not in g
        assert "inputTokens" not in g and "outputTokens" not in g and "output" not in g
        budget = (await c.get(base + "/providers/" + p["id"])).json()["data"]["budget"]
        assert budget["heldUsd"] == g["reservedUsd"] > 0
        assert budget["estimatedUsedUsd"] == 0
