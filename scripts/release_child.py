"""每个发行阶段使用独立 Linux 子监督进程收养其孤儿后代，覆盖 Playwright 浏览器另起 session 的实际路径；只有 waitpid 确认没有任何子进程后才写完成证明并退出，继承的构建锁在此之前保持有效。

本进程不属于产品运行时，也不改变调用方的全局 subreaper 属性。
实际命令继承原环境、工作目录和标准流，不能继承构建锁描述符。
"""

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def _children() -> list[int]:
    """按内核记录的 PPID 枚举当前监督者的直接子进程，独立 session 的孤儿同样会被 subreaper 收养；单线程仅在下一轮 waitpid 才回收这些 PID，因此本轮投递信号不会误中复用后的无关进程。

    不依赖可选的 proc children 文件，也不按名称或原进程组猜测归属。
    """
    result = []
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(") ", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(fields[1]) == os.getpid():
            result.append(int(path.parent.name))
    return result


def supervise(argv: list[str], state: Path) -> int:
    """安装仅记录取消的信号处理器后启用内核 subreaper，再启动唯一阶段命令；取消或首进程退出后清理全部被收养后代，十秒后升级 KILL 但永不通过杀监督者来假装子树已经停止。

    ECHILD 是完成的唯一依据，僵尸由本监督者实际回收。
    失败诊断使用英文，未知清理状态不写 treeStopped 成功证明。
    """
    requested: int | None = None

    def cancel(number: int, frame: object) -> None:
        """监督者收到 TERM 或 INT 后只记录首次信号并继续履行后代回收职责，不能随首进程一起退出；重复信号也不打断等待，因此外层保留的锁始终覆盖仍可写共享状态的后代。

        清理与宽限升级在单线程主循环执行，不在信号处理器中发起复杂操作。
        """
        nonlocal requested
        if requested is None:
            requested = number

    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, cancel)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot establish release child subreaper")
    leader = subprocess.Popen(argv, close_fds=True)
    leader_code: int | None = None
    deadline: float | None = None
    signalled: set[tuple[int, int]] = set()
    reaped = 0
    diagnostics = False
    while True:
        empty = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                empty = True
                break
            if pid == 0:
                break
            reaped += 1
            signalled = {item for item in signalled if item[0] != pid}
            if pid == leader.pid:
                leader_code = os.waitstatus_to_exitcode(status)
                leader.returncode = leader_code
        if empty:
            state.write_text(
                json.dumps(
                    {
                        "treeStopped": True,
                        "leaderExitCode": leader_code,
                        "cancelSignal": requested,
                        "reapedChildren": reaped,
                        "finished": time.time(),
                    }
                )
                + "\n"
            )
            if requested is not None:
                return 128 + requested
            if leader_code is None:
                return 125
            return leader_code if leader_code >= 0 else 128 - leader_code
        if requested is not None or leader_code is not None:
            if deadline is None:
                deadline = time.monotonic() + 10
            number = signal.SIGKILL if time.monotonic() >= deadline else signal.SIGTERM
            try:
                for child in _children():
                    if (child, number) not in signalled:
                        try:
                            os.kill(child, number)
                        except ProcessLookupError:
                            pass
                        signalled.add((child, number))
            except OSError:
                if not diagnostics:
                    print(
                        "Release descendant inspection failed; retaining build lock",
                        file=sys.stderr,
                    )
                    diagnostics = True
        time.sleep(0.01)


if __name__ == "__main__":
    try:
        raise SystemExit(supervise(sys.argv[2:], Path(sys.argv[1])))
    except (OSError, ValueError, IndexError):
        print(
            "Release supervisor failed without a complete descendant proof",
            file=sys.stderr,
        )
        raise SystemExit(125)
