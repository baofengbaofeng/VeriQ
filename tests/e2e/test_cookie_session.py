"""私有 Cookie 验收会话的进程清理必须通过真实新建子进程和内核句柄测试，确认失败不能把未知 PID 当自有服务终止；这些本机测试不启动密钥库、不接触用户会话，也不替代目标 Ubuntu 的实际加密与守护进程清理验收。"""

import os
import signal
import sys
import unittest

from cookie_session import OwnedProcess


class CookieSessionProcessTests(unittest.TestCase):
    """每个测试只创建一个当前 Python 的管道等待子进程，并观察其实际退出和记录身份；finally 始终收回仍存活的自有子进程，测试失败不能遗留后台任务或把发送终止信号直接报告成已退出。"""

    def test_owned_child_cleanup_waits_for_actual_exit(self):
        """进程返回就绪后一直等待标准输入，只有清理路径使用已绑定的 pidfd 发信号才会停止；断言要求真实 wait 结果和关闭后的身份记录，防止把请求已发出或同名进程不存在误作当前子进程退出证据。"""
        child = OwnedProcess(
            [
                sys.executable,
                "-c",
                "import sys; print('ready', flush=True); sys.stdin.read()",
            ],
            dict(os.environ),
        )
        try:
            self.assertEqual(child.line(5), "ready")
            self.assertIsNone(child.process.poll())
            child.stop()
            self.assertEqual(child.process.returncode, -signal.SIGTERM)
            self.assertTrue(child.record()["exited"])
            child.stop()
        finally:
            child.stop()

    def test_wrong_creation_identity_cannot_authorize_a_signal(self):
        """即使持有当前子进程句柄，错误的创建身份也不能被静默当作已授权记录；测试先故意改变记录并确认进程仍在，再恢复原记录执行真实清理，确保拒绝路径不会误杀其它 PID 或遗漏自身资源。"""
        child = OwnedProcess(
            [
                sys.executable,
                "-c",
                "import sys; print('ready', flush=True); sys.stdin.read()",
            ],
            dict(os.environ),
        )
        original = dict(child.identity)
        try:
            self.assertEqual(child.line(5), "ready")
            child.identity["start"] = "invalid"
            with self.assertRaisesRegex(ValueError, "COOKIE_FIXTURE_IDENTITY_CHANGED"):
                child.stop()
            self.assertIsNone(child.process.poll())
        finally:
            child.identity = original
            child.stop()


if __name__ == "__main__":
    unittest.main()
