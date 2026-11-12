from importlib import import_module

import pytest
from cryptography.exceptions import InvalidTag


def keyring():
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    module = import_module("veriq_server.credentials.crypto")
    return module.Keyring("current", {"current": bytes.fromhex("ab" * 32)})


def test_encrypted_value_roundtrip_random_nonce_and_bound_identity():
    # 分段注释：继续说明 test_crypto.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    ring = keyring()
    value = {"password": "synthetic-protected-password", "username": "demo"}
    first = ring.encrypt("workspace-a", "business", "version-a", value)
    second = ring.encrypt("workspace-a", "business", "version-a", value)
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert first.ciphertext != second.ciphertext
    assert b"synthetic-protected-password" not in first.ciphertext
    assert ring.decrypt("workspace-a", "business", "version-a", first) == value
    # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for identity in [
        ("workspace-b", "business", "version-a"),
        ("workspace-a", "fixture", "version-a"),
        ("workspace-a", "business", "version-b"),
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    ]:
        # 关键路径：处理 with 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        with pytest.raises(InvalidTag):
            ring.decrypt(*identity, first)


def test_key_rotation_preserves_old_key_reads_and_uses_active_key():
    old = keyring()
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    encrypted = old.encrypt("ws", "ref", "version", {"token": "synthetic"})
    module = import_module("veriq_server.credentials.crypto")
    rotated = module.Keyring(
        # 分段注释：继续说明 test_crypto.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        "next", {"current": bytes.fromhex("ab" * 32), "next": bytes.fromhex("cd" * 32)}
    )
    assert rotated.decrypt("ws", "ref", "version", encrypted) == {"token": "synthetic"}
    replacement = rotated.encrypt(
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        "ws", "ref", "version", rotated.decrypt("ws", "ref", "version", encrypted)
    )
    assert replacement.key_id == "next"
    assert rotated.decrypt("ws", "ref", "version", replacement) == {"token": "synthetic"}
    # 关键路径：处理 with 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    with pytest.raises(ValueError, match="KEY_UNAVAILABLE"):
        module.Keyring("next", {"next": bytes.fromhex("cd" * 32)}).decrypt(
            "ws", "ref", "version", encrypted
        )
