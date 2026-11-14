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

    def test_source_bound_evidence_is_accepted_before_policy_dispatch(self):
        """当前源码 SHA 必须选择唯一 T20 证据目录，完整主入口通过路径边界后才分派策略准备；测试替换实际策略函数并断言没有外部命令调用，因此这里只证明参数授权边界而不执行本机策略或 GUI。"""
        with tempfile.TemporaryDirectory(prefix="veriq-ci-evidence-") as directory:
            root = Path(directory).resolve()
            source = "a" * 40
            evidence = root / f".superpowers/sdd/veriq-1/evidence/t20/desktop-{source}"
            evidence.mkdir(parents=True)
            with (
                patch.dict(
                    os.environ,
                    {
                        "GITHUB_WORKSPACE": str(root),
                        "GITHUB_SHA": source,
                        "VERIQ_DESKTOP_EVIDENCE": str(evidence),
                    },
                    clear=True,
                ),
                patch.object(
                    ci_userns, "__file__", str(root / "tests/e2e/ci_userns.py")
                ),
                patch.object(ci_userns, "job_identity", return_value="veriq-t19-123-1"),
                patch.object(ci_userns.os, "geteuid", return_value=1000),
                patch.object(ci_userns.sys, "argv", ["ci_userns.py", "prepare"]),
                patch.object(ci_userns, "prepare") as prepare,
                patch.object(ci_userns, "invoke") as invoke,
            ):
                ci_userns.main()
                prepare.assert_called_once_with(root, evidence, "veriq-t19-123-1")
                invoke.assert_not_called()

    def test_evidence_rejects_wrong_sha_legacy_path_and_symlinks(self):
        """证据边界拒绝不完整或错误源码 SHA、历史 T19 目录、父级跳转和任何层级的符号链接；临时目录中只创建本测试拥有的空文件夹，所有失败断言都发生在纯路径函数内而不读取或修改系统策略。"""
        with tempfile.TemporaryDirectory(prefix="veriq-ci-boundary-") as directory:
            root = Path(directory).resolve()
            source = "a" * 40
            evidence = root / f".superpowers/sdd/veriq-1/evidence/t20/desktop-{source}"
            evidence.mkdir(parents=True)
            environment = {
                "GITHUB_SHA": source,
                "VERIQ_DESKTOP_EVIDENCE": str(evidence),
            }
            self.assertEqual(ci_userns.evidence_path(root, environment), evidence)
            for source_value in ["", "a" * 39, "A" * 40, "../candidate", "b" * 40]:
                with self.subTest(source=source_value), self.assertRaises(ValueError):
                    ci_userns.evidence_path(
                        root, {**environment, "GITHUB_SHA": source_value}
                    )
            for path in [
                str(root / ".superpowers/sdd/veriq-1/evidence/t19/fix1/ci"),
                str(evidence) + "/../" + evidence.name,
                str(root),
            ]:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    ci_userns.evidence_path(
                        root, {**environment, "VERIQ_DESKTOP_EVIDENCE": path}
                    )
            evidence.rmdir()
            target = root / "outside"
            target.mkdir()
            evidence.symlink_to(target, target_is_directory=True)
            with self.assertRaises(ValueError):
                ci_userns.evidence_path(root, environment)
            evidence.unlink()
            evidence.parent.rmdir()
            evidence.parent.symlink_to(target, target_is_directory=True)
            (target / evidence.name).mkdir()
            with self.assertRaises(ValueError):
                ci_userns.evidence_path(root, environment)

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

    def test_cookie_copy_requires_exact_path_and_independent_bound_bytes(self):
        """Cookie 策略只接收固定构建目录中经证据绑定的独立副本，并继续核对共享源字节未变；测试用自有小文件模拟身份而不执行 Electron，篡改副本、硬链接和任意外部路径都必须在策略加载前拒绝。"""
        import hashlib

        with tempfile.TemporaryDirectory(prefix="veriq-cookie-copy-") as directory:
            root = Path(directory)
            evidence = root / "evidence"
            evidence.mkdir()
            source = root / "apps/desktop/node_modules/electron/dist/electron"
            selected = root / "apps/desktop/build/electron-cookie/electron"
            source.parent.mkdir(parents=True)
            selected.parent.mkdir(parents=True)
            source.write_bytes(b"original")
            selected.write_bytes(b"modified")
            record = {
                "original": str(source),
                "executable": str(selected),
                "originalSha256": hashlib.sha256(b"original").hexdigest(),
                "modifiedSha256": hashlib.sha256(b"modified").hexdigest(),
                "packageVersion": "45.3.1",
                "toolVersion": "1.8.0",
                "before": {"version": "1", "1": 48},
                "after": {"version": "1", "1": 49},
                "independentCopy": True,
                "sourceUnchanged": True,
            }
            (evidence / "cookie-fuses.json").write_text(json.dumps(record))
            self.assertEqual(ci_userns.cookie_electron(root, evidence), selected)
            selected.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "CI_COOKIE_COPY_INVALID"):
                ci_userns.cookie_electron(root, evidence)
            selected.unlink()
            selected.hardlink_to(source)
            with self.assertRaisesRegex(ValueError, "CI_COOKIE_COPY_INVALID"):
                ci_userns.cookie_electron(root, evidence)
            record["executable"] = str(root / "other/electron")
            (evidence / "cookie-fuses.json").write_text(json.dumps(record))
            with self.assertRaisesRegex(ValueError, "CI_COOKIE_COPY_INVALID"):
                ci_userns.cookie_electron(root, evidence)

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
