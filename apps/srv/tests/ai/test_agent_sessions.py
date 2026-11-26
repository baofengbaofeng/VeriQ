"""通过真实 HTTP 员工会话与 MySQL 记录验证对话归属、归档、签名页和 Provider 设置，所有用例均不调用模型。"""

from datetime import datetime
from uuid import uuid4

from test_auth import login, setup
from test_generation import provider_config
from test_workspace import client, new_member, workspace

from veriq_server.db import AgentTurn


async def _scope(c):
    assert (await setup(c)).status_code == 201
    assert (await login(c)).status_code == 200
    return await workspace(c)


def _agent(workspace_id):
    return f"/api/v1/workspaces/{workspace_id}/agent"


async def _create(c, workspace_id, title):
    response = await c.post(_agent(workspace_id) + "/sessions", json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()["data"]


async def _provider(c, workspace_id, **updates):
    config = provider_config("https://api.openai.com/v1", **updates)
    route = f"/api/v1/workspaces/{workspace_id}/ai/providers"
    result = await c.post(route, json=config)
    assert result.status_code == 201, result.text
    return result.json()["data"]["id"], route, config


async def test_session_creation_archival_and_retained_history(site):
    """创建后使用独立登录读取同一会话，归档仍能查看历史但从默认列表移除，再次归档也不改变持久化结果。"""
    # 使用相同员工的第二份真实登录 Cookie 读取会话，证明存储不会绑定单个浏览器状态或者一次性的身份凭据。
    c, _ = site
    workspace_id = await _scope(c)
    created = await _create(c, workspace_id, "Login regression")
    assert created["title"] == "Login regression"
    assert created["workspaceId"] == workspace_id
    assert created["archived"] is False
    collection = _agent(workspace_id) + "/sessions"
    route = f"{collection}/{created['id']}"
    async with client(c, "admin@example.com") as another_client:
        assert (await another_client.get(route)).json()["data"] == created
        assert (await another_client.get(route + "/turns")).json()["data"] == {
            "items": [],
            "nextCursor": None,
        }
        assert (await another_client.delete(route)).status_code == 200

    # 归档后第一个客户端重放相同请求，验证工作区仍能通过详情读取真实历史而默认活跃列表没有保留该条目。
    assert (await c.delete(route)).status_code == 200
    assert (await c.get(route)).json()["data"] == {**created, "archived": True}
    assert (await c.get(route + "/turns")).json()["data"]["items"] == []
    assert (await c.get(collection)).json()["data"]["items"] == []
    archived = await c.get(collection, params={"archived": "true"})
    assert archived.json()["data"]["items"] == [{**created, "archived": True}]
    rejected = await c.post(route + "/turns", json={"requestId": str(uuid4()), "text": "Hello"})
    assert (rejected.status_code, rejected.json()["code"]) == (409, "AGENT_SESSION_ARCHIVED")


async def test_member_and_workspace_scopes_protect_private_sessions(site):
    """同一空间的所有者和会话创建者仍拥有各自的私有历史，即使知道完整标识也不能查看或归档对方的内容。"""
    # 在两个工作区都保持有效成员关系，跨空间否定只能由会话归属检查触发；同一空间再尝试另一员工的会话。
    c, _ = site
    workspace_id = await _scope(c)
    other_id = await workspace(c, "beta")
    member_id = await new_member(c, workspace_id, role="EDITOR")
    created = await _create(c, workspace_id, "Owner conversation")
    assert (await c.get(_agent(other_id) + f"/sessions/{created['id']}")).status_code == 404
    collection = _agent(workspace_id) + "/sessions"
    route = f"{collection}/{created['id']}"
    async with client(c, "member@example.com") as member:
        own = await _create(member, workspace_id, "Member conversation")
        result = await member.get(collection)
        assert [item["id"] for item in result.json()["data"]["items"]] == [own["id"]]
        for url in (route, route + "/turns"):
            response = await member.get(url)
            assert (response.status_code, response.json()["code"]) == (
                404,
                "AGENT_SESSION_NOT_FOUND",
            )
        assert (await member.delete(route)).status_code == 404
        rejected = await member.post(
            route + "/turns", json={"requestId": str(uuid4()), "text": "Hello"}
        )
        assert rejected.status_code == 404
        assert (await member.post(f"{route}/turns/{uuid4()}/confirm")).status_code == 404
        assert (await c.get(f"{collection}/{own['id']}")).status_code == 404
        # 先证明成员自己的会话已存在，再撤销成员资格；保留的登录 Cookie 不能继续授权已撤销空间的读取。
        revoked = await c.delete(f"/api/v1/workspaces/{workspace_id}/members/{member_id}")
        assert revoked.status_code == 200
        assert (await member.get(f"{collection}/{own['id']}")).status_code == 403

    bearer = await c.get(route, headers={"Authorization": "Bearer invalid"})
    assert bearer.status_code == 401


async def test_session_pagination_binds_signed_cursor_to_member_workspace_and_filter(site):
    """逐页检索按创建时间逆序返回会话，服务拒绝其他员工、空间和归档筛选复用首个列表签发的有效游标。"""
    c, _ = site
    workspace_id = await _scope(c)
    other_id = await workspace(c, "beta")
    await new_member(c, workspace_id)
    sessions = [await _create(c, workspace_id, str(n)) for n in range(3)]
    route = _agent(workspace_id) + "/sessions"
    page = (await c.get(route, params={"limit": 1})).json()["data"]
    assert page["items"] == [sessions[-1]]
    cursor = page["nextCursor"]
    assert cursor
    page = (await c.get(route, params={"limit": 2, "cursor": cursor})).json()["data"]
    assert page == {"items": list(reversed(sessions[:-1])), "nextCursor": None}

    # 重新使用一条服务端真正签发的有效游标来验证上下文绑定，并额外修改签名中的一个字符触发完整性检查。
    for target, params in (
        (_agent(other_id) + "/sessions", {"cursor": cursor}),
        (route, {"cursor": cursor, "archived": "true"}),
        (route, {"cursor": cursor[:-1] + ("1" if cursor[-1] != "1" else "0")}),
    ):
        result = await c.get(target, params=params)
        assert (result.status_code, result.json()["code"]) == (400, "INVALID_CURSOR")
    async with client(c, "member@example.com") as member:
        result = await member.get(route, params={"cursor": cursor})
        assert (result.status_code, result.json()["code"]) == (400, "INVALID_CURSOR")


async def test_provider_settings_prefer_explicit_and_inherit_when_cleared(site):
    """工作区初始不依赖模型，绑定专用 Provider 优先，清空后继承默认值，普通成员可看解析状态但不能写入。"""
    c, _ = site
    workspace_id = await _scope(c)
    route = _agent(workspace_id) + "/settings"
    empty = {
        "defaultProviderId": None,
        "agentProviderId": None,
        "resolvedProviderId": None,
        "providerStatus": "UNCONFIGURED",
    }
    response = await c.get(route)
    assert response.status_code == 200, response.text
    assert response.json()["data"] == empty
    # 配置不同的默认和专用标识，分别检查专用优先级、清空回退和不暴露现有供应商的其他字段，包括密钥配置。
    default, _, _ = await _provider(c, workspace_id)
    dedicated, _, _ = await _provider(c, workspace_id)
    selected = {"defaultProviderId": default, "agentProviderId": dedicated}
    ready = {**selected, "resolvedProviderId": dedicated, "providerStatus": "READY"}
    configured = await c.put(route, json=selected)
    assert configured.status_code == 200, configured.text
    assert configured.json()["data"] == ready
    await new_member(c, workspace_id)
    async with client(c, "member@example.com") as member:
        assert (await member.get(route)).json()["data"] == ready
        assert (await member.put(route, json=selected)).status_code == 403
    inherit = {**selected, "agentProviderId": None}
    assert (await c.put(route, json=inherit)).json()["data"] == {
        **inherit,
        "resolvedProviderId": default,
        "providerStatus": "READY",
    }
    cleared = {"defaultProviderId": None, "agentProviderId": None}
    assert (await c.put(route, json=cleared)).json()["data"] == empty


async def test_provider_settings_reject_foreign_and_disabled_ids_and_revalidate_selection(site):
    """错误的 Provider 不得写入，已绑定供应商随后被停用或删除时立即报告不可用并保留选择供管理员修复。"""
    c, _ = site
    workspace_id = await _scope(c)
    other_id = await workspace(c, "beta")
    route = _agent(workspace_id) + "/settings"
    initial = await c.get(route)
    assert initial.status_code == 200, initial.text
    foreign, _, _ = await _provider(c, other_id)
    disabled, _, _ = await _provider(c, workspace_id, enabled=False)
    default, _, _ = await _provider(c, workspace_id)
    enabled, providers, config = await _provider(c, workspace_id)
    selection = {"defaultProviderId": default, "agentProviderId": enabled}
    # 非法尝试携带有效的默认配置，可以观察失败是否错误提交了一半。在完整选择随后失效时也不能自动回退到它。
    for invalid, status, code in (
        (foreign, 404, "AI_PROVIDER_NOT_FOUND"),
        (disabled, 409, "AI_PROVIDER_DISABLED"),
    ):
        result = await c.put(route, json={**selection, "agentProviderId": invalid})
        assert (result.status_code, result.json()["code"]) == (status, code)
        assert (await c.get(route)).json()["data"] == initial.json()["data"]
    assert (await c.put(route, json=selection)).status_code == 200
    provider_route = f"{providers}/{enabled}"
    status = {**selection, "resolvedProviderId": None, "providerStatus": "UNAVAILABLE"}
    assert (await c.put(provider_route, json={**config, "enabled": False})).status_code == 200
    assert (await c.get(route)).json()["data"] == {**status, "errorCode": "AI_PROVIDER_DISABLED"}
    assert (await c.delete(provider_route)).status_code == 200
    assert (await c.get(route)).json()["data"] == {**status, "errorCode": "AI_PROVIDER_NOT_FOUND"}


async def test_turn_history_is_bounded_scoped_and_excludes_private_columns(site):
    """对话历史只返回当前会话的公开轮次字段，同一微秒的记录用标识稳定排序并通过不可跨会话复用的游标继续读取。"""
    c, db = site
    workspace_id = await _scope(c)
    conversation = await _create(c, workspace_id, "History")
    unrelated = await _create(c, workspace_id, "Unrelated")
    # 保持真实数据库查询的同时用固定时间构造并列顺序，把不相关轮次放在两个可见轮次之间检验归属和排序。
    ids = sorted(str(uuid4()) for _ in range(3))
    created_at = datetime(2026, 11, 18, 1, 2, 3, 456789)
    async with db.sessions.begin() as session:
        for turn_id, owner, text in zip(
            ids,
            (conversation, unrelated, conversation),
            ("First", "Private", "Second"),
            strict=True,
        ):
            session.add(
                AgentTurn(
                    id=turn_id,
                    session_id=owner["id"],
                    request_id=str(uuid4()),
                    attempt_id=str(uuid4()),
                    created_at=created_at,
                    text=text,
                    status="COMPLETED",
                    reply="Reply",
                    thinking="Private reasoning from the old format",
                )
            )
    sessions = _agent(workspace_id) + "/sessions"
    route = f"{sessions}/{conversation['id']}/turns"
    wrong_turn = await c.post(f"{route}/{ids[1]}/confirm")
    assert (wrong_turn.status_code, wrong_turn.json()["code"]) == (404, "AGENT_TURN_NOT_FOUND")
    archived = await c.delete(f"{sessions}/{conversation['id']}")
    assert archived.status_code == 200
    first = (await c.get(route, params={"limit": 1})).json()["data"]
    assert first["items"] == [
        {
            "id": ids[0],
            "createdAt": "2026-11-18T01:02:03.456789Z",
            "text": "First",
            "status": "COMPLETED",
            "reply": "Reply",
        }
    ]
    cursor = first["nextCursor"]
    assert cursor
    second = (await c.get(route, params={"cursor": cursor})).json()["data"]
    assert [item["id"] for item in second["items"]] == [ids[2]]
    assert second["nextCursor"] is None
    foreign = await c.get(f"{sessions}/{unrelated['id']}/turns", params={"cursor": cursor})
    assert (foreign.status_code, foreign.json()["code"]) == (400, "INVALID_CURSOR")
