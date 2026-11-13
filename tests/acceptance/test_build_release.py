"""发行入口验收检查应急参数、原子输出和失败保留行为，使用实际文件系统而非模拟成功命令；这些测试防止未完成检查的候选获得正常发行标志，也防止覆盖上一次有效部署资料。

完整构建成本较高，流水线端到端验证由真实 build.sh 门禁承担。
这里独立验证无需数据库或浏览器即可确定的发布安全边界。
"""

import importlib.util
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_skip_tests_requires_an_auditable_reason() -> None:
    """应急跳过参数没有原因时必须在安装依赖和创建输出之前失败，错误应明确指出 reason；验证实际入口而非 argparse 源码，避免新增包装脚本绕过参数约束。

    此请求不授权任何构建步骤执行。
    返回码必须是参数错误，不接受文件缺失或权限错误冒充通过。
    """
    result = subprocess.run(
        ["bash", str(ROOT / "build.sh"), "--skip-tests"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "--reason" in result.stderr


def test_atomic_publish_preserves_previous_release_on_rejection(tmp_path: Path) -> None:
    """发布器必须拒绝尚无完整校验结果的候选并保留旧输出，只有携带成功标志和一致性摘要的目录才能切换原子指针；读者通过同一个 output/server 名称看到完整版本。

    实际目录与符号链接用于验证文件系统效果。
    未验证候选不得通过默认值或缺字段变成成功。
    """
    spec = importlib.util.spec_from_file_location(
        "veriq_build_release", ROOT / "scripts/build_release.py"
    )
    assert spec and spec.loader, "Release implementation is missing"
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    output = tmp_path / "output"
    output.mkdir()
    old = output / "previous"
    old.mkdir()
    (old / "release.json").write_text('{"buildId":"old"}')
    (output / "server").symlink_to(old.name, target_is_directory=True)
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    (candidate / "release.json").write_text(
        json.dumps({"buildId": "new", "status": "FAILED"})
    )
    try:
        module.publish(candidate, output)
    except ValueError:
        pass
    else:
        raise AssertionError("Unverified release was published")
    assert (output / "server/release.json").read_text() == '{"buildId":"old"}'
    raw = json.dumps({"buildId": "new", "status": "VERIFIED"})
    (candidate / "release.json").write_text(raw)
    (candidate / "sha256sums").write_text("0" * 64 + "  release.json\n")
    with pytest.raises(ValueError, match="checksum"):
        module.publish(candidate, output)
    assert (output / "server/release.json").read_text() == '{"buildId":"old"}'
    (candidate / "sha256sums").write_text(
        sha256(raw.encode()).hexdigest() + "  release.json\n"
    )
    module.publish(candidate, output)
    assert (output / "server/release.json").read_text() == raw
    assert (old / "release.json").read_text() == '{"buildId":"old"}'


@pytest.mark.parametrize("signum", [15, 2], ids=["TERM", "INT"])
@pytest.mark.parametrize("phase", ["build", "clean-install", "wheelhouse", "npm-sbom"])
@pytest.mark.parametrize("detached", [False, True], ids=["same-group", "detached"])
def test_build_cancellation_holds_lock_until_stage_descendants_stop(
    tmp_path, signum, phase, detached, force_kill=False
):
    """真实构建入口在轻量替代 pnpm 阶段收到 TERM 或 INT 时，必须终止独立进程组并持锁等待仍可写入的后代退出；测试通过文件握手控制退出时机，不用业务超时或重复构建掩盖残留进程。

    替代工具只避免安装依赖，锁、构建函数、信号和子孙进程均是真实实现。
    阶段首进程收到 TERM 立即退出，孙进程延后退出，覆盖仅 wait 父进程的漏洞。
    """
    import fcntl
    import os
    import signal
    import time

    sandbox = tmp_path / "checkout"
    sandbox.mkdir()
    subprocess.run(["git", "init", "-q", str(sandbox)], check=True)
    (sandbox / ".gitignore").write_text("work/\n")
    subprocess.run(["git", "add", ".gitignore"], cwd=sandbox, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-qm",
            "test",
        ],
        cwd=sandbox,
        check=True,
    )
    tools = tmp_path / "bin"
    tools.mkdir()
    child = tmp_path / "descendant.py"
    child.write_text(
        "import os,signal,time\nfrom pathlib import Path\n"
        f"root=Path({str(tmp_path)!r})\n"
        "def stop(number,frame):\n"
        "    (root/'termination-seen').touch()\n"
        "    while not (root/'allow-exit').exists():\n"
        "        (root/'still-writable').write_text(str(time.monotonic())); time.sleep(0.01)\n"
        "    raise SystemExit(0)\n"
        "signal.signal(signal.SIGTERM,stop)\n"
        "(root/'descendant.pid').write_text(str(os.getpid()))\n"
        "while True: time.sleep(0.01)\n"
    )
    tool = (
        f"#!{sys.executable}\nimport os,signal,subprocess,sys,time\nfrom pathlib import Path\n"
        "if '--version' in sys.argv:\n"
        "    print({'pnpm':'11.25.0','node':'v24.22.1','uv':'uv 0.13.5'}[Path(sys.argv[0]).name]);sys.exit()\n"
        f"subprocess.Popen([sys.executable,{str(child)!r}],start_new_session={detached!r})\n"
        "signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))\n"
        "while True: time.sleep(0.01)\n"
    )
    for name in ("pnpm", "node", "uv"):
        (tools / name).write_text(tool)
        (tools / name).chmod(0o700)
    program = (
        "import sys\nfrom pathlib import Path\n"
        f"sys.path.insert(0,{str(ROOT / 'scripts')!r})\n"
        "from build_release import BuildOptions,build_release\n"
        f"build_release(BuildOptions(Path({str(sandbox)!r})))\n"
    )
    if phase != "build":
        calls = {
            "clean-install": "from verify_wheel import clean_install; clean_install(root/'candidate.whl',root/'house',run/'install',managed.run)",
            "wheelhouse": "from wheelhouse import wheelhouse; wheelhouse(root,run/'house',managed.run)",
            "npm-sbom": "from npm_sbom import npm_sbom; npm_sbom(root,run/'sbom',managed.run)",
        }
        program = (
            "import sys,fcntl,signal\nfrom pathlib import Path\n"
            f"sys.path.insert(0,{str(ROOT / 'scripts')!r})\n"
            "from release_processes import process_scope\n"
            f"root=Path({str(sandbox)!r}); run=root/'work/release-test'; run.mkdir(parents=True)\n"
            "with (root/'work/build.lock').open('w') as lock:\n"
            "    fcntl.flock(lock,fcntl.LOCK_EX)\n"
            "    with process_scope(run,lock.fileno()) as managed:\n"
            f"        {calls[phase]}\n"
        )
    import textwrap

    program = (
        "import subprocess,sys\nfrom pathlib import Path\n"
        "unrelated=subprocess.Popen([sys.executable,'-c','import signal; signal.pause()'])\n"
        f"Path({str(tmp_path / 'unrelated.pid')!r}).write_text(str(unrelated.pid))\n"
        "try:\n"
        + textwrap.indent(program, "    ")
        + "finally:\n    unrelated.terminate(); unrelated.wait()\n"
    )
    error_log = (tmp_path / "parent.log").open("w")
    parent = subprocess.Popen(
        [sys.executable, "-c", program],
        env={**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]},
        stdout=subprocess.DEVNULL,
        stderr=error_log,
    )
    descendant = None
    lock = None
    try:
        deadline = time.monotonic() + 10
        while not (tmp_path / "descendant.pid").exists() and parent.poll() is None:
            assert time.monotonic() < deadline, "Stage descendant was not started"
            time.sleep(0.01)
        assert parent.poll() is None, (tmp_path / "parent.log").read_text()
        descendant = int((tmp_path / "descendant.pid").read_text())
        parent.send_signal(signum)
        deadline = time.monotonic() + 3
        while not (tmp_path / "still-writable").exists() and parent.poll() is None:
            assert time.monotonic() < deadline, (
                "Cancellation did not reach stage descendant"
            )
            time.sleep(0.01)
        lock = os.open(sandbox / "work/build.lock", os.O_RDWR)
        with pytest.raises(BlockingIOError):
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert (tmp_path / "termination-seen").exists()
        assert (tmp_path / "still-writable").exists()
        unrelated = int((tmp_path / "unrelated.pid").read_text())
        assert Path(f"/proc/{unrelated}/stat").read_text().split(") ", 1)[1][0] != "Z"
        parent.send_signal(
            signal.SIGINT if signum == signal.SIGTERM else signal.SIGTERM
        )
        if not force_kill:
            (tmp_path / "allow-exit").touch()
        assert parent.wait(timeout=15 if force_kill else 5) != 0
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = Path(f"/proc/{descendant}/stat")
        assert not state.exists() or state.read_text().split(") ", 1)[1].startswith("Z")
        records = json.loads(
            next((sandbox / "work").glob("release-*/processes.json")).read_bytes()
        )
        assert any(item["cancelled"] and item["signal"] == signum for item in records)
    finally:
        (tmp_path / "allow-exit").touch()
        if descendant is not None:
            try:
                os.killpg(os.getpgid(descendant), signal.SIGKILL)
            except ProcessLookupError:
                pass
        if parent.poll() is None:
            parent.kill()
        parent.communicate()
        error_log.close()
        if (tmp_path / "unrelated.pid").exists():
            try:
                os.kill(int((tmp_path / "unrelated.pid").read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
        if lock is not None:
            os.close(lock)


def test_process_scope_restores_handlers_and_preserves_command_results(tmp_path):
    """进程作用域退出后必须恢复调用者原有 TERM 与 INT 行为，并保留真实命令的输出与非零退出语义；取消保护不能把失败命令改成成功，也不能污染后续共享进程中的信号处理器。

    两个短命令均由真实 Python 子进程执行，不替换 Popen 或信号函数。
    """
    import signal
    from release_processes import process_scope

    before = {
        number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT)
    }
    with (
        (tmp_path / "build.lock").open("w") as lock,
        process_scope(tmp_path, lock.fileno()) as managed,
    ):
        result = managed.run(
            [sys.executable, "-c", "print('captured')"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout == "captured\n"
        with pytest.raises(subprocess.CalledProcessError) as failure:
            managed.run([sys.executable, "-c", "raise SystemExit(7)"], check=True)
        assert failure.value.returncode == 7
    assert {number: signal.getsignal(number) for number in before} == before


def test_supervisor_loss_quarantines_build_before_another_tool_starts(tmp_path):
    """阶段监督者被异常杀死后不能证明其独立后代已经退出，必须留下持久隔离标记并拒绝下一次构建；真实残留进程仍存活时调用公开构建接口，确认不会以普通失败后重试方式启动新的写入阶段。

    测试只杀自己创建的监督者和残留进程，不接触现有构建或数据库。
    清理 finally 显式终止残留进程，隔离文件只存在测试临时目录。
    """
    import os
    import signal
    from build_release import BuildOptions, build_release
    from release_processes import process_scope

    run = tmp_path / "work/release-test"
    run.mkdir(parents=True)
    pid_file = tmp_path / "orphan.pid"
    command = (
        "import os,signal; from pathlib import Path; "
        f"Path({str(pid_file)!r}).write_text(str(os.getpid())); "
        "os.kill(os.getppid(),signal.SIGKILL); signal.pause()"
    )
    try:
        with (tmp_path / "work/build.lock").open("w") as lock:
            with process_scope(run, lock.fileno()) as managed:
                with pytest.raises(RuntimeError, match="quarantined"):
                    managed.run(
                        [sys.executable, "-c", command],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
        orphan = int(pid_file.read_text())
        assert Path(f"/proc/{orphan}/stat").read_text().split(") ", 1)[1][0] != "Z"
        with pytest.raises(ValueError, match="quarantined"):
            build_release(BuildOptions(tmp_path))
        assert not (tmp_path / "output/server").exists()
    finally:
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_sync_tail_cancellation_keeps_previous_output_pointer(tmp_path):
    """同步打包尾段在进入 publish 前收到取消信号时必须立即中止并保留旧输出指针，不能只记录标志等下一条子进程命令检查；实际信号握手模拟 tar 或摘要结束后的发布边界。

    此路径故意不启动受控阶段子进程，验证外层 Python 作用域本身的取消语义。
    原子输出函数仍是真实实现，未替换成只记录调用的测试替身。
    """
    import signal
    import time

    output = tmp_path / "output"
    previous = output / "old"
    previous.mkdir(parents=True)
    (previous / "release.json").write_text('{"buildId":"old"}')
    (output / "server").symlink_to("old")
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    raw = '{"buildId":"new","status":"VERIFIED"}'
    (candidate / "release.json").write_text(raw)
    (candidate / "sha256sums").write_text(
        sha256(raw.encode()).hexdigest() + "  release.json\n"
    )
    program = (
        "import sys,signal,fcntl; from pathlib import Path\n"
        f"sys.path.insert(0,{str(ROOT / 'scripts')!r})\n"
        "from release_processes import process_scope\nfrom build_release import publish\n"
        f"root=Path({str(tmp_path)!r})\n"
        "with (root/'build.lock').open('w') as lock:\n"
        "    fcntl.flock(lock,fcntl.LOCK_EX)\n"
        "    with process_scope(root,lock.fileno()):\n"
        "        (root/'ready').touch(); signal.pause()\n"
        "        publish(root/'candidate',root/'output')\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", program], stderr=subprocess.DEVNULL
    )
    try:
        deadline = time.monotonic() + 5
        while not (tmp_path / "ready").exists():
            assert parent.poll() is None and time.monotonic() < deadline
            time.sleep(0.01)
        parent.send_signal(signal.SIGTERM)
        assert parent.wait(timeout=5) != 0
        assert (output / "server").readlink() == Path("old")
        assert (output / "server/release.json").read_text() == '{"buildId":"old"}'
        assert candidate.exists()
        assert (
            json.loads((tmp_path / "cancellation.json").read_bytes())["signal"]
            == signal.SIGTERM
        )
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait()


def test_detached_descendant_exceeding_grace_is_killed_before_unlock(tmp_path):
    """独立 session 后代收到 TERM 后仍拒绝退出时，真实十秒清理宽限到期必须由监督者杀死并回收它，构建锁只能随后释放；此测试不改变 SDK 或其它业务超时，也不直接杀监督者代替回收。

    复用同一文件握手场景，仅不发出允许退出标记以覆盖实际 KILL 分支。
    """
    test_build_cancellation_holds_lock_until_stage_descendants_stop(
        tmp_path, 15, "build", True, force_kill=True
    )
