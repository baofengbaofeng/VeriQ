"""本辅助器只在 Linux 的一次性测试进程内成为 subreaper，Node 驱动仍保留真正 CLI 的 ChildProcess；辅助器仅确认孤儿测试对象仍活并通过 pidfd 结束及实际回收，不改变宿主或产品进程策略。

驱动标准输出只传固定结构事实和本测试子对象编号，不传 argv、环境或日志原文。
成功路径先确认驱动退出，再检查本进程已收养的精确测试对象，避免把不同进程当成持有对象。
异常路径仅以 waitpid 回收自己的子对象，最多三个对象，未知句柄等待独立看门狗结束。
测试子对象还具有独立短期自退出看门狗，避免测试驱动崩溃时永久遗留进程。
"""

import ctypes
import json
import os
import signal
import subprocess
import sys
import time


def finish_owned() -> None:
    """异常清理只用 waitpid 等待辅助器自己的真实子对象，未知身份不发送信号而等待测试子对象的独立看门狗；期限与对象数共同限制回收范围，不依赖系统进程表或裸 PID 猜测。

    waitpid 返回的真实退出是清理证据，信号函数返回或 pidfd 成功打开都不等同退出。
    """
    deadline = time.monotonic() + 12
    count = 0
    while True:
        try:
            waited, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if waited:
            count += 1
            if count > 3:
                raise RuntimeError("OWNER_CHILD_LIMIT")
        if time.monotonic() > deadline:
            raise RuntimeError("OWNER_CLEANUP_TIMEOUT")
        if not waited:
            time.sleep(0.01)


libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "SUBREAPER_UNAVAILABLE")
driver = None
try:
    driver = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stdout, stderr = driver.communicate(timeout=8)
    if driver.returncode != 0:
        raise RuntimeError("OWNER_DRIVER_FAILED")
    result = json.loads(stdout)
    target = result["fixturePid"]
    if result["cliCode"] != 73 or result["verified"] is not False:
        raise RuntimeError("OWNER_FACTS_INVALID")
    handle = os.pidfd_open(target)
    try:
        waited, _ = os.waitpid(target, os.WNOHANG)
        if waited != 0:
            raise RuntimeError("FIXTURE_NOT_ALIVE_AFTER_CLI_EXIT")
        signal.pidfd_send_signal(handle, signal.SIGTERM)
        waited, status = os.waitpid(target, 0)
        if waited != target or not os.WIFSIGNALED(status) or os.WTERMSIG(status) != signal.SIGTERM:
            raise RuntimeError("FIXTURE_EXIT_NOT_OBSERVED")
    finally:
        os.close(handle)
    print(json.dumps({"cliCode": 73, "verified": False, "aliveAfterCliExit": True, "reaped": True}))
finally:
    if driver is not None and driver.poll() is None:
        driver.kill()
        driver.wait(timeout=3)
    finish_owned()
