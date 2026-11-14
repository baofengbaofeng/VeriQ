"""本机测试只用自己创建的空闲子进程验证 pidfd 的真实退出语义及拒绝边界，绝不把普通进程伪装成已验收 Electron；实际 UI 故障后的恢复、Agent 连续运行与业务停止仍由完整 CI 场景证明。"""

import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import renderer_fault


class RendererFaultBoundaryTests(unittest.TestCase):
    """拒绝测试把发送函数设为可检查的替身，真实 proc/pidfd 仍读取自有子进程；任何前置不符都必须在信号边界前失败，不以测试清理动作充当故障注入成功。"""

    def setUp(self):
        """每例只创建本测试拥有的空闲 Python 子进程和不可执行的身份占位文件，读取真实 UID 与启动时钟作为预期值；拒绝案例随后逐项修改预期并确认目标仍存活，不能使用用户既有进程。"""
        self.directory = tempfile.TemporaryDirectory(prefix="veriq-renderer-fault-")
        self.electron = Path(self.directory.name) / "electron"
        self.electron.write_bytes(b"test identity placeholder, not executable")
        self.child = subprocess.Popen(
            [sys.executable, "-c", "import signal; signal.pause()"]
        )
        self.request = {
            "mainPid": os.getpid(),
            "rendererPid": self.child.pid,
            "uid": os.getuid(),
            "mainStart": renderer_fault.identity(os.getpid())["start"],
            "rendererStart": renderer_fault.identity(self.child.pid)["start"],
            "executable": str(self.electron),
        }

    def tearDown(self):
        """仅在本例子进程仍运行时请求其终止并等待实际退出，然后回收本例临时目录；该收尾独立于用例中的 pidfd 故障及退出断言，不能以清理发送的信号补造正式故障注入或业务停止证明。"""
        if self.child.poll() is None:
            self.child.terminate()
        self.child.wait(timeout=3)
        self.directory.cleanup()

    def test_real_pidfd_signal_and_exit_observation(self):
        """直接验证内核 pidfd 引用确实指向本次创建的进程并能观察 SIGKILL 退出；这只证明故障注入原语，不绕过 helper 身份检查或声称普通子进程等同 Electron renderer。"""
        fd = os.pidfd_open(self.child.pid, 0)
        try:
            renderer_fault.check_fd(fd, self.child.pid)
            signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
            poll = select.poll()
            poll.register(fd, select.POLLIN)
            self.assertTrue(any(flags & select.POLLIN for _, flags in poll.poll(3000)))
            self.assertEqual(self.child.wait(timeout=3), -signal.SIGKILL)
            print(
                f"Owned child pidfd proof: pid={self.child.pid} signal=SIGKILL exit=-9 pidfdPoll=readable",
                flush=True,
            )
            with self.assertRaisesRegex(
                renderer_fault.FaultRejected, "PIDFD_IDENTITY_MISMATCH"
            ):
                renderer_fault.check_fd(fd, self.child.pid)
        finally:
            os.close(fd)

    def test_owner_start_and_executable_mismatches_never_signal(self):
        """主目标相同、错误 UID、过期启动时钟与非 UI 可执行文件必须全部拒绝，发送函数零调用且真实子进程仍存活，防止失败检查后意外继续注入。"""
        cases = [
            ({"mainPid": self.child.pid}, "OWNER_MISMATCH"),
            ({"uid": os.getuid() + 1}, "OWNER_MISMATCH"),
            (
                {"rendererStart": str(int(self.request["rendererStart"]) + 1)},
                "IDENTITY_MISMATCH",
            ),
            (
                {"mainStart": str(int(self.request["mainStart"]) + 1)},
                "IDENTITY_MISMATCH",
            ),
            ({}, "EXECUTABLE_MISMATCH"),
        ]
        for change, code in cases:
            with (
                self.subTest(code=code),
                patch.object(signal, "pidfd_send_signal") as send,
            ):
                with self.assertRaisesRegex(renderer_fault.FaultRejected, code):
                    renderer_fault.inject({**self.request, **change})
                send.assert_not_called()
                self.assertIsNone(self.child.poll())

    def test_ancestry_and_fd_mismatches_never_signal(self):
        """受控替身仅让拒绝路径到达祖先验证，实际子进程及 pidfd 不变且发送函数仍禁止调用；窗口角色已迁至可信 Electron 指标层，这里的假可执行文件身份不用于成功或 UI 恢复声明。"""
        original_resolve = Path.resolve
        original_identity = renderer_fault.identity

        def resolve(path, *args, **kwargs):
            if str(path).startswith("/proc/") and path.name == "exe":
                return self.electron
            return original_resolve(path, *args, **kwargs)

        def wrong_parent(pid):
            result = original_identity(pid)
            return {**result, "parent": 1} if pid == self.child.pid else result

        with (
            patch.object(Path, "resolve", resolve),
            patch.object(signal, "pidfd_send_signal") as send,
        ):
            with patch.object(renderer_fault, "identity", wrong_parent):
                with self.assertRaisesRegex(
                    renderer_fault.FaultRejected, "ANCESTRY_MISMATCH"
                ):
                    renderer_fault.inject(self.request)
            send.assert_not_called()
        fd = os.pidfd_open(self.child.pid, 0)
        try:
            with self.assertRaisesRegex(
                renderer_fault.FaultRejected, "PIDFD_IDENTITY_MISMATCH"
            ):
                renderer_fault.check_fd(fd, os.getpid())
        finally:
            os.close(fd)
        self.assertIsNone(self.child.poll())


if __name__ == "__main__":
    unittest.main()
