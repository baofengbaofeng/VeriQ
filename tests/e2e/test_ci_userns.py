"""CI 策略辅助器的本机测试只覆盖上下文、精确路径和受控清理命令边界，不加载 AppArmor、不写内核配置；真实策略能力必须由 GitHub-hosted job 留证，模拟命令只用于证明部分失败时不会扩大清理目标或吞错。"""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ci_userns


class CiUsernsBoundaryTests(unittest.TestCase):
    """测试夹具使用自有临时文件保存意图与诊断，sudo 和内核观察在需要时有明确替身；普通本机入口必须在命令边界前被拒绝，因此这些通过结果不表示宿主已启用 userns 或实际浏览器已成功启动。"""

    def test_local_entry_and_self_hosted_context_are_rejected(self):
        """没有官方托管上下文的正常本机入口必须在任何 sudo 前失败，自托管值和错误发行版也不能借工作流名字通过检查；唯一成功分支只计算本 job 名称，并不执行安装或能力探测。"""
        environment = {
            "GITHUB_ACTIONS": "true",
            "VERIQ_CI_RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux",
            "GITHUB_JOB": "ubuntu-desktop",
            "GITHUB_WORKFLOW": "Desktop focused verification",
            "GITHUB_RUN_ID": "99999999999999",
            "GITHUB_RUN_ATTEMPT": "1",
        }
        release = {"ID": "ubuntu", "VERSION_ID": "24.04"}
        self.assertEqual(
            ci_userns.job_identity(environment, release), "veriq-t19-99999999999999-1"
        )
        for key, value in [
            ("VERIQ_CI_RUNNER_ENVIRONMENT", "self-hosted"),
            ("GITHUB_ACTIONS", "false"),
            ("GITHUB_RUN_ID", "../other"),
        ]:
            with self.assertRaises(ValueError):
                ci_userns.job_identity({**environment, key: value}, release)
        with self.assertRaisesRegex(ValueError, "CI_UBUNTU_2404_REQUIRED"):
            ci_userns.job_identity(environment, {"ID": "debian", "VERSION_ID": "13"})
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(ci_userns, "invoke") as command,
        ):
            with self.assertRaisesRegex(ValueError, "CI_HOSTED_CONTEXT_REQUIRED"):
                ci_userns.main()
            command.assert_not_called()

    def test_profile_paths_and_root_owned_file_identity_fail_closed(self):
        """精确路径不能接受 AppArmor 通配、变量、引号、控制字符或父级跳转，当前普通用户创建的同名字节也不构成 root 策略所有权；测试只读取真实临时文件，不尝试改变本机文件属主来制造通过。"""
        name = "veriq-t19-99999999999999-1-electron"
        text = ci_userns.profile_text(
            name, "/job/node_modules/.pnpm/electron@45.3.1/dist/electron"
        )
        self.assertIn(
            "profile "
            + name
            + ' "/job/node_modules/.pnpm/electron@45.3.1/dist/electron"',
            text,
        )
        self.assertEqual(text.count("userns,"), 1)
        for value in [
            "relative",
            "/job/**/chrome",
            "/job/{one,two}/chrome",
            "/job/@{HOME}/chrome",
            '/job/"chrome',
            "/job/chrome\n",
            "/job/../chrome",
        ]:
            with self.assertRaisesRegex(ValueError, "CI_PROFILE_PATH_INVALID"):
                ci_userns.profile_text(name, value)
        with tempfile.TemporaryDirectory(prefix="veriq-policy-file-") as directory:
            path = Path(directory) / "profile"
            self.assertFalse(ci_userns.owned_file(path, text))
            path.write_text(text)
            with self.assertRaisesRegex(ValueError, "CI_PROFILE_OWNERSHIP_MISMATCH"):
                ci_userns.owned_file(path, text)

    def test_partial_install_drains_only_owned_entries_and_keeps_failure_visible(self):
        """受控状态表示第一份策略已加载、第二份只有文件、第三份未安装，清理必须仅对实际加载者发卸载命令并收回两份自有文件；卸载失败时继续其它条目但最终返回失败，不能强删仍加载的策略后假称已完成。"""
        stem = "veriq-t19-99999999999999-1"
        baseline = {
            "limits": {"restriction": "1"},
            "apparmorEnabled": "Y",
            "label": "unconfined",
            "profiles": ["unrelated (enforce)"],
        }
        for fail in [False, True]:
            with (
                self.subTest(fail=fail),
                tempfile.TemporaryDirectory(
                    prefix="veriq-policy-cleanup-"
                ) as directory,
            ):
                evidence = Path(directory)
                loaded = {f"{stem}-electron"}
                files = {f"{stem}-electron", f"{stem}-shell"}
                commands = []
                state = {
                    "stem": stem,
                    "before": baseline,
                    "parser": "/usr/sbin/apparmor_parser",
                    "binaries": {
                        kind: {"realpath": f"/job/{kind}"} for kind in ci_userns.KINDS
                    },
                }
                (evidence / "userns-state.json").write_text(json.dumps(state))

                def observe(_evidence):
                    """该替身只报告当前受控集合及不变的限制值，不伪造真正内核状态；实际卸载命令是否触及无关名字由下面的命令记录和固定参数断言决定，最终失败仍由生产清理逻辑抛出。"""
                    return {
                        **baseline,
                        "profiles": baseline["profiles"]
                        + [name + " (unconfined)" for name in sorted(loaded)],
                    }

                def command(_evidence, arguments):
                    """命令边界记录生产逻辑选择的精确目标，并只更新本测试拥有的集合以表示成功或受控卸载失败；这里绝不执行 sudo，也不会向真实系统安装、卸载或删除任何 AppArmor 策略。"""
                    commands.append(arguments)
                    name = Path(arguments[-1]).name
                    self.assertIn(name, {f"{stem}-{kind}" for kind in ci_userns.KINDS})
                    self.assertEqual(
                        Path(arguments[-1]).parent, Path("/etc/apparmor.d")
                    )
                    if arguments[2] == "/usr/sbin/apparmor_parser":
                        self.assertEqual(arguments[3:5], ["--skip-cache", "-R"])
                        if fail:
                            raise RuntimeError("CONTROLLED_UNLOAD_FAILURE")
                        loaded.remove(name)
                    else:
                        self.assertEqual(arguments[2:4], ["rm", "--"])
                        files.remove(name)

                with (
                    patch.object(ci_userns, "snapshot", observe),
                    patch.object(ci_userns, "invoke", command),
                    patch.object(
                        ci_userns, "owned_file", lambda path, _text: path.name in files
                    ),
                ):
                    if fail:
                        with self.assertRaisesRegex(
                            ValueError, "CI_PROFILE_CLEANUP_FAILED"
                        ):
                            ci_userns.cleanup(evidence, stem)
                    else:
                        ci_userns.cleanup(evidence, stem)
                result = json.loads((evidence / "userns-cleanup.json").read_bytes())
                self.assertEqual(result["globalRestrictionsUnchanged"], True)
                self.assertEqual(result["status"], "FAILED" if fail else "REMOVED")
                self.assertNotIn(f"{stem}-shell", files)
                self.assertEqual(loaded, {f"{stem}-electron"} if fail else set())
                self.assertEqual(len(commands), 2 if fail else 3)


if __name__ == "__main__":
    unittest.main()
