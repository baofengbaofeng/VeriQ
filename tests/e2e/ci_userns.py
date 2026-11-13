"""仅 GitHub-hosted Ubuntu24.04 桌面验收为当前任务三个已验证二进制建立精确 userns 例外，并在结束时卸载自有策略；本模块不改变全局 sysctl，不适合作为用户安装步骤，也不运行带 sudo 的应用程序。"""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
from typing import Any

KINDS = ("electron", "shell", "chrome")
LIMITS = {
    "apparmor_restrict_unprivileged_userns": "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    "unprivileged_userns_clone": "/proc/sys/kernel/unprivileged_userns_clone",
    "max_user_namespaces": "/proc/sys/user/max_user_namespaces",
}


def job_identity(environment: dict[str, str], release: dict[str, str]) -> str:
    """宿主策略入口必须同时匹配 GitHub 官方托管上下文、固定 QA 工作流和实际 Ubuntu24.04 发行信息；普通本机调用或自托管 runner 在读取策略文件和执行任何 sudo 前拒绝，任务标识也只能由有界数字组成。"""
    required = {
        "GITHUB_ACTIONS": "true",
        "VERIQ_CI_RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux",
        "GITHUB_JOB": "ubuntu-desktop",
        "GITHUB_WORKFLOW": "Desktop focused verification",
    }
    if any(environment.get(key) != value for key, value in required.items()):
        raise ValueError("CI_HOSTED_CONTEXT_REQUIRED")
    if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "24.04":
        raise ValueError("CI_UBUNTU_2404_REQUIRED")
    run = environment.get("GITHUB_RUN_ID", "")
    attempt = environment.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[1-9][0-9]{0,19}", run) or not re.fullmatch(
        r"[1-9][0-9]{0,4}", attempt
    ):
        raise ValueError("CI_JOB_ID_INVALID")
    return f"veriq-t19-{run}-{attempt}"


def profile_text(name: str, executable: str) -> str:
    """策略使用官方 unconfined 加 userns 模型，但附件路径只能是无控制字符、无 AppArmor 通配或变量语法的绝对文件名；三个 profile 各有本 job 唯一名字，使加载中途失败时也能逐个精确卸载而不触及其它策略。"""
    if not re.fullmatch(
        r"veriq-t19-[1-9][0-9]{0,19}-[1-9][0-9]{0,4}-(electron|shell|chrome)", name
    ):
        raise ValueError("CI_PROFILE_NAME_INVALID")
    if not re.fullmatch(r"/[A-Za-z0-9_./@+-]+", executable):
        raise ValueError("CI_PROFILE_PATH_INVALID")
    if "." in Path(executable).parts or ".." in Path(executable).parts:
        raise ValueError("CI_PROFILE_PATH_INVALID")
    return f'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile {name} "{executable}" flags=(unconfined) {{\n    userns,\n}}\n'


def save(path: Path, value: Any) -> None:
    """审计状态先写入同目录临时文件再原子替换，保存的是公开宿主配置与本 job 策略身份而不含密钥；清理据此确认原始全局限制，不能把一次发送卸载命令当成真实策略已移除的证明。"""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=4) + "\n")
    temporary.replace(path)


def invoke(
    evidence: Path, arguments: list[str], required: bool = True
) -> subprocess.CompletedProcess[str]:
    """外部命令只接收明确参数列表且不经过 shell，正常输出和失败诊断均保留为本 job 日志；有限诊断时限仅约束这些宿主配置命令，不改变业务执行、浏览器测试或停止回执的时间预算。"""
    result = subprocess.run(
        arguments, capture_output=True, text=True, timeout=30, check=False
    )
    with (evidence / "userns-commands.jsonl").open("a") as stream:
        stream.write(
            json.dumps(
                {
                    "argv": arguments,
                    "code": result.returncode,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                }
            )
            + "\n"
        )
    if required and result.returncode:
        raise RuntimeError(
            f"HOST_COMMAND_FAILED {arguments[0]} code={result.returncode}"
        )
    return result


def snapshot(evidence: Path) -> dict[str, Any]:
    """读取真实内核限制、当前 AppArmor 标签和已加载策略集合，同时记录普通 runner 的 userns 探测结果；这些观测只用于核对官方路径例外的适用条件，任何步骤都不写 sysctl 或改变其它应用的安全设置。"""
    values = {
        key: Path(path).read_text().strip() if Path(path).exists() else None
        for key, path in LIMITS.items()
    }
    profiles = invoke(
        evidence, ["sudo", "-n", "cat", "/sys/kernel/security/apparmor/profiles"]
    ).stdout.splitlines()
    probe = invoke(
        evidence, ["unshare", "--user", "--map-root-user", "true"], required=False
    )
    return {
        "limits": values,
        "apparmorEnabled": Path("/sys/module/apparmor/parameters/enabled")
        .read_text()
        .strip(),
        "label": Path("/proc/self/attr/current").read_text().strip(),
        "profiles": sorted(profiles),
        "usernsProbe": {
            "code": probe.returncode,
            "stdout": probe.stdout,
            "stderr": probe.stderr,
        },
        "uid": os.getuid(),
        "kernel": platform.release(),
    }


def binaries(root: Path, evidence: Path) -> dict[str, Any]:
    """白名单只接受本工作区官方 Electron 包和固定 Playwright1254 分发路径，逐个确认真实普通可执行文件、非 SUID 权限及字节摘要；浏览器另执行实际版本探测，Electron 的内嵌版本仍由后续真实窗口单独记录。"""
    browser_root = (root / ".superpowers/cache/playwright").resolve(strict=True)
    if (
        Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]).resolve(strict=True)
        != browser_root
    ):
        raise ValueError("CI_BROWSER_ROOT_MISMATCH")
    package = root / "apps/desktop/node_modules/electron"
    if json.loads((package / "package.json").read_bytes())["version"] != "45.3.1":
        raise ValueError("CI_ELECTRON_PACKAGE_MISMATCH")
    selected = {
        "electron": package / "dist/electron",
        "shell": browser_root
        / "chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome": browser_root / "chromium-1254/chrome-linux64/chrome",
    }
    expected = {
        "electron": os.environ["VERIQ_TEST_ELECTRON"],
        "chrome": os.environ["VERIQ_TEST_HEADED_BROWSER"],
    }
    result = {}
    for kind, path in selected.items():
        actual = path.resolve(strict=True)
        actual.relative_to(root)
        profile_text(f"veriq-t19-1-1-{kind}", str(actual))
        if kind in expected and Path(expected[kind]).resolve(strict=True) != actual:
            raise ValueError("CI_BINARY_PATH_MISMATCH")
        info = actual.stat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & (stat.S_ISUID | stat.S_ISGID)
            or not os.access(actual, os.X_OK)
        ):
            raise ValueError("CI_BINARY_METADATA_INVALID")
        with actual.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        value = {
            "realpath": str(actual),
            "uid": info.st_uid,
            "mode": oct(stat.S_IMODE(info.st_mode)),
            "size": info.st_size,
            "sha256": digest,
        }
        result[kind] = value
        save(evidence / "userns-binaries.json", result)
        if kind != "electron":
            version = invoke(evidence, [str(actual), "--version"]).stdout.strip()
            if not re.search(r"\b158\.0\.8127\.18\b", version):
                raise ValueError("CI_BROWSER_VERSION_MISMATCH")
            value["version"] = version
        else:
            value["packageVersion"] = "45.3.1"
        result[kind] = value
    return result


def owned_file(path: Path, expected: str) -> bool:
    """加载和删除前必须再次确认策略文件是 root 拥有的普通0644文件且字节与本 job 生成文本完全相同；文件不存在只表示尚未安装，链接、替换或其它拥有者都失败关闭，不能清理一个名字相似的外部策略。"""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o644
        or path.read_text() != expected
    ):
        raise ValueError("CI_PROFILE_OWNERSHIP_MISMATCH")
    return True


def prepare(root: Path, evidence: Path, stem: str) -> None:
    """先持久化未修改的宿主限制和三份精确策略意图，再逐个安装 root 文件并调用成熟 parser 加载；任何能力或所有权不符都停止，always 清理步骤可根据已保存意图收回此前成功加载的部分，而不会开启全局 userns。"""
    before = snapshot(evidence)
    save(evidence / "userns-before.json", before)
    selected = binaries(root, evidence)
    save(evidence / "userns-binaries.json", selected)
    if (
        before["apparmorEnabled"] != "Y"
        or before["label"] != "unconfined"
        or before["limits"]["apparmor_restrict_unprivileged_userns"] != "1"
        or before["limits"]["unprivileged_userns_clone"] not in (None, "1")
        or int(before["limits"]["max_user_namespaces"] or "0") <= 0
    ):
        raise ValueError("CI_HOST_RESTRICTIONS_UNSUPPORTED")
    parser = "/usr/sbin/apparmor_parser"
    help_result = invoke(evidence, [parser, "--help"])
    if "--skip-cache" not in help_result.stdout + help_result.stderr:
        raise ValueError("CI_PARSER_SKIP_CACHE_UNAVAILABLE")
    state = {
        "stem": stem,
        "before": before,
        "binaries": selected,
        "parser": parser,
        "owned": [],
    }
    state_file = evidence / "userns-state.json"
    if state_file.exists():
        raise ValueError("CI_PROFILE_STATE_ALREADY_EXISTS")
    for kind in KINDS:
        name = f"{stem}-{kind}"
        if (
            any(line.split(" (", 1)[0] == name for line in before["profiles"])
            or (Path("/etc/apparmor.d") / name).exists()
        ):
            raise ValueError("CI_PROFILE_ALREADY_EXISTS")
    save(state_file, state)
    for kind in KINDS:
        name = f"{stem}-{kind}"
        text = profile_text(name, selected[kind]["realpath"])
        source = evidence / f"userns-{kind}.profile"
        source.write_text(text)
        target = Path("/etc/apparmor.d") / name
        invoke(
            evidence,
            [
                "sudo",
                "-n",
                "install",
                "-o",
                "root",
                "-g",
                "root",
                "-m",
                "0644",
                str(source),
                str(target),
            ],
        )
        if not owned_file(target, text):
            raise ValueError("CI_PROFILE_INSTALL_MISSING")
        owned = {
            "kind": kind,
            "name": name,
            "path": str(target),
            "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "loaded": False,
        }
        state["owned"].append(owned)
        save(state_file, state)
        invoke(evidence, ["sudo", "-n", parser, "--skip-cache", "-a", str(target)])
        owned["loaded"] = True
        save(state_file, state)
    after = snapshot(evidence)
    save(evidence / "userns-after-load.json", after)
    names = {line.split(" (", 1)[0] for line in after["profiles"]}
    baseline_names = {line.split(" (", 1)[0] for line in before["profiles"]}
    expected_names = {f"{stem}-{kind}" for kind in KINDS}
    if (
        after["limits"] != before["limits"]
        or after["apparmorEnabled"] != before["apparmorEnabled"]
        or after["label"] != before["label"]
        or names != baseline_names | expected_names
    ):
        raise ValueError("CI_PROFILE_LOAD_PROOF_FAILED")
    print("Job-scoped userns profiles loaded; global restrictions unchanged")


def cleanup(evidence: Path, stem: str) -> None:
    """清理只从本次意图恢复固定三个名字，确认已加载身份后逐个卸载并删除相同 root 文件；即使某项失败也继续尝试其它自有项，最后检查所有目标消失和全局限制未变，不能把清理错误吞成绿色验收。"""
    state_file = evidence / "userns-state.json"
    if not state_file.exists():
        save(
            evidence / "userns-cleanup.json", {"status": "NOT_INSTALLED", "stem": stem}
        )
        return
    state = json.loads(state_file.read_bytes())
    if state["stem"] != stem or state["parser"] != "/usr/sbin/apparmor_parser":
        raise ValueError("CI_PROFILE_STATE_MISMATCH")
    errors = []
    for kind in KINDS:
        name = f"{stem}-{kind}"
        target = Path("/etc/apparmor.d") / name
        expected = profile_text(name, state["binaries"][kind]["realpath"])
        try:
            current = snapshot(evidence)
            loaded = any(line.split(" (", 1)[0] == name for line in current["profiles"])
            exists = owned_file(target, expected)
            if loaded:
                if not exists:
                    raise ValueError("CI_LOADED_PROFILE_FILE_MISSING")
                invoke(
                    evidence,
                    ["sudo", "-n", state["parser"], "--skip-cache", "-R", str(target)],
                )
            if exists:
                invoke(evidence, ["sudo", "-n", "rm", "--", str(target)])
        except Exception as error:
            errors.append({"kind": kind, "error": str(error)})
    after = snapshot(evidence)
    names = {line.split(" (", 1)[0] for line in after["profiles"]}
    unchanged = (
        after["limits"] == state["before"]["limits"]
        and after["apparmorEnabled"] == state["before"]["apparmorEnabled"]
        and after["label"] == state["before"]["label"]
    )
    other_profiles_unchanged = names == {
        line.split(" (", 1)[0] for line in state["before"]["profiles"]
    }
    removed = all(
        f"{stem}-{kind}" not in names
        and not (Path("/etc/apparmor.d") / f"{stem}-{kind}").exists()
        for kind in KINDS
    )
    save(
        evidence / "userns-cleanup.json",
        {
            "status": "REMOVED"
            if removed and unchanged and other_profiles_unchanged and not errors
            else "FAILED",
            "after": after,
            "globalRestrictionsUnchanged": unchanged,
            "ownedProfilesAndFilesRemoved": removed,
            "otherProfilesUnchanged": other_profiles_unchanged,
            "errors": errors,
        },
    )
    if errors or not unchanged or not other_profiles_unchanged or not removed:
        raise ValueError("CI_PROFILE_CLEANUP_FAILED")
    print("Job-scoped userns profiles removed; global restrictions unchanged")


def main() -> None:
    """入口在任何策略读取或 sudo 前验证托管 QA 上下文和普通 runner 身份，证据目录也固定在当前工作区；prepare 与 cleanup 都必须通过同样边界，测试模块导入只暴露纯文本及上下文校验而不触发系统修改。"""
    stem = job_identity(dict(os.environ), platform.freedesktop_os_release())
    if os.geteuid() == 0:
        raise ValueError("CI_UNPRIVILEGED_RUNNER_REQUIRED")
    root = Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
    if root != Path(__file__).resolve().parents[2]:
        raise ValueError("CI_CHECKOUT_ROOT_MISMATCH")
    if sys.argv[1:] not in (["prepare"], ["cleanup"]):
        raise ValueError("CI_PROFILE_OPERATION_INVALID")
    operation = sys.argv[1]
    evidence = root / ".superpowers/sdd/veriq-1/evidence/t19/fix1/ci"
    if Path(os.environ["VERIQ_DESKTOP_EVIDENCE"]).resolve(strict=True) != evidence:
        raise ValueError("CI_EVIDENCE_PATH_MISMATCH")
    try:
        if operation == "prepare":
            prepare(root, evidence, stem)
        else:
            cleanup(evidence, stem)
    except Exception as error:
        save(
            evidence / f"userns-{operation}-failure.json",
            {"error": str(error), "stem": stem},
        )
        raise


if __name__ == "__main__":
    main()
