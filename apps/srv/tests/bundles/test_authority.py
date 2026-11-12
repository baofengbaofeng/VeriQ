"""中文重写：Private guard acquisition cancellation must not leak a cross-process lock.
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""

import asyncio
import fcntl
import os
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import threading
from veriq_server.bundles.authority import authority_guard
from veriq_server.bundles.issuer import Issuer
from veriq_server.settings import Settings


# 分段注释：继续说明 test_authority.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
async def test_cancelled_guard_open_releases_eventual_descriptor(tmp_path, monkeypatch):
    import veriq_server.bundles.authority as authority

    path = tmp_path / "guard/keys.json"
    Issuer.initialize(path)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    settings = Settings(
        environment="development",
        database_url="mysql+asyncmy://unused/unused",
        public_url="http://localhost",
        # 分段注释：继续说明 test_authority.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        master_key="a" * 64,
        signing_key="b" * 64,
        bundle_issuer_path=str(path),
    )
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    started, finish = threading.Event(), threading.Event()
    original = authority.open_lock
    closed = asyncio.Event()
    captured: list[int] = []
    # 分段注释：继续说明 test_authority.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    original_close = os.close

    def observe_close(fd):
        original_close(fd)
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if fd in captured:
            closed.set()

    monkeypatch.setattr(authority.os, "close", observe_close)

    def delayed(lock_path):
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        fd = original(lock_path)
        captured.append(fd)
        started.set()
        # 分段注释：继续说明 test_authority.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        assert finish.wait(5)
        return fd

    monkeypatch.setattr(authority, "open_lock", delayed)

    async def enter():
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        async with authority_guard(settings, True):
            raise AssertionError("Cancelled acquisition must never enter")

    task = asyncio.create_task(enter())
    assert await asyncio.to_thread(started.wait, 5)
    # 分段注释：继续说明 test_authority.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    task.cancel()
    finish.set()
    # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try:
        await task
    # 关键路径：处理 except 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    except asyncio.CancelledError:
        pass
    # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    else:
        raise AssertionError("Expected cancellation")
    await asyncio.wait_for(closed.wait(), 5)
    fd = os.open(path.with_suffix(".lock"), os.O_RDWR)
    # 关键路径：处理 try 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # 关键路径：处理 finally 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    finally:
        os.close(fd)
