"""PowerShell 解析子进程以独立进程组或 Windows Job 管理生命周期，普通文件承接输出以消除继承管道等待 EOF 的风险。"""

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Any


class ProcessBudgetError(ValueError):
    """进程管理只提供固定错误类别，任何操作系统路径和进程输出都不得通过异常正文进入正式注释审计日志。"""

    def __init__(self, category: str, cleanup_complete: bool = True) -> None:
        self.cleanup_complete = cleanup_complete
        super().__init__(category)


class WindowsJob:
    """Windows 运行时先暂停启动，再加入禁止脱离且关闭即终止的 Job，恢复初始线程前不允许未知程序创建逃逸子进程。"""

    def __init__(self) -> None:
        self.api: Any = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)
        self.handle: Any = None
        for name, args, result in (
            ("CreateJobObjectW", [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            (
                "SetInformationJobObject",
                [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
                wintypes.BOOL,
            ),
            (
                "QueryInformationJobObject",
                [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p],
                wintypes.BOOL,
            ),
            ("AssignProcessToJobObject", [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            ("TerminateJobObject", [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            ("OpenProcess", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ("OpenThread", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ("CreateToolhelp32Snapshot", [wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            ("Thread32First", [wintypes.HANDLE, ctypes.c_void_p], wintypes.BOOL),
            ("Thread32Next", [wintypes.HANDLE, ctypes.c_void_p], wintypes.BOOL),
            ("ResumeThread", [wintypes.HANDLE], wintypes.DWORD),
            ("CloseHandle", [wintypes.HANDLE], wintypes.BOOL),
        ):
            method = getattr(self.api, name)
            method.argtypes, method.restype = args, result
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ProcessBudgetError("PowerShell process isolation failed")

        # Windows Job 的完整扩展限制结构仅设置 KILL_ON_JOB_CLOSE，工作集等未指定限制须保持零值。
        BasicLimits = type(
            "BasicLimits",
            (ctypes.Structure,),
            {
                "_fields_": [
                    ("times", ctypes.c_int64 * 2),
                    ("flags", wintypes.DWORD),
                    ("working_sets", ctypes.c_size_t * 2),
                    ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t),
                    ("classes", wintypes.DWORD * 2),
                ]
            },
        )

        ExtendedLimits = type(
            "ExtendedLimits",
            (ctypes.Structure,),
            {
                "_fields_": [
                    ("basic", BasicLimits),
                    ("io", ctypes.c_uint64 * 6),
                    ("memory", ctypes.c_size_t * 4),
                ]
            },
        )

        limits = ExtendedLimits()
        limits.basic.flags = 0x2000
        if not self.api.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            self.close()
            raise ProcessBudgetError("PowerShell process isolation failed")

    def attach(self, process: subprocess.Popen[bytes]) -> None:
        """只对尚未恢复的进程分配 Job，分配失败时由调用者终止暂停的直接子进程，不能带着不完整的进程隔离继续解析。"""
        handle = self.api.OpenProcess(0x1101, False, process.pid)
        if not handle:
            raise ProcessBudgetError("PowerShell process isolation failed")
        try:
            if not self.api.AssignProcessToJobObject(self.handle, handle):
                raise ProcessBudgetError("PowerShell process isolation failed")
        finally:
            self.api.CloseHandle(handle)
        self._resume(process.pid)

    def _resume(self, pid: int) -> None:
        """通过官方线程快照与 ResumeThread 恢复初始线程，进程创建时已暂停，因此枚举期间不会出现创建子进程的竞争。"""

        Entry = type(
            "Entry",
            (ctypes.Structure,),
            {
                "_fields_": [
                    ("size", wintypes.DWORD),
                    ("usage", wintypes.DWORD),
                    ("thread", wintypes.DWORD),
                    ("owner", wintypes.DWORD),
                    ("base", wintypes.LONG),
                    ("delta", wintypes.LONG),
                    ("flags", wintypes.DWORD),
                ]
            },
        )

        snapshot = self.api.CreateToolhelp32Snapshot(4, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise ProcessBudgetError("PowerShell process isolation failed")
        try:
            entry = Entry(ctypes.sizeof(Entry))
            more = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while more:
                if entry.owner == pid:
                    thread = self.api.OpenThread(2, False, entry.thread)
                    if not thread:
                        break
                    try:
                        if self.api.ResumeThread(thread) != 0xFFFFFFFF:
                            return
                    finally:
                        self.api.CloseHandle(thread)
                    break
                more = self.api.Thread32Next(snapshot, ctypes.byref(entry))
        finally:
            self.api.CloseHandle(snapshot)
        raise ProcessBudgetError("PowerShell process isolation failed")

    def terminate(self) -> None:
        """终止 Job 覆盖父进程退出后仍存活的成员，保留句柄直到活动计数归零，避免把异步终止误认为已完成回收。"""
        if self.handle and not self.api.TerminateJobObject(self.handle, 1):
            raise ProcessBudgetError("PowerShell process isolation failed")

    def active(self) -> int:
        """官方 Job 基础记账结构提供活动成员数量，读取失败即拒绝清理成功结论，不能在后代仍持有文件时发布解析结果。"""
        accounting = type(
            "Accounting",
            (ctypes.Structure,),
            {
                "_fields_": [
                    ("times", ctypes.c_int64 * 4),
                    ("faults", wintypes.DWORD),
                    ("total", wintypes.DWORD),
                    ("active", wintypes.DWORD),
                    ("terminated", wintypes.DWORD),
                ]
            },
        )()
        if not self.api.QueryInformationJobObject(
            self.handle, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None
        ):
            raise ProcessBudgetError("PowerShell process isolation failed")
        return int(accounting.active)

    def close(self) -> None:
        """关闭带 KILL_ON_JOB_CLOSE 的句柄再次保证剩余成员不能存活，关闭不读取输出或等待任何继承文件句柄产生 EOF。"""
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def _posix_group_active(pgid: int, directory: Path, deadline: float) -> bool:
    """POSIX 组信号之后区分存活成员与已无文件句柄的僵尸，系统进程清单只读入固定预算且查询也受同一个截止时间限制。"""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    with (directory / "group-state").open("w+b") as state:
        result = subprocess.run(
            ["/bin/ps", "-axo", "pgid=,stat="],
            stdout=state,
            stderr=subprocess.DEVNULL,
            timeout=max(0, deadline - time.monotonic()),
            check=False,
        )
        state.seek(0)
        raw = state.read(1024 * 1024 + 1)
    if result.returncode or len(raw) > 1024 * 1024:
        raise ProcessBudgetError("PowerShell process isolation failed")
    for row in raw.splitlines():
        fields = row.split()
        if len(fields) != 2 or not fields[0].isdigit():
            raise ProcessBudgetError("PowerShell process isolation failed")
        if int(fields[0]) == pgid and not fields[1].startswith(b"Z"):
            return True
    return False


def _stop(
    process: subprocess.Popen[bytes], job: WindowsJob | None, directory: Path, deadline: float
) -> None:
    """回收与解析共享期限；只有确认直接进程退出且组内无存活成员才允许删除输出文件，无法确认时保留临时目录并整份失败。"""
    try:
        try:
            if job:
                job.terminate()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        finally:
            if process.poll() is None:
                process.kill()
        process.wait(timeout=max(0, deadline - time.monotonic()))
        while job.active() if job else _posix_group_active(process.pid, directory, deadline):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProcessBudgetError("PowerShell parser cleanup timeout")
            if not job:
                os.killpg(process.pid, signal.SIGKILL)
            time.sleep(min(0.01, remaining))
    except (OSError, subprocess.TimeoutExpired, ProcessBudgetError):
        raise ProcessBudgetError(
            "PowerShell parser cleanup unconfirmed", cleanup_complete=False
        ) from None
    finally:
        if job:
            job.close()


def _launch(
    arguments: list[str], stdout: Any, stderr: Any, windows: bool
) -> subprocess.Popen[bytes]:
    """直接移交显式管理的进程所有权，拒绝 Popen 上下文隐式无期限等待；Windows 的暂停标志须在任何程序代码执行前生效。"""
    return subprocess.Popen(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        start_new_session=not windows,
        creationflags=4 if windows else 0,
    )


def run_parser(arguments: list[str], directory: Path, timeout: float, limit: int) -> bytes:
    """进程启动、输出及回收共享单调时钟期限，输出落入普通文件后读取固定上限，消除管道线程和上下文退出的隐式等待。"""
    deadline = time.monotonic() + timeout
    reserve = min(0.25, timeout / 10)
    job = WindowsJob() if os.name == "nt" else None
    process: subprocess.Popen[bytes] | None = None
    stopped = False
    try:
        with (
            (directory / "stdout").open("w+b") as stdout,
            (directory / "stderr").open("w+b") as stderr,
        ):
            if time.monotonic() + 0.005 >= deadline:
                raise ProcessBudgetError("PowerShell parser timeout")
            process = _launch(arguments, stdout, stderr, job is not None)
            if job:
                job.attach(process)
            while True:
                if (
                    os.fstat(stdout.fileno()).st_size > limit
                    or os.fstat(stderr.fileno()).st_size > limit
                ):
                    raise ProcessBudgetError("PowerShell output budget exceeded")
                remaining = deadline - reserve - time.monotonic()
                if remaining <= 0:
                    raise ProcessBudgetError("PowerShell parser timeout")
                if process.poll() is not None:
                    break
                time.sleep(min(0.01, remaining))
            stopped = True
            _stop(process, job, directory, deadline)
            stdout.seek(0)
            stderr.seek(0)
            output, errors = stdout.read(limit + 1), stderr.read(limit + 1)
            if len(output) > limit or len(errors) > limit:
                raise ProcessBudgetError("PowerShell output budget exceeded")
            if time.monotonic() >= deadline:
                raise ProcessBudgetError("PowerShell parser timeout")
            if process.returncode or errors:
                raise ProcessBudgetError("PowerShell parser failed")
            return output
    finally:
        if process and not stopped:
            stopped = True
            _stop(process, job, directory, deadline)
        elif job:
            job.close()
