"""恢复验收只向由 Electron 主窗口确认且 pidfd 绑定的 UI renderer 注入一次异常终止，不停止 Agent 或业务浏览器；身份、角色、祖先或平台能力不符均拒绝，不提供数字 PID 信号或重试回退。"""

import json
import os
from pathlib import Path
import re
import select
import signal
import sys


class FaultRejected(RuntimeError):
    """稳定拒绝码只供 QA 解释故障注入边界，不携带命令行、私有路径或业务数据；被拒绝的目标不能进入发送信号分支，调用方也不能把拒绝当作已退出证明。"""


def identity(pid: int) -> dict:
    """读取同一宿主进程的 UID、启动时钟与父进程，用启动时钟排除读取期间 PID 复用；最终信号仍只通过已打开的内核 pidfd 发送。"""
    directory = Path(f"/proc/{pid}")
    raw = (directory / "stat").read_text()
    fields = raw[raw.rfind(")") + 2 :].split()
    return {
        "pid": pid,
        "uid": directory.stat().st_uid,
        "start": fields[19],
        "parent": int(fields[1]),
        "state": fields[0],
    }


def matches(actual: dict, pid: int, uid: int, start: str) -> bool:
    """身份必须同时匹配 PID、UID 和内核启动时钟，僵尸或已退出状态不能被再次当作活跃 UI renderer 注入，避免对已经终结的目标重复发送信号。"""
    return (
        actual["pid"] == pid
        and actual["uid"] == uid
        and actual["start"] == start
        and actual["state"] not in {"Z", "X"}
    )


def check_fd(fd: int, pid: int) -> None:
    """fdinfo 必须仍指向预期进程且 pidfd 尚未就绪，已退出目标即使数字 PID 被重用也不能通过验证；没有读取到确切身份时失败关闭。"""
    info = Path(f"/proc/self/fdinfo/{fd}").read_text()
    actual = re.search(r"^Pid:\s*(-?\d+)\s*$", info, re.MULTILINE)
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    if actual is None or int(actual[1]) != pid or poll.poll(0):
        raise FaultRejected("RENDERER_PIDFD_IDENTITY_MISMATCH")


def inject(request: dict) -> dict:
    """先打开稳定进程句柄，再复核 UI 可执行文件、renderer 参数和通往主进程的有限祖先链；仅一次 SIGKILL 诱发真实进程丢失，并用同句柄观察退出，发送成功不等于恢复或业务停止。"""
    if sys.platform != "linux" or sys.version_info[:2] != (3, 12):
        raise FaultRejected("RENDERER_FAULT_PLATFORM_REQUIRED")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise FaultRejected("RENDERER_PIDFD_REQUIRED")
    if set(request) != {
        "mainPid",
        "rendererPid",
        "uid",
        "mainStart",
        "rendererStart",
        "executable",
    }:
        raise FaultRejected("RENDERER_FAULT_INPUT_INVALID")
    main, target, uid = request["mainPid"], request["rendererPid"], request["uid"]
    if (
        any(type(value) is not int for value in (main, target, uid))
        or min(main, target) <= 1
        or main == target
        or uid != os.getuid()
    ):
        raise FaultRejected("RENDERER_FAULT_OWNER_MISMATCH")
    for field in ("mainStart", "rendererStart"):
        if not isinstance(request[field], str) or not re.fullmatch(
            r"\d{1,32}", request[field]
        ):
            raise FaultRejected("RENDERER_FAULT_INPUT_INVALID")
    raw_executable = request["executable"]
    if not isinstance(raw_executable, str) or not Path(raw_executable).is_absolute():
        raise FaultRejected("RENDERER_FAULT_INPUT_INVALID")
    executable = Path(raw_executable).resolve(strict=True)
    if executable.name != "electron":
        raise FaultRejected("RENDERER_ELECTRON_EXECUTABLE_REQUIRED")
    fd = os.pidfd_open(target, 0)
    try:
        check_fd(fd, target)
        if not matches(identity(main), main, uid, request["mainStart"]) or not matches(
            identity(target), target, uid, request["rendererStart"]
        ):
            raise FaultRejected("RENDERER_FAULT_IDENTITY_MISMATCH")
        if (
            Path(f"/proc/{main}/exe").resolve() != executable
            or Path(f"/proc/{target}/exe").resolve() != executable
        ):
            raise FaultRejected("RENDERER_FAULT_EXECUTABLE_MISMATCH")
        args = Path(f"/proc/{target}/cmdline").read_bytes().split(b"\0")
        main_args = Path(f"/proc/{main}/cmdline").read_bytes().split(b"\0")
        if b"--type=renderer" not in args or any(
            value.startswith(b"--type=") for value in main_args
        ):
            raise FaultRejected("RENDERER_FAULT_ROLE_MISMATCH")
        cursor = target
        ancestors = []
        for _ in range(16):
            current = identity(cursor)
            if (
                current["uid"] != uid
                or Path(f"/proc/{cursor}/exe").resolve() != executable
            ):
                raise FaultRejected("RENDERER_FAULT_ANCESTRY_MISMATCH")
            ancestors.append(cursor)
            if cursor == main:
                break
            cursor = current["parent"]
            if cursor <= 1 or cursor in ancestors:
                raise FaultRejected("RENDERER_FAULT_ANCESTRY_MISMATCH")
        if ancestors[-1] != main:
            raise FaultRejected("RENDERER_FAULT_ANCESTRY_MISMATCH")
        check_fd(fd, target)
        if not matches(identity(main), main, uid, request["mainStart"]) or not matches(
            identity(target), target, uid, request["rendererStart"]
        ):
            raise FaultRejected("RENDERER_FAULT_IDENTITY_MISMATCH")
        signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        if not any(flags & select.POLLIN for _fd, flags in poll.poll(3000)):
            raise FaultRejected("RENDERER_FAULT_EXIT_NOT_OBSERVED")
        return {
            "mainPid": main,
            "rendererPid": target,
            "uid": uid,
            "mainStart": request["mainStart"],
            "rendererStart": request["rendererStart"],
            "ancestors": ancestors,
            "signal": "SIGKILL",
            "pidfdBound": True,
            "exitObserved": True,
        }
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 4096:
            raise FaultRejected("RENDERER_FAULT_INPUT_INVALID")
        result = inject(json.loads(sys.argv[1]))
        print(json.dumps(result), flush=True)
    except (FaultRejected, OSError, ValueError, TypeError) as error:
        code = (
            str(error)
            if isinstance(error, FaultRejected)
            else "RENDERER_FAULT_OS_OR_INPUT_ERROR"
        )
        print(json.dumps({"faultError": code}), file=sys.stderr, flush=True)
        sys.exit(1)
