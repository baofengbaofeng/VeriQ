"""发行过程的子进程统一在独立进程组内运行，取消信号在构建锁作用域中转为可清理异常；只有组内不再存在可继续写共享状态的进程后才返回，安装探测与 SBOM 调用也使用同一入口。

本模块只面向 Linux 发行构建，不修改全局 subprocess 函数。
阶段监督者使用内核 subreaper，实际回收包含独立 session 的孤儿后代。
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import json
from pathlib import Path
import signal
import subprocess
import time
import sys
from typing import Any

# 发行辅助函数只依赖这个显式运行入口来取得真实退出码与输出，正常独立调用仍可使用 subprocess.run，而持锁构建注入受控进程组实现以覆盖所有直接子进程路径。
RunProcess = Callable[..., subprocess.CompletedProcess[Any]]


class BuildCancelled(RuntimeError):
    """取消是构建失败而非正常完成，携带原始 TERM 或 INT 信号供命令记录与入口诊断使用；它只能在进程清理和锁释放顺序得到保证后向调用方传播，不能写出成功发行标志。

    第二次信号只更新取消状态，不能打断已经开始的后代清理。
    """


class ReleaseProcesses:
    """记录构建创建的每个进程组并提供与当前发行辅助函数兼容的运行入口，避免只保护顶层命令而遗漏安装、库存导出或 SBOM 子进程；调用方必须在持有构建锁时进入信号作用域。

    不采用全局 Popen 替换，因此其它调用方及测试进程不受影响。
    每个阶段的监督者只收养自己的后代，不枚举或终止调用方的其它子进程。
    """

    def __init__(self, evidence: Path, lock_fd: int) -> None:
        """每次构建只创建一个记录器，证据路径属于该构建的唯一运行目录；活动进程引用只在实际 Popen 成功后登记，启动期间收到信号先记账，避免子进程创建与登记间出现逃逸窗口。

        输出只包含 argv、cwd 和公开进程状态，不记录环境变量或标准输入。
        """
        self.evidence = evidence
        self.lock_fd = lock_fd
        self.state: Path | None = None
        self.command_exit: int | None = None
        self.records: list[dict[str, Any]] = []
        self.active: subprocess.Popen[Any] | None = None
        self.cancel_signal: int | None = None
        self.spawning = False
        self.cleaning = False

    def cancel(self, number: int, frame: Any) -> None:
        """TERM 与 INT 在整个持锁区间使用同一个取消路径，启动或清理的不可分割窗口只记录信号；其它时候立即抛出取消异常，使同步文件处理和正在等待的子进程都停止后续发行步骤。

        信号处理器不直接等待进程，具体回收由运行入口和外层作用域完成。
        """
        if self.cancel_signal is None:
            self.cancel_signal = number
        if not self.spawning and not self.cleaning:
            raise BuildCancelled(f"Build cancelled by signal {self.cancel_signal}")

    def stop(self) -> None:
        """取消时只通知阶段监督者，等待它收养并回收独立 session 后代后检查完整退出证明；监督者继承同一构建锁描述符，外层不会在十秒宽限届满时杀死监督者而遗失浏览器后代。

        监督者异常退出且缺少证明时写隔离标记，后续构建在任何工具启动前拒绝。
        正常退出码来自实际命令，监督者本身的退出码另行保留。
        """
        self.cleaning = True
        process = self.active
        if process is None:
            return
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        process.wait()
        self.active = None
        try:
            proof = json.loads(self.state.read_bytes()) if self.state else {}
            if proof.get("treeStopped") is not True:
                raise ValueError("Missing descendant completion proof")
            self.command_exit = proof["leaderExitCode"]
            if self.cancel_signal is None and proof.get("cancelSignal") is not None:
                self.cancel_signal = proof["cancelSignal"]
        except (OSError, ValueError, KeyError, TypeError):
            (self.evidence.parent / "build-unsafe.json").write_text(
                json.dumps(
                    {
                        "reason": "Stage supervisor lost without descendant completion proof",
                        "run": str(self.evidence),
                        "supervisorPid": process.pid,
                    }
                )
                + "\n"
            )
            raise RuntimeError(
                "Release supervisor failed; build state quarantined"
            ) from None

    def run(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        """以参数数组启动真实命令并在独立组内等待结果，兼容现有辅助函数需要的捕获输出与检查选项；成功、非零退出及取消均持久记录，任何异常都先终止整组后代再交回调用方。

        Popen 创建期间的信号延迟到活动引用登记后处理。
        即使直接子进程正常返回，监督者也回收它留下的独立 session 后代。
        """
        self.cleaning = False
        check = kwargs.pop("check", False)
        if kwargs.pop("capture_output", False):
            kwargs["stdout"] = subprocess.PIPE
            kwargs["stderr"] = subprocess.PIPE
        started = time.time()
        process = None
        failed = False
        self.command_exit = None
        self.state = self.evidence / f"child-{len(self.records)}.json"
        try:
            self.spawning = True
            try:
                process = subprocess.Popen(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("release_child.py")),
                        str(self.state),
                        *argv,
                    ],
                    start_new_session=True,
                    pass_fds=(self.lock_fd,),
                    **kwargs,
                )
                self.active = process
            finally:
                self.spawning = False
            if self.cancel_signal is not None:
                raise BuildCancelled(f"Build cancelled by signal {self.cancel_signal}")
            stdout, stderr = process.communicate()
            self.stop()
            result = subprocess.CompletedProcess(
                argv,
                self.command_exit
                if self.command_exit is not None
                else process.returncode,
                stdout,
                stderr,
            )
            if self.cancel_signal is not None:
                raise BuildCancelled(f"Build cancelled by signal {self.cancel_signal}")
            if check:
                result.check_returncode()
            return result
        except BaseException:
            failed = True
            self.stop()
            raise
        finally:
            self.cleaning = True
            for stream in (
                (process.stdout, process.stderr, process.stdin) if process else ()
            ):
                if stream is not None:
                    stream.close()
            self.records.append(
                {
                    "argv": argv,
                    "processGroup": process.pid if process else None,
                    "cwd": str(kwargs.get("cwd", Path.cwd())),
                    "started": started,
                    "finished": time.time(),
                    "exitCode": self.command_exit,
                    "supervisorExitCode": process.returncode if process else None,
                    "failed": failed
                    or (process is not None and process.returncode not in {None, 0}),
                    "cancelled": self.cancel_signal is not None,
                    "signal": self.cancel_signal,
                }
            )
            (self.evidence / "processes.json").write_text(
                json.dumps(self.records, indent=2) + "\n"
            )
            self.cleaning = failed or self.cancel_signal is not None
            if self.cancel_signal is not None and not failed:
                raise BuildCancelled(f"Build cancelled by signal {self.cancel_signal}")


@contextmanager
def process_scope(evidence: Path, lock_fd: int) -> Iterator[ReleaseProcesses]:
    """在调用方已经持有构建锁的范围内安装 TERM 与 INT 处理器，并在退出前停止所有自有活动进程后恢复原处理器；辅助函数只接收显式 runner，不依赖全局替换或未受控的后台回收线程。

    锁由外层上下文持有，因此 finally 的实际退出检查发生在锁释放之前。
    """
    managed = ReleaseProcesses(evidence, lock_fd)
    previous = {
        number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        for number in previous:
            signal.signal(number, managed.cancel)
        yield managed
    finally:
        try:
            managed.stop()
            if managed.cancel_signal is not None:
                (evidence / "cancellation.json").write_text(
                    json.dumps(
                        {
                            "cancelled": True,
                            "signal": managed.cancel_signal,
                            "activeProcessGroup": None,
                            "finished": time.time(),
                        }
                    )
                    + "\n"
                )
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
