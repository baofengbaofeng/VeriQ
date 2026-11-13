"""执行计划与服务令牌契约测试同时覆盖有效全量范围和用途混合等负样本，并核对历史游标及 AI 的真实 Cookie 认证声明；测试只验证公开边界，不以源文本比较代替实际 JSON Schema 校验。"""

from uuid import uuid4
import pytest
from jsonschema import ValidationError
from veriq_server.validation import validate_api, api_document


@pytest.mark.parametrize(
    "value,valid",
    [
        (
            {
                "purpose": "MAINTENANCE",
                "operations": [
                    "expired-leases/reap",
                    "fixture-cleanups/reconcile",
                    "capacity/reconcile",
                    "artifacts/expire",
                ],
            },
            True,
        ),
        (
            {"purpose": "MAINTENANCE", "operations": ["capacity/reconcile", "capacity/reconcile"]},
            False,
        ),
        ({"purpose": "MAINTENANCE", "operations": ["unknown"]}, False),
        ({"purpose": "MAINTENANCE", "operations": ["trigger"]}, False),
        ({"purpose": "RUNTIME_ENROLLMENT"}, True),
        ({"purpose": "RUNTIME_ENROLLMENT", "operations": ["read"]}, False),
        (
            {
                "purpose": "EXECUTION",
                "operations": ["trigger", "read", "cancel"],
                "planIds": [str(uuid4())],
            },
            True,
        ),
        ({"purpose": "EXECUTION", "operations": ["trigger"], "planIds": []}, False),
        (
            {"purpose": "EXECUTION", "operations": ["artifacts/expire"], "planIds": [str(uuid4())]},
            False,
        ),
    ],
)
def test_service_token_purpose_separates_operation_and_plan_scope(value, valid):
    """维护允许全部四项注册操作但禁止重复和未知项，执行令牌必须绑定非空计划列表且不能混入维护权限；登记令牌保持原有短期独立用途，契约拒绝额外操作比服务层更早关闭无效输入。"""
    if valid:
        validate_api("ServiceTokenIssue", value)
    else:
        with pytest.raises(ValidationError):
            validate_api("ServiceTokenIssue", value)


@pytest.mark.parametrize(
    "policy,valid", [("QUEUE", True), ("SKIP", True), ("REJECT", True), ("ALLOW", False)]
)
def test_plan_overlap_matches_binding_scheduler_semantics(policy, valid):
    """计划只允许规范确定的串行、跳过和拒绝策略，旧占位契约中的 ALLOW 必须明确失败；角色、浏览器、设备与变量选择构成实际可创建计划，不以缺少其他必填字段的无效样本混淆策略校验。"""
    body = {
        "name": "Plan",
        "suiteVersionId": str(uuid4()),
        "environmentVersionId": str(uuid4()),
        "roleKeys": ["reader"],
        "browsers": ["chromium"],
        "runtimeIds": [str(uuid4())],
        "overlapPolicy": policy,
        "maxCaseRetries": 0,
        "variables": {},
    }
    if valid:
        validate_api("ExecutionPlanWrite", body)
    else:
        with pytest.raises(ValidationError):
            validate_api("ExecutionPlanWrite", body)


def test_history_queries_and_ai_authentication_match_implemented_routes():
    """公开查询声明必须包含实现已消费的事件序号或审计游标，AI 仍仅由普通员工 Cookie 访问而不能宣称支持服务令牌；核对公开文档对象帮助生成客户端与实际路由保持一致。"""
    paths = api_document()["paths"]
    for path, operations in paths.items():
        if path.endswith("/audit") or ("/attempts/" in path and path.endswith("/history")):
            assert any(
                p["name"] == "after" and p["in"] == "query" for p in operations["get"]["parameters"]
            )
        if "/ai/" in path:
            for operation in operations.values():
                if isinstance(operation, dict) and "security" in operation:
                    assert all("ServiceToken" not in security for security in operation["security"])
    trigger = paths["/api/v1/workspaces/{workspaceId}/execution-plans/{planId}/trigger"]["post"]
    assert set(trigger["responses"]) >= {"200", "202", "409"}
    assert trigger["responses"]["202"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/TriggerReceiptEnvelope"
    )


@pytest.mark.parametrize(
    "outcome", ["FAILED", "ERROR", "UNSTABLE", "CANCELLED", "INCOMPLETE", "SKIPPED"]
)
def test_safe_junit_preserves_nonpassing_gate_for_all_terminal_outcomes(outcome):
    """所有非通过终态都必须生成标准 JUnit 可识别的失败节点，即便用例本身看似成功或整体被跳过也不能得到零失败；额外放入的原始业务字段不得流入 XML，确保安全投影只输出允许的事实。"""
    from xml.etree.ElementTree import fromstring
    from veriq_server.handlers.trigger import sanitized_junit

    report = {
        "run": {"id": str(uuid4()), "outcome": outcome},
        "gatePassed": False,
        "cases": [{"id": str(uuid4()), "outcome": "PASSED", "raw": "synthetic-secret"}],
        "raw": "synthetic-secret",
    }
    xml = sanitized_junit(report)
    root = fromstring(xml)
    assert root.attrib["failures"] == "1"
    assert root.find("testcase/failure").attrib["type"] == outcome
    assert b"synthetic-secret" not in xml


def test_plan_management_does_not_advertise_execution_bearer_authority():
    """执行令牌只获授权触发既有计划而不能管理选择本身，公开管理契约必须仅声明员工认证；否则自动生成客户端会误导调用方以为执行令牌能够修改环境或设备，从而扩大服务授权的含义。"""
    paths = api_document()["paths"]
    for path in [
        "/api/v1/workspaces/{workspaceId}/execution-plans",
        "/api/v1/workspaces/{workspaceId}/execution-plans/{planId}",
    ]:
        for operation in paths[path].values():
            assert all("ServiceToken" not in security for security in operation["security"])
