"""执行快照初始变量校验确保 Run 变量满足 CASE 声明类型与必填键，失败返回 422，本模块注释描述其专属不变量与失败语义。
先 JsonObject 契约检查，再按声明构造 schema 验证值类型。
"""


from typing import Any

from jsonschema import Draft202012Validator

from ..contracts import validate_schema
from ..service import Problem


def validate_initial_variables(declarations: dict[str, str], values: dict[str, Any]) -> None:
    """校验 values 匹配 declarations；不符映射 INITIAL_VARIABLE_INVALID，validate_initial_variables 路径必须遵守 Workspace 作用域。
    validate_initial_variables 实现于 apps/srv/src/veriq_server/services/snapshots.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    schema = {
        "type": "object",
        "properties": {key: {"type": kind} for key, kind in declarations.items()},
        "required": list(declarations),
    }
    if validate_schema("JsonObject", values) or not Draft202012Validator(schema).is_valid(values):
        raise Problem(
            422, "INITIAL_VARIABLE_INVALID", "Initial variables do not match CASE declarations"
        )
