"""CI 策略辅助器的本机测试只覆盖上下文、精确路径和受控清理命令边界，不加载 AppArmor、不写内核配置；真实策略能力必须由
GitHub-hosted job 留证，模拟命令只用于证明部分失败时不会扩大清理目标或吞错。
"""

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ci_userns


class CiUsernsBoundaryTests(unittest.TestCase):
    """测试夹具使用自有临时文件保存意图与诊断，sudo 和内核观察在需要时有明确替身；普通本机入口必须在命令边界前被拒绝，
    因此这些通过结果不表示宿主已启用 userns 或实际浏览器已成功启动。
    """

    def test_local_entry_and_self_hosted_context_are_rejected(self):
        """没有官方托管上下文的正常本机入口必须在任何 sudo 前失败，自托管值和错误发行版也不能借工作流名字通过检查；
        唯一成功分支只计算本 job 名称，并不执行安装或能力探测。
        """
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
        self.assertEqual(ci_userns.job_identity(environment, release), "veriq-t19-99999999999999-1")
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
            patch.object(ci_userns.platform, "freedesktop_os_release", return_value=release),
            patch.object(ci_userns, "invoke") as command,
        ):
            with self.assertRaisesRegex(ValueError, "CI_HOSTED_CONTEXT_REQUIRED"):
                ci_userns.main()
            command.assert_not_called()

    def test_source_bound_evidence_is_accepted_before_policy_dispatch(self):
        """当前源码 SHA 必须选择唯一 T20 证据目录，完整主入口通过路径边界后才分派策略准备；测试替换实际策略函数并断言没
        有外部命令调用，因此这里只证明参数授权边界而不执行本机策略或 GUI。
        """
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
                patch.object(ci_userns, "__file__", str(root / "tests/e2e/ci_userns.py")),
                patch.object(ci_userns, "job_identity", return_value="veriq-t19-123-1"),
                patch.object(
                    ci_userns.platform,
                    "freedesktop_os_release",
                    return_value={"ID": "ubuntu", "VERSION_ID": "24.04"},
                ),
                patch.object(ci_userns.os, "geteuid", return_value=1000),
                patch.object(ci_userns.sys, "argv", ["ci_userns.py", "prepare"]),
                patch.object(ci_userns, "prepare") as prepare,
                patch.object(ci_userns, "invoke") as invoke,
            ):
                ci_userns.main()
                prepare.assert_called_once_with(root, evidence, "veriq-t19-123-1")
                invoke.assert_not_called()

    def test_evidence_rejects_wrong_sha_legacy_path_and_symlinks(self):
        """证据边界拒绝不完整或错误源码 SHA、历史 T19 目录、父级跳转和任何层级的符号链接；临时目录中只创建本测试拥有的空
        文件夹，所有失败断言都发生在纯路径函数内而不读取或修改系统策略。
        """
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
                    ci_userns.evidence_path(root, {**environment, "GITHUB_SHA": source_value})
            for path in [
                str(root / ".superpowers/sdd/veriq-1/evidence/t19/fix1/ci"),
                str(evidence) + "/../" + evidence.name,
                str(root),
            ]:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    ci_userns.evidence_path(root, {**environment, "VERIQ_DESKTOP_EVIDENCE": path})
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
        """精确路径不能接受 AppArmor 通配、变量、引号、控制字符或父级跳转，当前普通用户创建的同名字节也不构成 root
        策略所有权；测试只读取真实临时文件，不尝试改变本机文件属主来制造通过。
        """
        name = "veriq-t19-99999999999999-1-electron"
        text = ci_userns.profile_text(name, "/job/node_modules/.pnpm/electron@45.3.1/dist/electron")
        self.assertIn(
            "profile " + name + ' "/job/node_modules/.pnpm/electron@45.3.1/dist/electron"',
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
        """Cookie 策略只接收固定构建目录中经证据绑定的独立副本，并继续核对共享源字节未变；测试用自有小文件模拟身份而不执
        行 Electron，篡改副本、硬链接和任意外部路径都必须在策略加载前拒绝。
        """

        with tempfile.TemporaryDirectory(prefix="veriq-cookie-copy-") as directory:
            root = Path(directory).resolve()
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

    def test_policy_bytes_reject_crlf_and_cr_even_with_trusted_metadata(self):
        """策略字节核验不能通过文本换行归一化接受不同内容，本例只替换 root 元数据观察而读取临时文件；LF 字节可通过，
        CRLF 与 CR 改写必须失败，不在本机执行 chown 或触碰真实策略文件。
        """
        text = ci_userns.profile_text("veriq-t20-server-12345-2-shell", "/job/shell", "server")
        with tempfile.TemporaryDirectory(prefix="veriq-policy-bytes-") as directory:
            path = Path(directory) / "profile"
            path.write_bytes(text.encode())
            path.chmod(0o644)
            values = list(path.stat())
            values[4] = values[5] = 0
            with patch.object(Path, "lstat", return_value=os.stat_result(values)):
                self.assertTrue(ci_userns.owned_file(path, text))
                for newline in (b"\r\n", b"\r"):
                    with self.subTest(newline=newline):
                        path.write_bytes(text.encode().replace(b"\n", newline))
                        with self.assertRaisesRegex(ValueError, "CI_PROFILE_OWNERSHIP_MISMATCH"):
                            ci_userns.owned_file(path, text)

    def test_partial_install_drains_only_owned_entries_and_keeps_failure_visible(self):
        """受控状态表示第一份策略已加载、第二份只有文件、第三份未安装，清理必须仅对实际加载者发卸载命令并收回两份自有文
        件；卸载失败时继续其它条目但最终返回失败，不能强删仍加载的策略后假称已完成。
        """
        for fail in (False, True):
            with self.subTest(fail=fail):
                self._check_partial_cleanup(fail)

    def test_server_context_rejects_mixed_jobs_root_and_self_hosted(self):
        """服务端授权只能来自已知工作流与作业的完整组合，桌面名称混搭、自托管或管理员身份都必须在宿主命令之前拒绝；
        本例只验证纯上下文及分派边界，绝不在本机执行任何特权策略操作。
        """
        environment = {
            "GITHUB_ACTIONS": "true",
            "VERIQ_CI_RUNNER_ENVIRONMENT": "github-hosted",
            "RUNNER_OS": "Linux",
            "GITHUB_JOB": "ubuntu-release",
            "GITHUB_WORKFLOW": "Server release verification",
            "GITHUB_RUN_ID": "12345",
            "GITHUB_RUN_ATTEMPT": "2",
        }
        release = {"ID": "ubuntu", "VERSION_ID": "24.04"}
        self.assertEqual(
            ci_userns.job_identity(environment, release, "server"), "veriq-t20-server-12345-2"
        )
        for changes in [
            {"GITHUB_JOB": "ubuntu-desktop"},
            {"GITHUB_WORKFLOW": "Desktop focused verification"},
            {"VERIQ_CI_RUNNER_ENVIRONMENT": "self-hosted"},
            {"RUNNER_OS": "Windows"},
            {"GITHUB_RUN_ID": "../other"},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                ci_userns.job_identity({**environment, **changes}, release, "server")
        with self.assertRaises(ValueError):
            ci_userns.job_identity(environment, release)
        with self.assertRaises(ValueError):
            ci_userns.job_identity(environment, {"ID": "ubuntu", "VERSION_ID": "22.04"}, "server")
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(ci_userns.platform, "freedesktop_os_release", return_value=release),
            patch.object(ci_userns.os, "geteuid", return_value=0),
            patch.object(ci_userns.sys, "argv", ["ci_userns.py", "prepare", "--purpose", "server"]),
            patch.object(ci_userns, "invoke") as invoke,
        ):
            with self.assertRaisesRegex(ValueError, "CI_UNPRIVILEGED_RUNNER_REQUIRED"):
                ci_userns.main()
            invoke.assert_not_called()

    def test_server_evidence_and_profile_names_cannot_cross_purpose(self):
        """服务端只接受源码身份下的独立证据目录和两个浏览器角色，不能借桌面目录、Electron 名称或目的切换扩大策略；
        路径检查读取真实临时目录，符号链接和错误源码仍在进入宿主命令前失败。
        """
        with tempfile.TemporaryDirectory(prefix="veriq-server-evidence-") as directory:
            root = Path(directory).resolve()
            source = "b" * 40
            evidence = root / f".superpowers/sdd/veriq-1/evidence/t20/server-{source}"
            evidence.mkdir(parents=True)
            environment = {"GITHUB_SHA": source, "VERIQ_SERVER_EVIDENCE": str(evidence)}
            self.assertEqual(ci_userns.evidence_path(root, environment, "server"), evidence)
            for changes in [
                {"GITHUB_SHA": "B" * 40},
                {"GITHUB_SHA": "b" * 39},
                {"VERIQ_SERVER_EVIDENCE": str(evidence).replace("server-", "desktop-")},
                {"VERIQ_SERVER_EVIDENCE": str(evidence) + "/../" + evidence.name},
            ]:
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    ci_userns.evidence_path(root, {**environment, **changes}, "server")
            with self.assertRaises(ValueError):
                ci_userns.evidence_path(root, environment)
            for kind in ("shell", "chrome"):
                name = f"veriq-t20-server-12345-2-{kind}"
                text = ci_userns.profile_text(name, f"/job/{kind}", "server")
                self.assertIn(f'profile {name} "/job/{kind}"', text)
            with self.assertRaises(ValueError):
                ci_userns.profile_text(
                    "veriq-t20-server-12345-2-electron", "/job/electron", "server"
                )
            with self.assertRaises(ValueError):
                ci_userns.profile_text("veriq-t19-12345-2-shell", "/job/shell", "server")
            evidence.rmdir()
            target = root / "target"
            target.mkdir()
            evidence.symlink_to(target, target_is_directory=True)
            with self.assertRaises(ValueError):
                ci_userns.evidence_path(root, environment, "server")

    def test_server_binaries_need_exact_locked_browser_roles_without_electron(self):
        """服务端只能授权固定 Playwright 分发的完整浏览器及无界面壳，不读取或授予未使用 Electron；文件摘要、执行权限和
        所有权继续核对，版本探测只在外部命令边界使用受控输出以避免本机启动浏览器。
        """
        with tempfile.TemporaryDirectory(prefix="veriq-server-binaries-") as directory:
            root = Path(directory).resolve()
            evidence = root / "evidence"
            evidence.mkdir()
            browsers = root / ".superpowers/cache/playwright"
            chrome = browsers / "chromium-1254/chrome-linux64/chrome"
            shell = (
                browsers
                / "chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell"
            )
            for path in (chrome, shell):
                path.parent.mkdir(parents=True)
                path.write_bytes(path.name.encode())
                path.chmod(0o755)
            reported = "Chromium 158.0.8127.18"

            def version(_evidence, arguments):
                """版本替身只接受两条已知实际临时浏览器路径，任意 Electron 或其它命令均直接使本测试失败。"""
                self.assertIn(arguments, [[str(chrome), "--version"], [str(shell), "--version"]])
                return ci_userns.subprocess.CompletedProcess(arguments, 0, reported, "")

            with (
                patch.dict(
                    os.environ,
                    {
                        "PLAYWRIGHT_BROWSERS_PATH": str(browsers),
                        "VERIQ_TEST_HEADED_BROWSER": str(chrome),
                    },
                    clear=True,
                ),
                patch.object(
                    ci_userns, "cookie_electron", side_effect=AssertionError("Electron accessed")
                ),
                patch.object(ci_userns, "invoke", version),
            ):
                result = ci_userns.binaries(root, evidence, "server")
                self.assertEqual(set(result), {"shell", "chrome"})
                self.assertEqual(result["chrome"]["realpath"], str(chrome))
                self.assertEqual(result["shell"]["realpath"], str(shell))
                self.assertEqual(result["chrome"]["sha256"], hashlib.sha256(b"chrome").hexdigest())
                reported = "Chromium 159.0.0.0"
                with self.assertRaisesRegex(ValueError, "CI_BROWSER_VERSION_MISMATCH"):
                    ci_userns.binaries(root, evidence, "server")
                reported = "Chromium 158.0.8127.18"
                with patch.dict(os.environ, {"VERIQ_TEST_HEADED_BROWSER": str(shell)}):
                    with self.assertRaisesRegex(ValueError, "CI_BINARY_PATH_MISMATCH"):
                        ci_userns.binaries(root, evidence, "server")
                owner = os.getuid()
                with patch.object(ci_userns.os, "getuid", return_value=owner + 1):
                    with self.assertRaisesRegex(ValueError, "CI_BINARY_METADATA_INVALID"):
                        ci_userns.binaries(root, evidence, "server")
                chrome.chmod(0o644)
                with self.assertRaisesRegex(ValueError, "CI_BINARY_METADATA_INVALID"):
                    ci_userns.binaries(root, evidence, "server")

    def test_server_browser_redirects_never_authorize_another_checkout_binary(self):
        """服务端的缓存、发行父目录及浏览器叶节点都不能经符号链接改授 checkout 内其它同版本二进制；测试读取自有文件，
        仅版本命令采用受控输出，避免路径重定向因仍在源码根下而获得策略授权。
        """
        for location, role in [
            ("cache", "shell"),
            ("parent", "shell"),
            ("leaf", "shell"),
            ("parent", "chrome"),
            ("leaf", "chrome"),
        ]:
            with self.subTest(location=location, role=role):
                with tempfile.TemporaryDirectory(prefix="veriq-server-redirect-") as directory:
                    root = Path(directory).resolve()
                    evidence = root / "evidence"
                    evidence.mkdir()
                    browsers = root / ".superpowers/cache/playwright"
                    paths = {
                        "chrome": browsers / "chromium-1254/chrome-linux64/chrome",
                        "shell": browsers
                        / "chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
                    }
                    for path in paths.values():
                        path.parent.mkdir(parents=True)
                        path.write_bytes(b"browser")
                        path.chmod(0o755)
                    selected = browsers if location == "cache" else paths[role]
                    if location == "parent":
                        selected = selected.parent
                    target = root / "redirected"
                    selected.rename(target)
                    selected.symlink_to(target, target_is_directory=location != "leaf")
                    with (
                        patch.dict(
                            os.environ,
                            {
                                "PLAYWRIGHT_BROWSERS_PATH": str(browsers),
                                "VERIQ_TEST_HEADED_BROWSER": str(paths["chrome"].resolve()),
                            },
                            clear=True,
                        ),
                        patch.object(
                            ci_userns,
                            "invoke",
                            return_value=ci_userns.subprocess.CompletedProcess(
                                [], 0, "Chromium 158.0.8127.18", ""
                            ),
                        ),
                    ):
                        with self.assertRaisesRegex(
                            ValueError, "CI_(BINARY_PATH|BROWSER_ROOT)_MISMATCH"
                        ):
                            ci_userns.binaries(root, evidence, "server")

    def test_desktop_keeps_fuse_copy_and_rejects_browser_cache_or_shell_redirects(self):
        """桌面正常三角色仍接受独立 fuse 副本而非原包 Electron，浏览器缓存或壳重定向则不能扩展精确路径授权；临时文件和
        摘要走正式验证，只有浏览器版本命令使用替身，不在本机启动或加载策略。
        """
        for redirect in ("none", "cache", "shell"):
            with self.subTest(redirect=redirect):
                with tempfile.TemporaryDirectory(prefix="veriq-desktop-redirect-") as directory:
                    root = Path(directory).resolve()
                    evidence = root / "evidence"
                    evidence.mkdir()
                    source = root / "apps/desktop/node_modules/electron/dist/electron"
                    electron = root / "apps/desktop/build/electron-cookie/electron"
                    browsers = root / ".superpowers/cache/playwright"
                    chrome = browsers / "chromium-1254/chrome-linux64/chrome"
                    shell = (
                        browsers
                        / "chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell"
                    )
                    for path in (source, electron, chrome, shell):
                        path.parent.mkdir(parents=True)
                        path.write_bytes(path.name.encode())
                        path.chmod(0o755)
                    source.write_bytes(b"original")
                    electron.write_bytes(b"modified")
                    (source.parent.parent / "package.json").write_text('{"version":"45.3.1"}')
                    (evidence / "cookie-fuses.json").write_text(
                        json.dumps(
                            {
                                "original": str(source),
                                "executable": str(electron),
                                "originalSha256": hashlib.sha256(b"original").hexdigest(),
                                "modifiedSha256": hashlib.sha256(b"modified").hexdigest(),
                                "packageVersion": "45.3.1",
                                "toolVersion": "1.8.0",
                                "after": {"version": "1", "1": 49},
                                "independentCopy": True,
                                "sourceUnchanged": True,
                            }
                        )
                    )
                    if redirect != "none":
                        selected = browsers if redirect == "cache" else shell
                        target = root / "redirected-browser"
                        selected.rename(target)
                        selected.symlink_to(target, target_is_directory=redirect == "cache")
                    with (
                        patch.dict(
                            os.environ,
                            {
                                "PLAYWRIGHT_BROWSERS_PATH": str(browsers),
                                "VERIQ_TEST_HEADED_BROWSER": str(chrome.resolve()),
                                "VERIQ_TEST_ELECTRON": str(electron),
                            },
                            clear=True,
                        ),
                        patch.object(
                            ci_userns,
                            "invoke",
                            return_value=ci_userns.subprocess.CompletedProcess(
                                [], 0, "Chromium 158.0.8127.18", ""
                            ),
                        ),
                    ):
                        if redirect == "none":
                            result = ci_userns.binaries(root, evidence)
                            self.assertEqual(set(result), {"electron", "shell", "chrome"})
                            self.assertEqual(result["electron"]["realpath"], str(electron))
                            self.assertNotEqual(result["electron"]["realpath"], str(source))
                        else:
                            with self.assertRaisesRegex(
                                ValueError, "CI_(BINARY_PATH|BROWSER_ROOT)_MISMATCH"
                            ):
                                ci_userns.binaries(root, evidence)

    def test_missing_state_cleanup_only_accepts_proven_absence_of_owned_residue(self):
        """缺少意图状态不能直接宣布尚未安装，必须先只读核对本目的精确内核名字与文件均不存在；已载成员或悬空链接残留均硬
        失败且保留，不能凭缺失状态擅自卸载未知策略或删除文件。
        """
        stem = "veriq-t20-server-12345-2"
        for residue in ("none", "loaded", "file", "dangling"):
            with self.subTest(residue=residue):
                with tempfile.TemporaryDirectory(prefix="veriq-no-state-") as directory:
                    evidence = Path(directory)
                    target = Path("/etc/apparmor.d") / f"{stem}-shell"
                    observed = {
                        "profiles": [f"{stem}-shell (unconfined)"] if residue == "loaded" else []
                    }
                    original = os.path.lexists

                    def exists(
                        path, bound_target=target, bound_residue=residue, bound_exists=original
                    ):
                        """只模拟本目的精确文件或悬空链接的存在，其余路径沿用真实文件系统，不扩大清理可见范围。"""
                        return (
                            True
                            if Path(path) == bound_target and bound_residue in ("file", "dangling")
                            else bound_exists(path)
                        )

                    with (
                        patch.object(ci_userns, "snapshot", return_value=observed) as snapshot,
                        patch.object(ci_userns.os.path, "lexists", exists),
                        patch.object(ci_userns, "invoke") as invoke,
                    ):
                        if residue == "none":
                            ci_userns.cleanup(evidence, stem, "server")
                            self.assertEqual(
                                json.loads((evidence / "userns-cleanup.json").read_bytes())[
                                    "status"
                                ],
                                "NOT_INSTALLED",
                            )
                        else:
                            with self.assertRaisesRegex(
                                ValueError, "CI_PROFILE_STATE_MISSING_WITH_RESIDUE"
                            ):
                                ci_userns.cleanup(evidence, stem, "server")
                        snapshot.assert_called_once_with(evidence)
                        invoke.assert_not_called()

    def test_prepare_rejects_dangling_state_and_owned_policy_links_before_install(self):
        """准备过程须把悬空状态链接及自有策略链接都视作已有占位并拒绝，不能因 exists 跟随链接而覆盖或安装；所有宿主命令
        在受控边界留在本机替身中，测试只创建自己的悬空状态路径。
        """
        stem = "veriq-t20-server-12345-2"
        baseline = {
            "limits": {
                "apparmor_restrict_unprivileged_userns": "1",
                "unprivileged_userns_clone": "1",
                "max_user_namespaces": "1000",
            },
            "apparmorEnabled": "Y",
            "label": "unconfined",
            "profiles": [],
        }
        selected = {"shell": {"realpath": "/job/shell"}, "chrome": {"realpath": "/job/chrome"}}
        for location in ("state", "policy"):
            with self.subTest(location=location):
                with tempfile.TemporaryDirectory(prefix="veriq-prepare-links-") as directory:
                    evidence = Path(directory)
                    state = evidence / "userns-state.json"
                    if location == "state":
                        state.symlink_to(evidence / "missing-target")
                    target = Path("/etc/apparmor.d") / f"{stem}-shell"
                    original = os.path.lexists

                    def exists(
                        path, bound_target=target, bound_location=location, bound_exists=original
                    ):
                        """只将本目的目标模拟为悬空链接，其它路径保持真实观察，防止替身把其它策略排除在拒绝范围外。"""
                        return (
                            True
                            if Path(path) == bound_target and bound_location == "policy"
                            else bound_exists(path)
                        )

                    with (
                        patch.object(ci_userns, "snapshot", return_value=baseline),
                        patch.object(ci_userns, "binaries", return_value=selected),
                        patch.object(ci_userns, "owned_file", return_value=True),
                        patch.object(ci_userns.os.path, "lexists", exists),
                        patch.object(
                            ci_userns,
                            "invoke",
                            return_value=ci_userns.subprocess.CompletedProcess(
                                [], 0, "--skip-cache", ""
                            ),
                        ),
                    ):
                        category = (
                            "CI_PROFILE_STATE_ALREADY_EXISTS"
                            if location == "state"
                            else "CI_PROFILE_ALREADY_EXISTS"
                        )
                        with self.assertRaisesRegex(ValueError, category):
                            ci_userns.prepare(evidence, evidence, stem, "server")

    def test_server_prepare_partial_failure_leaves_exact_intent_for_cleanup(self):
        """服务端第二条策略安装失败时仍须留下第一条的真实准备意图，随后清理通过同一状态回收已加载成员；命令与所有权边界
        仅操作本测试集合，证明新增目的不会因参数遗失调用桌面角色或触及真实系统策略。
        """
        stem = "veriq-t20-server-12345-2"
        baseline = {
            "limits": {
                "apparmor_restrict_unprivileged_userns": "1",
                "unprivileged_userns_clone": "1",
                "max_user_namespaces": "1000",
            },
            "apparmorEnabled": "Y",
            "label": "unconfined",
            "profiles": ["unrelated (enforce)"],
        }
        files, loaded = set(), set()
        selected = {"shell": {"realpath": "/job/shell"}, "chrome": {"realpath": "/job/chrome"}}
        with tempfile.TemporaryDirectory(prefix="veriq-server-partial-") as directory:
            evidence = Path(directory)

            def observe(_evidence):
                """受控快照只合并本次模拟命令实际更新的成员，不把返回成功的命令自动视为已完成策略加载或卸载。"""
                return {
                    **baseline,
                    "profiles": sorted(
                        baseline["profiles"] + [name + " (unconfined)" for name in loaded]
                    ),
                }

            def command(_evidence, arguments):
                """只接受服务端两个固定名字的安装与清理命令，并在第二次安装时模拟失败，所有命令都不越过本机替身边界。"""
                if arguments == ["/usr/sbin/apparmor_parser", "--help"]:
                    return ci_userns.subprocess.CompletedProcess(arguments, 0, "--skip-cache", "")
                name = Path(arguments[-1]).name
                self.assertIn(name, {f"{stem}-shell", f"{stem}-chrome"})
                if arguments[2] == "install":
                    if name.endswith("-chrome"):
                        raise RuntimeError("CONTROLLED_SECOND_INSTALL_FAILURE")
                    files.add(name)
                elif arguments[2] == "rm":
                    files.remove(name)
                elif "-a" in arguments:
                    loaded.add(name)
                elif "-R" in arguments:
                    loaded.remove(name)
                else:
                    self.fail("unexpected host command")
                return ci_userns.subprocess.CompletedProcess(arguments, 0, "", "")

            with (
                patch.object(ci_userns, "snapshot", observe),
                patch.object(ci_userns, "binaries", return_value=selected) as binaries,
                patch.object(ci_userns, "invoke", command),
                patch.object(ci_userns, "owned_file", lambda path, _text: path.name in files),
            ):
                with self.assertRaisesRegex(RuntimeError, "CONTROLLED_SECOND_INSTALL_FAILURE"):
                    ci_userns.prepare(evidence, evidence, stem, "server")
                binaries.assert_called_once_with(evidence, evidence, "server")
                state = json.loads((evidence / "userns-state.json").read_bytes())
                self.assertEqual(state["purpose"], "server")
                self.assertEqual(state["kinds"], ["shell", "chrome"])
                self.assertEqual(loaded, {f"{stem}-shell"})
                ci_userns.cleanup(evidence, stem, "server")
            self.assertEqual(files, set())
            self.assertEqual(loaded, set())
            self.assertEqual(
                json.loads((evidence / "userns-cleanup.json").read_bytes())["status"], "REMOVED"
            )

    def test_server_cleanup_rejects_mixed_or_incomplete_policy_state(self):
        """清理状态必须完整绑定当前目的及确切角色集合，缺失浏览器、额外 Electron 或桌面状态都不能作为服务端卸载授权；
        失败发生在任何宿主快照或命令前，避免篡改意图造成角色缩水或触及其它目的的策略。
        """
        stem = "veriq-t20-server-12345-2"
        state = {
            "stem": stem,
            "purpose": "server",
            "kinds": ["shell", "chrome"],
            "parser": "/usr/sbin/apparmor_parser",
            "binaries": {
                "shell": {"realpath": "/job/shell"},
                "chrome": {"realpath": "/job/chrome"},
            },
        }
        faults = [
            {"purpose": "desktop"},
            {"kinds": ["shell"]},
            {"binaries": {"shell": {"realpath": "/job/shell"}}},
            {"binaries": {**state["binaries"], "electron": {"realpath": "/job/electron"}}},
        ]
        with tempfile.TemporaryDirectory(prefix="veriq-server-state-") as directory:
            evidence = Path(directory)
            for fault in faults:
                with self.subTest(fault=fault):
                    (evidence / "userns-state.json").write_text(json.dumps({**state, **fault}))
                    with patch.object(ci_userns, "snapshot") as observe:
                        with self.assertRaisesRegex(ValueError, "CI_PROFILE_STATE_MISMATCH"):
                            ci_userns.cleanup(evidence, stem, "server")
                        observe.assert_not_called()

    def test_server_partial_install_only_cleans_two_owned_roles_and_preserves_failure(self):
        """服务端部分安装只回收本目的的两条策略，桌面同轮策略始终保留；卸载失败必须继续另一条并明确失败，不能把发送命
        令或删除文件误当成内核已卸载成功，所有命令仍仅更新本测试拥有的集合。
        """
        for fail in (False, True):
            with self.subTest(fail=fail):
                self._check_partial_cleanup(fail, "server")

    def test_successful_unload_command_cannot_delete_a_still_loaded_server_profile(self):
        """卸载命令即使返回成功也必须由实际策略集合证明目标消失，否则保留策略文件供后续补偿并明确失败；本机演练只更新
        自有受控集合，不能把命令回执当作真实内核状态或扩大到其它目的策略。
        """
        self._check_partial_cleanup(False, "server", unconfirmed=True)

    def test_unrelated_profile_mode_change_cannot_be_reported_as_unchanged(self):
        """其它策略即使名字不变而模式改变也不能记为未受影响，清理仍只移除本目的精确成员并明确失败；受控快照故意保留名字
        但改变模式，用真实比较逻辑证明最终证据不能把外部策略的弱化隐去。
        """
        self._check_partial_cleanup(False, "server", external_mode=True)

    def _check_partial_cleanup(
        self, fail, purpose="desktop", unconfirmed=False, external_mode=False
    ):
        """每次演练都创建独立的策略目录和已加载集合，记录该次命令实际选中的目标并核对卸载后的内核视图。"""
        stem = "veriq-t19-99999999999999-1" if purpose == "desktop" else "veriq-t20-server-12345-2"
        kinds = ("electron", "shell", "chrome") if purpose == "desktop" else ("shell", "chrome")
        first, second = kinds[:2]
        baseline = {
            "limits": {"restriction": "1"},
            "apparmorEnabled": "Y",
            "label": "unconfined",
            "profiles": ["unrelated (enforce)", "veriq-t19-12345-2-electron (unconfined)"],
        }
        with tempfile.TemporaryDirectory(prefix="veriq-policy-cleanup-") as directory:
            evidence = Path(directory)
            loaded = {f"{stem}-{first}"}
            files = {f"{stem}-{first}", f"{stem}-{second}"}
            commands = []
            state = {
                "stem": stem,
                "purpose": purpose,
                "kinds": list(kinds),
                "before": baseline,
                "parser": "/usr/sbin/apparmor_parser",
                "binaries": {kind: {"realpath": f"/job/{kind}"} for kind in kinds},
            }
            (evidence / "userns-state.json").write_text(json.dumps(state))

            def observe(_evidence):
                """该替身只报告当前受控集合及不变的限制值，不伪造真正内核状态；实际卸载命令是否触及无关名字由下面的
                命令记录和固定参数断言决定，最终失败仍由生产清理逻辑抛出。
                """
                return {
                    **baseline,
                    "profiles": [
                        (
                            line.replace("unrelated (enforce)", "unrelated (complain)")
                            if external_mode
                            else line
                        )
                        for line in baseline["profiles"]
                    ]
                    + [name + " (unconfined)" for name in sorted(loaded)],
                }

            def command(_evidence, arguments):
                """命令边界记录生产逻辑选择的精确目标，并只更新本测试拥有的集合以表示成功或受控卸载失败；
                这里绝不执行 sudo，也不会向真实系统安装、卸载或删除任何 AppArmor 策略。
                """
                commands.append(arguments)
                name = Path(arguments[-1]).name
                self.assertIn(name, {f"{stem}-{kind}" for kind in kinds})
                self.assertEqual(Path(arguments[-1]).parent, Path("/etc/apparmor.d"))
                if arguments[2] == "/usr/sbin/apparmor_parser":
                    self.assertEqual(arguments[3:5], ["--skip-cache", "-R"])
                    if fail:
                        raise RuntimeError("CONTROLLED_UNLOAD_FAILURE")
                    if not unconfirmed:
                        loaded.remove(name)
                else:
                    self.assertEqual(arguments[2:4], ["rm", "--"])
                    files.remove(name)

            with (
                patch.object(ci_userns, "snapshot", observe),
                patch.object(ci_userns, "invoke", command),
                patch.object(ci_userns, "owned_file", lambda path, _text: path.name in files),
            ):
                if fail or unconfirmed or external_mode:
                    with self.assertRaisesRegex(ValueError, "CI_PROFILE_CLEANUP_FAILED"):
                        if purpose == "desktop":
                            ci_userns.cleanup(evidence, stem)
                        else:
                            ci_userns.cleanup(evidence, stem, purpose)
                else:
                    if purpose == "desktop":
                        ci_userns.cleanup(evidence, stem)
                    else:
                        ci_userns.cleanup(evidence, stem, purpose)
            result = json.loads((evidence / "userns-cleanup.json").read_bytes())
            self.assertEqual(result["globalRestrictionsUnchanged"], True)
            self.assertEqual(
                result["status"], "FAILED" if fail or unconfirmed or external_mode else "REMOVED"
            )
            self.assertEqual(
                result["otherProfilesUnchanged"], not (external_mode or fail or unconfirmed)
            )
            self.assertNotIn(f"{stem}-{second}", files)
            self.assertEqual(loaded, {f"{stem}-{first}"} if fail or unconfirmed else set())
            if fail or unconfirmed:
                self.assertIn(f"{stem}-{first}", files)
            self.assertEqual(len(commands), 2 if fail or unconfirmed else 3)


if __name__ == "__main__":
    unittest.main()
