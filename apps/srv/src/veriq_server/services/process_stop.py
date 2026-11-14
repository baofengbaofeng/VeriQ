"""集中校验已认证且通过围栏检查的 Runtime 停止范围声明，保留历史非 Mac 客户端的缺字段兼容，同时阻止平台不匹配的正回执在完成或对账路径释放在线容量。

输入能力来自通过设备认证的 Runtime 记录，不读取控制服务宿主的系统信息。
调用方先校验 Workspace、租约及 fence，本函数不改变这些原有授权条件。
未知枚举与显式空值由正式 Schema 拒绝；这里专门裁定正回执的跨字段语义。
"""

from typing import Any

from ..service import Problem


def validate_process_stop_claim(
    capabilities: dict[str, Any], process_stopped: bool, scope: str | None
) -> None:
    """依据绑定 Runtime 已登记的系统能力检查正回执范围，失败回执始终保留未知状态与隔离入口；这里只验证声明语义，不把客户端所报能力或范围升级为服务端核验的操作系统证明。

    Darwin 只能明确声明受控 Worker/Chrome 集合或实际未派生执行进程。
    Linux 和 Windows 保留全后代保证，并兼容旧客户端完全省略范围字段。
    缺少系统记录的旧 Runtime 只接受缺范围，不从新字段反推历史平台。
    停止未知必须仍可上报，因此 false 不受正回执的平台范围限制。
    未派生证明的本地生成属于 Runtime；本服务不从 PID 或业务结果推导它。
    """
    # false 表示受控集合尚未确认停止，允许省略范围才能确保旧客户端仍可主动报告故障并隔离容量；显式范围也只作为未获确认的声明保存。
    if not process_stopped:
        return
    os_name = capabilities.get("os")
    # 未派生是跨平台合同值，但仍须已登记平台才能接受显式保证；旧 Runtime 缺少操作系统时只兼容缺范围，避免据字段反推其具有 Mac 能力。
    if os_name == "darwin":
        allowed = scope in {"CONTROLLED_WORKER_BROWSER", "NO_PROCESS_SPAWNED"}
    elif os_name in {"linux", "win32"}:
        allowed = scope in {None, "FULL_DESCENDANT_TREE", "NO_PROCESS_SPAWNED"}
    else:
        allowed = scope is None
    # 授权和 fence 由两个调用入口先行检查；稳定的冲突码让客户端保留容量与停止未知状态，不会把范围拒绝解释成新的业务成功或人工审计解除。
    if not allowed:
        raise Problem(
            409, "PROCESS_STOP_SCOPE_INVALID", "Process stop scope differs from Runtime capability"
        )
