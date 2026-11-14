"""目标测试的兜底清理只通过稳定 pidfd 向已核验创建身份和用户的自有进程发信号，拒绝退回数字 PID 的检查后终止；本工具仅由构建验证调用，不是安装后 Runtime 的 Python 依赖或通用进程管理接口。"""

import errno
import json
import os
import platform
import select
import signal
import stat
import sys
import time


def exited(handle, timeout_ms):
    """等待内核对同一进程句柄报告终止而不重新按数字 PID 查找目标，句柄即使在进程退出或编号被复用后也不会指向替代者；异常轮询状态必须失败关闭，不能把不可读取的进程路径猜成已完成停止。"""
    poller = select.poll()
    poller.register(handle, select.POLLIN | select.POLLHUP)
    events = poller.poll(max(0, timeout_ms))
    if not events:
        return False
    if any(flags & (select.POLLIN | select.POLLHUP) for _, flags in events):
        return True
    raise RuntimeError("VAULT_PIDFD_POLL_FAILED")


def cleanup(owner, deadline):
    """先打开 pidfd 再核验登记的启动时刻、执行文件与全部用户身份，验证之后的信号始终使用该句柄而非原 PID；身份不匹配绝不发信号，整个批次还受共同期限约束，避免多个异常进程拖延清理或隐藏未确认退出。"""
    if set(owner) != {"pid", "uid", "start", "executable"}:
        raise RuntimeError("VAULT_PIDFD_OWNER_INVALID")
    pid = owner.get("pid")
    if type(pid) is not int or pid <= 0 or pid == os.getpid():
        raise RuntimeError("VAULT_PIDFD_PID_INVALID")
    if (type(owner.get("uid")) is not int or owner["uid"] != os.geteuid()
            or not isinstance(owner.get("start"), str) or not owner["start"].isdigit()
            or not isinstance(owner.get("executable"), str)
            or not owner["executable"].startswith("/") or len(owner["executable"]) > 4096):
        raise RuntimeError("VAULT_PIDFD_OWNER_INVALID")
    result = dict(owner, state="unconfirmed", signals=[])
    try:
        handle = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return dict(result, state="absent-before-open")
    try:
        if exited(handle, 0):
            return dict(result, state="exited", exitObservedBy="pidfd_poll")
        try:
            with open(f"/proc/{pid}/stat", encoding="utf8") as source:
                value = source.read(8192)
            fields = value[value.rfind(")") + 2:].split()
            if fields[19] != owner["start"]:
                return dict(result, state="replaced")
            with open(f"/proc/{pid}/status", encoding="utf8") as source:
                status = source.read(16384)
            uid_line = next(line for line in status.splitlines() if line.startswith("Uid:"))
            uids = [int(value) for value in uid_line.split()[1:]]
            if len(uids) != 4 or any(uid != owner["uid"] for uid in uids):
                raise RuntimeError("VAULT_PIDFD_UID_MISMATCH")
            if os.readlink(f"/proc/{pid}/exe") != owner["executable"]:
                raise RuntimeError("VAULT_PIDFD_EXECUTABLE_MISMATCH")
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ESRCH) and exited(handle, 0):
                return dict(result, state="exited", exitObservedBy="pidfd_poll")
            raise
        if exited(handle, 0):
            return dict(result, state="exited", exitObservedBy="pidfd_poll")
        if time.monotonic() >= deadline:
            raise RuntimeError("VAULT_PIDFD_BATCH_DEADLINE")
        result["signalMechanism"] = "pidfd_send_signal"
        try:
            for item in (signal.SIGCONT, signal.SIGTERM):
                signal.pidfd_send_signal(handle, item)
                result["signals"].append(item.name)
            if not exited(handle, min(1500, int((deadline - time.monotonic()) * 1000))):
                signal.pidfd_send_signal(handle, signal.SIGKILL)
                result["signals"].append("SIGKILL")
                if not exited(handle, min(1000, int((deadline - time.monotonic()) * 1000))):
                    return result
        except ProcessLookupError:
            if not exited(handle, 0):
                return result
        return dict(result, state="exited", exitObservedBy="pidfd_poll")
    finally:
        os.close(handle)


def main():
    """登记文件以拒绝符号链接的方式打开并核验所有者、私有权限和大小，同一读取快照限定进程与目录数量；缺少 pidfd 支持或身份不完整时只报告失败，不改用数字信号，也不授权删除仍可能被进程使用的目录。"""
    supported = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
    result = {"registryPresent": False, "ownedRoots": [], "observations": [], "errors": [],
              "pidfd": {"supported": supported, "python": sys.version, "kernel": platform.release(),
                        "tool": sys.executable, "uid": os.geteuid(), "batchDeadlineMs": 25000,
                        "termWaitMs": 1500, "killWaitMs": 1000}}
    if len(sys.argv) != 2:
        result["errors"].append("VAULT_PIDFD_ARGUMENT_INVALID")
        return result
    try:
        descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return result
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise RuntimeError("VAULT_PIDFD_REGISTRY_INVALID")
        with os.fdopen(descriptor, "r", encoding="utf8", closefd=False) as source:
            registry = json.loads(source.read(65537))
        roots, owners = registry["roots"], registry["processes"]
        if (not isinstance(roots, list) or len(roots) > 8
                or any(not isinstance(path, str) or len(path) > 4096 for path in roots)
                or not isinstance(owners, list) or len(owners) > 32
                or any(not isinstance(owner, dict) for owner in owners)):
            raise RuntimeError("VAULT_PIDFD_REGISTRY_INVALID")
        result["registryPresent"] = True
        result["ownedRoots"] = roots
        if registry.get("identityIncomplete"):
            result["errors"].append("VAULT_PIDFD_IDENTITY_INCOMPLETE")
        if not supported:
            result["errors"].append("VAULT_PIDFD_UNSUPPORTED")
            return result
        deadline = time.monotonic() + 25
        for owner in reversed(owners):
            try:
                observation = cleanup(owner, deadline)
                result["observations"].append(observation)
                if observation["state"] == "unconfirmed":
                    result["errors"].append("VAULT_PIDFD_EXIT_UNCONFIRMED")
            except OSError as error:
                result["errors"].append(f"VAULT_PIDFD_OS_ERROR_{error.errno}")
            except (RuntimeError, ValueError, IndexError, StopIteration):
                result["errors"].append("VAULT_PIDFD_IDENTITY_OR_STATE_INVALID")
    finally:
        os.close(descriptor)
    return result


try:
    outcome = main()
except (OSError, ValueError, RuntimeError, KeyError, TypeError):
    outcome = {"registryPresent": False, "ownedRoots": [], "observations": [],
               "errors": ["VAULT_PIDFD_HELPER_FAILED"], "pidfd": {"supported": False}}
sys.stdout.write(json.dumps(outcome, ensure_ascii=True) + "\n")
