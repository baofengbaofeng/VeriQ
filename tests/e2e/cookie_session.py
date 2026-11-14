"""Cookie 目标验收只在本次自有 D-Bus 与独立 XDG 目录内创建非空密码的合成 Secret Service，普通 HOME 保持原值且不激活用户服务；新建进程用真实 pidfd 与创建身份约束清理，密码仅通过标准输入交付且不会进入日志或命令行。"""

import json
import os
from pathlib import Path
import secrets
import select
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any


def identity(pid: int) -> dict[str, Any]:
    """创建身份包含内核启动时刻、实际可执行路径及真实 UID，并与持有的 pidfd 一起校验；PID 数字和进程名称本身不能授权终止，目标退出与 PID 重用会导致后续检查拒绝或被记录为原进程已经消失。"""
    root = Path(f"/proc/{pid}")
    status = (root / "status").read_text()
    uid = next(
        line.split()[1] for line in status.splitlines() if line.startswith("Uid:")
    )
    value = (root / "stat").read_text()
    return {
        "pid": pid,
        "start": value[value.rindex(")") + 2 :].split()[19],
        "executable": str((root / "exe").resolve(strict=True)),
        "uid": int(uid),
    }


class OwnedProcess:
    """夹具从自己直接创建的 Popen 取得真实内核 pidfd，记录身份后才允许后续停止；标准输出只用于读取有界总线地址，服务 stderr 不保存以避免泄漏提供者信息，GUI 命令则沿用原工作流的日志输出。"""

    def __init__(
        self, arguments: list[str], environment: dict[str, str], inherit: bool = False
    ):
        """创建失败或身份捕获中断时立即收回这次 Popen 真正拥有的子进程，不构造未知 PID 的兜底授权；正常路径持有 pidfd 到实际 wait 完成，使普通清理和超时升级始终指向同一次创建。"""
        self.process = subprocess.Popen(
            arguments,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=None if inherit else subprocess.PIPE,
            stderr=None if inherit else subprocess.DEVNULL,
        )
        self.descriptor = None
        try:
            self.descriptor = os.pidfd_open(self.process.pid)
            self.identity = identity(self.process.pid)
            if self.identity["uid"] != os.getuid():
                raise ValueError("COOKIE_FIXTURE_OWNER_INVALID")
        except BaseException:
            self.process.kill()
            self.process.wait(timeout=3)
            self.close()
            raise

    def line(self, timeout: float) -> str:
        """从实际新建服务的管道按字节读取一行且限定总大小和单次截止时刻，不依靠固定睡眠猜测服务启动；超时、过长或提前 EOF 都保持失败，不把空地址或启动诊断当作可用私有总线。"""
        deadline = time.monotonic() + timeout
        output = bytearray()
        stream = self.process.stdout
        if stream is None:
            raise ValueError("COOKIE_FIXTURE_PIPE_REQUIRED")
        while len(output) < 4096:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
                raise TimeoutError("COOKIE_FIXTURE_READY_TIMEOUT")
            part = os.read(stream.fileno(), 1)
            if part == b"\n":
                return output.decode("utf8")
            if not part:
                raise ValueError("COOKIE_FIXTURE_EARLY_EXIT")
            output.extend(part)
        raise ValueError("COOKIE_FIXTURE_OUTPUT_LIMIT")

    def record(self) -> dict[str, Any]:
        """证据只包含非秘密的内核身份与真实退出状态，不包含标准输入、密码、Cookie 或服务原始异常；这些记录供 always 清理再次核对，不能把一个已发送信号记录成守护进程实际已退出。"""
        return {
            **self.identity,
            "exited": self.process.poll() is not None,
            "code": self.process.returncode,
        }

    def close(self) -> None:
        """只有已完成 wait 或构造失败的本对象才能释放 pidfd 和自有管道，关闭不会向数字 PID 发信号；重复调用幂等，避免成功与失败路径共同收尾时关闭其他进程后来复用的描述符。"""
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None
        for stream in [self.process.stdin, self.process.stdout, self.process.stderr]:
            if stream is not None and not stream.closed:
                stream.close()

    def stop(self) -> None:
        """停止前校验完整创建身份，并使用已持有 pidfd 发送信号而不重新解释 PID；有限优雅退出失败后只升级同一子进程，wait 超时仍抛错，不能删除它的临时目录或将未知停止报告成清理成功。"""
        if self.process.poll() is None:
            if identity(self.process.pid) != self.identity:
                raise ValueError("COOKIE_FIXTURE_IDENTITY_CHANGED")
            signal.pidfd_send_signal(self.descriptor, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                signal.pidfd_send_signal(self.descriptor, signal.SIGKILL)
                self.process.wait(timeout=3)
        self.close()


def save(path: Path, value: Any) -> None:
    """私有会话证据使用同目录临时文件后原子替换，状态只携带自有根路径及进程创建身份；保存失败继续上抛并触发 finally 收尾，不把不完整登记转化为可以扫描或终止任意用户服务的授权。"""
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=4) + "\n")
    temporary.replace(path)


def cleanup(evidence: Path) -> None:
    """工作流 always 阶段只收回既有登记中仍匹配本 UID、启动时刻与执行文件的两个私有服务，通过新取得且重核的 pidfd 等待退出；没有登记表示尚未启动，身份变化、超时或遗留服务都会保留失败。"""
    path = evidence / "cookie-session-ownership.json"
    if not path.exists():
        save(evidence / "cookie-session-always.json", {"started": False, "errors": []})
        return
    record = json.loads(path.read_bytes())
    errors = []
    for expected in reversed(record["services"]):
        descriptor = None
        try:
            try:
                descriptor = os.pidfd_open(expected["pid"])
            except ProcessLookupError:
                continue
            actual = identity(expected["pid"])
            if (
                actual != {key: expected[key] for key in actual}
                or actual["uid"] != os.getuid()
            ):
                raise ValueError("COOKIE_FIXTURE_IDENTITY_CHANGED")
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            if not select.select([descriptor], [], [], 3)[0]:
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                if not select.select([descriptor], [], [], 3)[0]:
                    raise TimeoutError("COOKIE_FIXTURE_EXIT_UNCONFIRMED")
        except Exception as error:
            errors.append(type(error).__name__)
        finally:
            if descriptor is not None:
                os.close(descriptor)
    save(evidence / "cookie-session-always.json", {"started": True, "errors": errors})
    if errors:
        raise ValueError("COOKIE_FIXTURE_CLEANUP_FAILED")


def run(evidence: Path, arguments: list[str]) -> int:
    """正式 GUI 测试命令继承私有总线和独立 XDG 数据目录，密钥库密码是本次随机非空值且仅写标准输入；先验证实际默认 Collection 解锁再运行原套件，退出时按 GUI、keyring、bus 顺序确认真实停止并保留诊断。"""
    root = Path(tempfile.mkdtemp(prefix="veriq-cookie-session-"))
    env = dict(os.environ)
    for key, name in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_RUNTIME_DIR", "runtime"),
    ]:
        directory = root / name
        directory.mkdir(mode=0o700)
        env[key] = str(directory)
    control = root / "control"
    control.mkdir(mode=0o700)
    env["XDG_CURRENT_DESKTOP"] = "GNOME"
    config = root / "bus.conf"
    config.write_text(
        f'<busconfig><type>session</type><listen>unix:tmpdir={root / "runtime"}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow own="*"/><allow eavesdrop="true"/></policy></busconfig>'
    )
    services = []
    command = None
    failures = []
    ownership = evidence / "cookie-session-ownership.json"
    try:
        bus = OwnedProcess(
            [
                "/usr/bin/dbus-daemon",
                "--nofork",
                "--print-address=1",
                f"--config-file={config}",
            ],
            env,
        )
        services.append(bus)
        save(
            ownership,
            {"root": str(root), "services": [child.record() for child in services]},
        )
        address = bus.line(5)
        if not address.startswith("unix:") or "\n" in address:
            raise ValueError("COOKIE_FIXTURE_BUS_INVALID")
        env["DBUS_SESSION_BUS_ADDRESS"] = address
        daemon = OwnedProcess(
            [
                "/usr/bin/gnome-keyring-daemon",
                "--foreground",
                "--components=secrets",
                f"--control-directory={control}",
                "--unlock",
            ],
            env,
        )
        services.append(daemon)
        save(
            ownership,
            {"root": str(root), "services": [child.record() for child in services]},
        )
        daemon.process.stdin.write(secrets.token_urlsafe(32).encode("ascii"))
        daemon.process.stdin.close()
        deadline = time.monotonic() + 10
        while True:
            observed = subprocess.run(
                [
                    "/usr/bin/gdbus",
                    "call",
                    "--session",
                    "--dest",
                    "org.freedesktop.secrets",
                    "--object-path",
                    "/org/freedesktop/secrets/aliases/default",
                    "--method",
                    "org.freedesktop.DBus.Properties.Get",
                    "org.freedesktop.Secret.Collection",
                    "Locked",
                ],
                env=env,
                capture_output=True,
                timeout=2,
            )
            if observed.returncode == 0 and observed.stdout.strip() == b"(<false>,)":
                break
            if time.monotonic() >= deadline or daemon.process.poll() is not None:
                raise TimeoutError("COOKIE_FIXTURE_UNLOCK_UNCONFIRMED")
            time.sleep(0.025)
        save(
            evidence / "cookie-session-ready.json",
            {
                "root": str(root),
                "realHomePreserved": env.get("HOME") == os.environ.get("HOME"),
                "privateBus": True,
                "nonemptyPassword": True,
                "defaultCollectionUnlocked": True,
            },
        )
        command = OwnedProcess(arguments, env, inherit=True)
        return command.process.wait(timeout=1200)
    finally:
        for child in ([command] if command else []) + list(reversed(services)):
            try:
                child.stop()
            except Exception as error:
                failures.append(type(error).__name__)
        save(
            ownership,
            {"root": str(root), "services": [child.record() for child in services]},
        )
        save(
            evidence / "cookie-session-cleanup.json",
            {
                "errors": failures,
                "servicesExited": all(
                    child.process.poll() is not None for child in services
                ),
            },
        )
        if failures:
            raise ValueError("COOKIE_FIXTURE_CLEANUP_FAILED")
        import shutil

        shutil.rmtree(root)


if __name__ == "__main__":
    target = Path(os.environ["VERIQ_DESKTOP_EVIDENCE"]).resolve(strict=True)
    if sys.argv[1:] == ["cleanup"]:
        cleanup(target)
    else:
        if not sys.argv[1:]:
            raise ValueError("COOKIE_FIXTURE_COMMAND_REQUIRED")
        signal.signal(
            signal.SIGTERM,
            lambda _signal, _frame: (_ for _ in ()).throw(
                InterruptedError("COOKIE_FIXTURE_CANCELLED")
            ),
        )
        sys.exit(run(target, sys.argv[1:]))
