"""验证会话中的表单入口受当前员工与工作区角色控制；卡片只含受限枚举及空间标识，不含凭据和可执行参数。"""

from uuid import uuid4

import pytest
from emulator import emulator
from test_agent_sessions import _create, _scope
from test_conversational_agent import conversation, submit
from test_workspace import client, new_member, workspace

from veriq_server.auth.authorization import WorkspaceScope
from veriq_server.contracts import _schema
from veriq_server.db import User
from veriq_server.service import Problem
from veriq_server.services.agent_capabilities import (
    CAPABILITY_IDS,
    workspace_form_card,
    workspace_form_tool,
)


def test_model_can_only_request_named_workspace_forms():
    """模型只能选择一个登记的表单名称，额外的目标、请求体或访问凭据不能通过公共工具的输入校验。"""
    tool = workspace_form_tool()
    assert tool.name == "open_workspace_form_v1" and tool.result_kind == "workspace_form"
    assert list(CAPABILITY_IDS) == _schema()["$defs"]["AgentWorkspaceCapability"]["enum"]
    for capability in CAPABILITY_IDS:
        tool.validate_arguments({"capability": capability})
    for args in [
        {},
        {"capability": "UNKNOWN"},
        {"capability": "AI_PROVIDERS", "url": "https://example.invalid"},
        {"capability": "HTTP_DATASET", "workspaceId": str(uuid4())},
        {"capability": "AUTH_CREDENTIALS", "apiKey": "fictional"},
    ]:
        with pytest.raises(Problem, match="Review") as error:
            tool.validate_arguments(args)
        assert error.value.code == "AGENT_TOOL_ARGUMENTS_INVALID"


async def test_workspace_cards_recheck_role_scope_and_archive_without_mutating(site):
    """通过真实成员管理入口改变角色并归档空间，已发出的卡片不能作为后续打开管理表单的权限凭据。"""
    c, db = site
    ws = await _scope(c)
    foreign = await workspace(c, "foreign")
    uid = await new_member(c, ws, role="ADMIN")

    async def card(name, target=ws):
        """在独立事务中读取实际账号与成员关系，使复核观察到前一个请求已经提交的角色或空间状态变化。"""
        async with db.sessions() as session:
            actor = await session.get(User, uid)
            return await workspace_form_card(session, WorkspaceScope(target), actor, name)

    assert await card("AUTH_CREDENTIALS") == {
        "type": "OPEN_WORKSPACE_FORM",
        "workspaceId": ws,
        "capability": "AUTH_CREDENTIALS",
    }
    with pytest.raises(Problem) as owner_only:
        await card("WORKSPACE_ARCHIVE")
    assert owner_only.value.code == "WORKSPACE_FORBIDDEN"
    with pytest.raises(Problem) as foreign_role:
        await card("WORKSPACE_AUDIT", foreign)
    assert foreign_role.value.code == "WORKSPACE_FORBIDDEN"
    changed = await c.put(
        f"/api/v1/workspaces/{ws}/members/{uid}", json={"role": "EDITOR", "status": "ACTIVE"}
    )
    assert changed.is_success, changed.text
    for name in (
        "AUTH_CREDENTIALS",
        "ENVIRONMENT",
        "CI_PLAN_TOKENS",
        "REPORT_EVIDENCE",
        "AI_PROVIDERS",
    ):
        with pytest.raises(Problem) as denied:
            await card(name)
        assert denied.value.code == "WORKSPACE_FORBIDDEN"
    assert (await card("HTTP_DATASET"))["capability"] == "HTTP_DATASET"
    assert (await c.delete(f"/api/v1/workspaces/{ws}")).is_success
    with pytest.raises(Problem) as archived:
        await card("FIXTURE")
    assert archived.value.code == "WORKSPACE_ARCHIVED"
    assert (await card("WORKSPACE_AUDIT"))["capability"] == "WORKSPACE_AUDIT"


async def test_reopening_saved_form_requires_original_actor_session_and_workspace(site):
    """经普通模型响应保存入口后重新读取，验证同一空间其他编辑者、同一员工别的会话和别的空间都不能借用。"""
    c, _ = site
    ws = await _scope(c)
    foreign = await workspace(c, "another")
    await new_member(c, ws, role="EDITOR")
    async with emulator() as model:
        path, _, _ = await conversation(c, ws, model)
        model.output = {
            "reply": "Review the fixture form.",
            "workspaceForm": {"capability": "FIXTURE"},
        }
        row = await submit(c, path, "Open the fixture editor")
        verified = f"{path}/{row['id']}/workspace-form"
        expected = {"type": "OPEN_WORKSPACE_FORM", "workspaceId": ws, "capability": "FIXTURE"}
        assert row["workspaceForm"] == expected
        assert (await c.get(verified)).json()["data"] == expected
        async with client(c, "member@example.com") as member:
            denied = await member.get(verified)
            assert denied.status_code == 404 and denied.json()["code"] == "AGENT_SESSION_NOT_FOUND"
        sibling = await _create(c, ws, "Different conversation")
        wrong_turn = await c.get(
            f"/api/v1/workspaces/{ws}/agent/sessions/{sibling['id']}/turns/{row['id']}/workspace-form"
        )
        assert wrong_turn.status_code == 404
        wrong_workspace = await c.get(verified.replace(ws, foreign))
        assert wrong_workspace.status_code == 404
        assert len(model.calls) == 1
