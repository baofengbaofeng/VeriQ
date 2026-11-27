"""定义版本化模型操作名称、入参和服务端处理函数，既有 HTTP 路由的参数及实现不会决定模型工具的调用形状。"""

from collections.abc import Awaitable, Callable
from typing import Any
from dataclasses import dataclass

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import _schema, canonical_bytes
from ..db import User
from ..service import Problem
from ..settings import Settings
from .agent_actions import current_selection, proposal_preview
from .agent_capabilities import workspace_form_tool
from .agent_context import run_summary
from .agent_resource_batch import RESOURCE_BATCH_ACTION, resource_batch_tool
from .agent_resource_drafts import (
    CONFIGURABLE_KINDS,
    MAX_RESOURCE_PROPOSAL_BYTES,
    RESOURCE_ACTION,
    find_configuration,
    prepare_resource_draft,
)
from .agent_resource_lifecycle import resource_lifecycle_tools
from .agent_run_operations import prepare_run_operation, read_run_report
from .ai import sanitize
from .report import ReportService


@dataclass(frozen=True)
class ToolExecution:
    """绑定本次工具调用所在的短事务、当前授权身份与获准候选，避免模型为业务执行提供任何额外权限或秘密。"""

    session: AsyncSession
    scope: WorkspaceScope
    user: User
    context: dict[str, Any]
    settings: Settings
    protected: set[str]


@dataclass(frozen=True)
class AgentTool:
    """集中绑定模型可见的稳定操作定义到唯一的服务端处理函数，并在启动事务前拒绝不符合版本契约的输入。"""

    name: str
    description: str
    parameters: dict[str, Any]
    permission: Permission
    handler: Callable[[ToolExecution, dict[str, Any]], Awaitable[dict[str, Any]]]
    result_kind: str

    def advertised(self) -> dict[str, Any]:
        """供应商只看到版本化函数名称、说明和参数形状，控制面用的权限、实现和结果分类保留在进程内。"""
        return {"name": self.name, "description": self.description, "parameters": self.parameters}

    def validate_arguments(self, arguments: dict[str, Any]) -> None:
        """先限制参数的真实序列化字节，再校验结构与 UUID 格式，错误消息省略模型提供的原始数据和值。"""
        try:
            if len(canonical_bytes(arguments)) > MAX_RESOURCE_PROPOSAL_BYTES + 256:
                raise ValueError("Tool arguments exceed limit")
            Draft202012Validator(self.parameters, format_checker=FormatChecker()).validate(
                arguments
            )
        except (ValidationError, ValueError, RecursionError):
            raise Problem(
                422, "AGENT_TOOL_ARGUMENTS_INVALID", "Review the tool's accepted parameters"
            ) from None


def resource_model_schema() -> dict[str, Any]:
    """模型侧只描述跨资源共用的提议结构，精确 DSL 由领域契约校验，避免每次规划把全部编译 Schema 传给供应商。"""
    model = _schema()["$defs"]["AgentResourceDraftProposal"]
    resource = model["properties"]["resource"]
    document = {
        "type": "object",
        "properties": {
            "kind": {"enum": list(CONFIGURABLE_KINDS)},
            "document": {"type": "object"},
        },
        "required": ["kind", "document"],
        "additionalProperties": False,
    }
    return {
        **model,
        "properties": {
            **model["properties"],
            "resource": {**resource, "properties": {**resource["properties"], "content": document}},
        },
    }


def _arguments(
    fields: dict[str, Any], required: list[str], definitions: dict[str, Any]
) -> dict[str, Any]:
    """各操作复用同一封闭输入形状，公用定义只嵌入这一操作所需的部分以保持发给供应商的工具参数有界。"""
    return {
        "type": "object",
        "properties": fields,
        "required": required,
        "additionalProperties": False,
        "$defs": definitions,
    }


async def _run_status(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """运行查询仅返回报告服务授权过的当前状态与结论，同一工具不会打开下载入口或返回原始测试产物。"""
    report = ReportService(call.session, call.user, call.settings)
    return await run_summary(report, call.scope, args["runId"].lower())


async def _find(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """资源发现由当前空间目录查询处理，不复用公开 HTTP 路由、前端筛选字段或任何模型构造的排序表达式。"""
    return await find_configuration(call.session, call.scope, args, call.context, call.protected)


async def _read_report(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """报告材料通过领域服务取得，工具仅发送经授权和限制的结构化数据，不提供原始证据下载。"""
    report = ReportService(call.session, call.user, call.settings)
    return await read_run_report(report, call.scope, args["runId"].lower())


async def _diagnose_report(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """从同一正式报告取得失败断言和尝试标识，用于向员工回溯证据和提示接下来要检查的环节。"""
    report = ReportService(call.session, call.user, call.settings)
    return await read_run_report(report, call.scope, args["runId"].lower(), diagnose=True)


async def _prepare_run(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """先检查运行范围和可重跑条件，再冻结提议供员工审阅；运行副作用发生在现有确认事务。"""
    return await prepare_run_operation(
        call.session, call.scope, call.user, args["proposal"], call.context
    )


async def _execution_preview(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """执行计划提议沿用授权候选与修订合并，实际确认仍重新验证设备权限和同一组用例矩阵的适用性。"""
    result = await proposal_preview(
        call.session, call.scope, call.user, args["proposal"], call.context
    )
    await current_selection(call.session, call.scope, call.user, result)
    return result


async def _resource_preview(call: ToolExecution, args: dict[str, Any]) -> dict[str, Any]:
    """提议中出现当前供应商密钥或其编码值时整份拒绝，避免替换敏感字符串后还把残缺草稿误认为可以保存。"""
    sanitized = sanitize_proposal_output(args, call.protected)
    return await prepare_resource_draft(
        call.session, call.scope, call.user, sanitized["proposal"], call.context
    )


def sanitize_proposal_output(output: object, protected: set[str]) -> dict[str, Any]:
    """聊天文本与计划继续使用脱敏副本，完整草稿发生脱敏时须拒绝保存，避免确认经过静默替换的配置值。"""
    sanitized = sanitize(output, protected)
    proposal = output.get("proposal") if isinstance(output, dict) else None
    if (
        isinstance(proposal, dict)
        and proposal.get("type") in {RESOURCE_ACTION, RESOURCE_BATCH_ACTION}
        and (not isinstance(sanitized, dict) or sanitized.get("proposal") != proposal)
    ):
        raise Problem(
            422, "AGENT_RESOURCE_INVALID", "Remove secrets from the proposed configuration"
        )
    if not isinstance(sanitized, dict):
        raise Problem(422, "AGENT_OUTPUT_INVALID", "Expected an object for agent output")
    return sanitized


def configuration_tools(definitions: dict[str, Any]) -> dict[str, AgentTool]:
    """列出固定版本的业务能力，原有名称仍能解析到等价版本，供应商不会从这里看到任意服务端路由。"""
    ids = {"Id": definitions["Id"]}
    plan_defs = {
        k: definitions[k] for k in ("Id", "Browser", "AgentRunSelection", "DraftPlanProposal")
    }
    resource_defs = {
        k: definitions[k]
        for k in ("Id", "Key", "AgentConfigurableResourceKind", "AgentResourceDraftProposal")
    }
    tools = (
        workspace_form_tool(),
        resource_batch_tool(),
        AgentTool(
            "get_run_report_v1",
            "Read the bounded authoritative report and gate for an exact Run.",
            _arguments({"runId": {"$ref": "#/$defs/Id"}}, ["runId"], ids),
            Permission.VIEW,
            _read_report,
            "run",
        ),
        AgentTool(
            "diagnose_run_v1",
            "Read bounded failing cases, attempts and assertion evidence for an exact Run.",
            _arguments({"runId": {"$ref": "#/$defs/Id"}}, ["runId"], ids),
            Permission.VIEW,
            _diagnose_report,
            "run",
        ),
        AgentTool(
            "prepare_run_operation_v1",
            "Prepare cancellation or a repeat of a supported completed Run for review.",
            _arguments(
                {"proposal": _schema()["$defs"]["AgentDraftOperations"]["oneOf"][0]},
                ["proposal"],
                ids,
            ),
            Permission.EXECUTE,
            _prepare_run,
            "proposal",
        ),
        AgentTool(
            "get_run_status_v1",
            "读取指定运行的当前状态和结果摘要。",
            _arguments({"runId": {"$ref": "#/$defs/Id"}}, ["runId"], ids),
            Permission.VIEW,
            _run_status,
            "run",
        ),
        AgentTool(
            "find_configuration_v1",
            "按资源种类、名称子串或精确资源 ID 查找当前空间的配置候选和草稿修订，返回安全结构。",
            _arguments(
                {
                    "kind": _schema()["$defs"]["ResourceKind"],
                    "query": {"type": "string", "minLength": 1, "maxLength": 120},
                    "resourceId": {"$ref": "#/$defs/Id"},
                },
                [],
                ids,
            ),
            Permission.EDIT,
            _find,
            "catalog",
        ),
        AgentTool(
            "prepare_execution_action_v1",
            "为员工准备待确认的保存计划或运行提议，工具只校验候选和内容，不执行写入。",
            _arguments(
                {"proposal": {"$ref": "#/$defs/DraftPlanProposal"}}, ["proposal"], plan_defs
            ),
            Permission.EDIT,
            _execution_preview,
            "proposal",
        ),
        AgentTool(
            "prepare_resource_draft_v1",
            "准备完整资源草稿，已有草稿要求 resourceId 和 revision。仅员工确认后才保存。",
            _arguments(
                {"proposal": {"$ref": "#/$defs/AgentResourceDraftProposal"}},
                ["proposal"],
                resource_defs,
            ),
            Permission.EDIT,
            _resource_preview,
            "resource_proposal",
        ),
    )
    return {**{tool.name: tool for tool in tools}, **resource_lifecycle_tools()}


def resolve_tool(tools: dict[str, AgentTool], name: str) -> AgentTool:
    """解析受控名称并为先前的两个工具名提供兼容路由，模型试图指定其他命令或未知版本时失败关闭。"""
    aliases = {
        "get_run_status": "get_run_status_v1",
        "preview_proposal": "prepare_execution_action_v1",
    }
    tool = tools.get(aliases.get(name, name))
    if tool is None:
        raise Problem(400, "AGENT_TOOL_UNKNOWN", "Unknown agent tool")
    return tool
