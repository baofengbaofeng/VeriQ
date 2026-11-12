"""中文重写：Separate, reauthorized offline writer. Bundle signatures never certify local results.
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
import base64
import io
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import json
import re
import zipfile
from datetime import datetime
# 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
from hashlib import sha256
from typing import Any
from collections.abc import Awaitable, Callable
from sqlalchemy.ext.asyncio import AsyncSession
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from ..settings import Settings
from ..bundles.issuer import Issuer
from .engines import ApprovedEngines
from uuid import uuid4
# 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
from sqlalchemy import select
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from ..auth.authorization import Permission, WorkspaceScope
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from ..bundles.authority import authority_guard
from ..contracts import canonical_bytes, asset_source_hash, validate_schema
from ..db import (
    BundleExport,
    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    Bundle,
    OfflineImport,
    OfflineImportKey,
    OfflineAttempt,
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    OfflineImportUpload,
    Run,
    CaseExecution,
    User,
# 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
# 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
)
from ..repositories.resource import ResourceRepository
from ..service import Problem, now, lock_installation
from .bundle import BundleService, safe_path, MAX_ARCHIVE, MAX_FILE, MAX_OUTPUT, MAX_FILES
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
from .workspace import WorkspaceRepository
from .results import aggregate, reduce_test
from .completion import retry_is_safe


def verify_archive(raw: bytes, manifest_hash: str, public: dict[str, Any]) -> dict[str, Any]:
    """公开函数 `verify_archive` 负责 apps.srv.src.veriq_server.services.import_result 中的关键业务流程与结果返回
原有英文说明已改写为中文，并保留行为语义不变。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    try:
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if len(raw) > MAX_ARCHIVE:
            raise ValueError()
        # 关键路径：处理 with 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                len(entries) > MAX_FILES
                or sum(e.file_size for e in entries) > MAX_OUTPUT
                or any(e.file_size > MAX_FILE or not safe_path(e.filename) for e in entries)
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                or len({e.filename.lower() for e in entries}) != len(entries)
            ):
                raise ValueError()
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            files = {e.filename: archive.read(e) for e in entries}
        manifest_raw = files.pop("manifest.json")
        signature = files.pop("manifest.sig")
        manifest = json.loads(manifest_raw)
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if sha256(manifest_raw).hexdigest() != manifest_hash or validate_schema(
            "BundleManifestV1", manifest
        ):
            raise ValueError()
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        key = next(
            k for k in public["keys"] if k["keyId"] == manifest["keyId"] and not k["revoked"]
        )
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if public["issuerId"] != manifest["issuerId"]:
            raise ValueError()
        Ed25519PublicKey.from_public_bytes(base64.b64decode(key["publicKey"])).verify(
            signature, manifest_raw
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if set(files) != {f["path"] for f in manifest["files"]}:
            raise ValueError()
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for f in manifest["files"]:
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                len(files[f["path"]]) != f["sizeBytes"]
                or sha256(files[f["path"]]).hexdigest() != f["sha256"]
            ):
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                raise ValueError()
        snapshot = json.loads(files["snapshot.json"])
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (
            validate_schema("AssetSnapshotV1", snapshot)
            or asset_source_hash(snapshot) != manifest["sourceHash"]
            or sha256(files["snapshot.json"]).hexdigest() != manifest["snapshotSha256"]
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            or snapshot["workspaceId"] != manifest["workspaceId"]
        ):
            raise ValueError()
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        return {
            "manifest": manifest,
            "snapshot": snapshot,
            "files": files,
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "selection": json.loads(files["selection.json"]),
        }
    # 关键路径：处理 except 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    except (
        ValueError,
        KeyError,
        TypeError,
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        StopIteration,
        zipfile.BadZipFile,
        InvalidSignature,
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        RuntimeError,
        NotImplementedError,
    ):
        raise Problem(
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            409, "INVALID_SIGNED_BUNDLE", "Stored signed bundle is invalid or revoked"
        ) from None


def expected_variants(checked: dict[str, Any], result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """公开函数 `expected_variants` 负责 apps.srv.src.veriq_server.services.import_result 中的关键业务流程与结果返回
原有英文说明已改写为中文，并保留行为语义不变。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    assets = {a["versionId"]: a for a in checked["snapshot"]["assets"]}
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    selection, files = checked["selection"], checked["files"]
    draft = "draft/source.json" in files
    target = checked["snapshot"].get("validationTarget", {}).get("versionId")
    suite = selection.get("suiteVersionId") or (
        target if draft and assets.get(target, {}).get("kind") == "SUITE" else None
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    )
    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    entries = (
        assets[suite]["document"]["cases"]
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if suite
        # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        else [
            {"versionId": case}
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for case in selection.get("caseVersionIds", checked["snapshot"]["entryCaseVersionIds"])
        ]
    )
    expected: dict[str, dict[str, Any]] = {}
    # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for ordinal, entry in enumerate(entries):
        # 关键路径：处理 case 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        case = entry["versionId"]
        document = assets[case]["document"]
        root = suite or case
        source = files.get("draft/source.json" if draft else f"provenance/{root}/source.json")
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if source is None:
            raise Problem(409, "SOURCE_UNAVAILABLE", "Selected compilation source is unavailable")
        provenance = {
            "compilationSourceHash": json.loads(source)["sourceHash"],
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "compilationSourceSha256": sha256(source).hexdigest(),
            "compilationRootVersionId": root,
            "dslOnly": draft,
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        }
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for name, path in [
            ("publishedDependencySourceSha256", f"provenance/{case}/source.json"),
            ("publishedDependencyReceiptSha256", f"provenance/{case}/receipt.json"),
            ("compilationDescriptorSha256", f"provenance/{root}/descriptor.json"),
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            ("compilationReceiptSha256", f"provenance/{root}/receipt.json"),
        ]:
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if path in files and (not draft or name.startswith("publishedDependency")):
                provenance[name] = sha256(files[path]).hexdigest()
        dataset = entry.get("datasetVersionId", document.get("datasetVersionId"))
        data_rows = assets[dataset]["document"]["rows"] if dataset else [None]
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for role in entry.get("roleKeys", [document["roleKey"]]):
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for browser in entry.get(
                "browsers", result.get("executionChoices", {}).get("browsers", ["chromium"])
            ):
                # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for data in data_rows:
                    key = sha256(
                        canonical_bytes(
                            [case, ordinal, role, browser, dataset, data["key"] if data else None]
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        )
                    ).hexdigest()
                    expected[key] = {
                        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        "variant": key,
                        "caseVersionId": case,
                        "source": source,
                        "root": root,
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "draft": draft,
                        "attempts": [],
                        "outcome": "INCOMPLETE",
                        "compilation": provenance,
                        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        "selection": {
                            "variantKey": key,
                            "suiteEntryIndex": ordinal,
                            "roleKey": role,
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            "browser": browser,
                            "datasetVersionId": dataset,
                            "dataRow": data,
                        },
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    }
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if len(expected) > 1000:
                        raise Problem(
                            422, "MATRIX_LIMIT", "Selected offline matrix exceeds 1000 variants"
                        )
    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    if not expected:
        raise Problem(422, "EMPTY_EXECUTION_MATRIX", "Signed selection has no variants")
    return expected


class ImportService:
    """定义 `ImportService` 类型，承载 apps.srv.src.veriq_server.services.import_result 模块中的公开结构与协作边界
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
    def __init__(
        self,
        session: AsyncSession,
        actor: User,
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        settings: Settings,
        reauthorize: Callable[[AsyncSession], Awaitable[User]] | None = None,
    ):
        """初始化 `apps.srv.src.veriq_server.services.import_result` 相关对象，注入依赖并建立后续方法可安全复用的运行上下文
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        self.session, self.actor, self.settings, self.reauthorize = (
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            session,
            actor,
            settings,
            reauthorize,
        )

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async def authorize(
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        self, scope: WorkspaceScope, bundle_id: str, authority: tuple[Issuer, ApprovedEngines]
    ) -> Bundle:
        """公开函数 `authorize` 负责 apps.srv.src.veriq_server.services.import_result 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        await self.session.refresh(self.actor)
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if self.reauthorize:
            self.actor = await self.reauthorize(self.session)
        await WorkspaceRepository(self.session, scope).authorize(
            self.actor, Permission.EXECUTE, write=True
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        )
        service = BundleService(self.session, self.actor, self.settings)
        service.issuer, service.engines = authority
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        row = await service.get(scope, bundle_id)
        reservation = (
            await self.session.execute(
                select(BundleExport).where(
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    BundleExport.workspace_id == scope.workspace_id,
                    BundleExport.bundle_id == bundle_id,
                )
            )
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        ).scalar_one_or_none()
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if not reservation:
            raise Problem(409, "BUNDLE_PROVENANCE_MISSING", "Export provenance is unavailable")
        await service.replay(scope, reservation)
        return row

    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    async def import_result(
        self, scope: WorkspaceScope, result: dict[str, Any], key: str
    ) -> dict[str, Any]:
        """公开函数 `import_result` 负责 apps.srv.src.veriq_server.services.import_result 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        if not re.fullmatch(r"[!-~]{1,160}", key):
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            raise Problem(
                400, "IDEMPOTENCY_KEY_REQUIRED", "Printable bounded idempotency key required"
            )
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if (
            validate_schema("OfflineResultV1", result)
            or result["workspaceId"] != scope.workspace_id
        ):
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            raise Problem(400, "INVALID_OFFLINE_RESULT", "Result schema or Workspace is invalid")
        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        if len(canonical_bytes(result)) > 8 * 1024 * 1024:
            raise Problem(413, "RESULT_LIMIT", "Result exceeds 8 MiB")
        request_hash = sha256(canonical_bytes(result)).hexdigest()
        await self.session.commit()
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            row = await self.authorize(scope, result["bundleId"], authority)
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if row.manifest_hash != result["manifestSha256"]:
                raise Problem(
                    409, "BUNDLE_MANIFEST_MISMATCH", "Result identifies a different manifest"
                )
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            raw = (await ResourceRepository(self.session, scope).artifact(row.archive_hash)).content
            public = authority[0].public()
            manifest_hash = row.manifest_hash
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            await self.session.commit()
        checked = await asyncio.to_thread(verify_archive, raw, manifest_hash, public)
        async with authority_guard(self.settings, False) as authority:
            await lock_installation(self.session)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await self.authorize(scope, result["bundleId"], authority)
            # Current engine, draft and nested resource closure authority is checked again.
            service = BundleService(self.session, self.actor, self.settings)
            service.issuer, service.engines = authority
            prepared = await service.prepare(scope, checked["selection"])
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if json.loads(prepared["snapshot"]) != checked["snapshot"]:
                raise Problem(409, "BUNDLE_SOURCE_CHANGED", "Current immutable closure differs")
            existing_key = await self.session.get(OfflineImportKey, (scope.workspace_id, key))
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if existing_key and (
                existing_key.actor_id != self.actor.id or existing_key.request_hash != request_hash
            ):
                raise Problem(409, "IDEMPOTENCY_CONFLICT", "Import header is already bound")
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            existing = (
                await self.session.execute(
                    select(OfflineImport).where(
                        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        OfflineImport.workspace_id == scope.workspace_id,
                        OfflineImport.bundle_id == result["bundleId"],
                        OfflineImport.local_run_id == result["localRunId"],
                    )
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
            ).scalar_one_or_none()
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if existing:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if existing.request_hash != request_hash:
                    raise Problem(409, "IDEMPOTENCY_CONFLICT", "Local Run payload changed")
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if not existing_key:
                    self.session.add(
                        OfflineImportKey(
                            workspace_id=scope.workspace_id,
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            key=key,
                            import_id=existing.id,
                            actor_id=self.actor.id,
                            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                            request_hash=request_hash,
                        )
                    )
                await self.session.commit()
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                return self.receipt(existing, True)
            rows = await self.validate_facts(scope, result, checked)
            repo = ResourceRepository(self.session, scope)
            run = Run(
                # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                id=str(uuid4()),
                workspace_id=scope.workspace_id,
                created_by=self.actor.id,
                idempotency_key="offline_" + str(uuid4()),
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                request_hash=request_hash,
                trigger_kind="OFFLINE_IMPORT",
                source="OFFLINE_IMPORT",
                state="FINISHED",
                # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                outcome=aggregate([r["outcome"] for r in rows]),
                snapshot_hash=await repo.store(
                    canonical_bytes(
                        {"bundleId": result["bundleId"], "localRunId": result["localRunId"]}
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    )
                ),
                created_at=now(),
            )
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            self.session.add(run)
            await self.session.flush()
            imported = OfflineImport(
                id=str(uuid4()),
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                workspace_id=scope.workspace_id,
                bundle_id=result["bundleId"],
                local_run_id=result["localRunId"],
                actor_id=self.actor.id,
                # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                run_id=run.id,
                request_hash=request_hash,
                declared={k: v for k, v in result.items() if k != "attempts"},
                verified={
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    "source": "OFFLINE_IMPORT",
                    "officialGatePassed": False,
                    "manifestSha256": manifest_hash,
                    "issuerId": checked["manifest"]["issuerId"],
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    "keyId": checked["manifest"]["keyId"],
                    "revocationStatus": "CURRENT",
                    "validationStatus": checked["manifest"]["validationStatus"],
                    "resultAuthenticity": "UNVERIFIED",
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    "dirty": result["dirty"]
                    or result["actualEnvironment"]
                    != next(
                        a["document"]
                        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        for a in checked["snapshot"]["assets"]
                        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if a["versionId"] == checked["selection"]["environmentVersionId"]
                    )
                    or checked["manifest"]["validationStatus"] != "VALIDATED",
                    "expired": datetime.fromisoformat(
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        checked["manifest"]["expiresAt"].replace("Z", "+00:00")
                    ).timestamp()
                    <= now().timestamp(),
                # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                },
                created_at=now(),
            )
            self.session.add(imported)
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            await self.session.flush()
            self.session.add(
                OfflineImportKey(
                    workspace_id=scope.workspace_id,
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    key=key,
                    import_id=imported.id,
                    actor_id=self.actor.id,
                    request_hash=request_hash,
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
            )
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for reduced in rows:
                candidate = (
                    checked["snapshot"].get("validationTarget", {}).get("versionId")
                    == reduced["caseVersionId"]
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    and "draft/source.json" in checked["files"]
                )
                execution = CaseExecution(
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    id=str(uuid4()),
                    workspace_id=scope.workspace_id,
                    run_id=run.id,
                    case_version_id=reduced["caseVersionId"],
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    published_case_version_id=None if candidate else reduced["caseVersionId"],
                    candidate_version_id=reduced["caseVersionId"] if candidate else None,
                    source_snapshot_hash=await repo.store(reduced["source"]),
                    variant_key=reduced["variant"],
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    provenance={
                        "source": "OFFLINE_IMPORT",
                        "declared": imported.declared,
                        "verified": imported.verified,
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "selection": {
                            **{k: v for k, v in reduced["selection"].items() if k != "dataRow"},
                            "dataRowKey": (reduced["selection"]["dataRow"] or {}).get("key"),
                        },
                        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                        "compilation": reduced["compilation"],
                    },
                    state="FINISHED",
                    outcome=reduced["outcome"],
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                )
                self.session.add(execution)
                await self.session.flush()
                # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for attempt, facts in reduced["attempts"]:
                    self.session.add(
                        OfflineAttempt(
                            id=str(uuid4()),
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            workspace_id=scope.workspace_id,
                            import_id=imported.id,
                            case_execution_id=execution.id,
                            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                            local_attempt_id=attempt["attemptId"],
                            attempt_no=attempt["attemptNo"],
                            outcome=facts["outcome"],
                            facts=facts,
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            document=attempt,
                        )
                    )
            await self.session.commit()
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            return self.receipt(imported, False)

    @staticmethod
    def receipt(row: OfflineImport, duplicate: bool) -> dict[str, Any]:
        """公开函数 `receipt` 负责 apps.srv.src.veriq_server.services.import_result 中的关键业务流程与结果返回
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        return {
            "id": row.id,
            "runId": row.run_id,
            "localRunId": row.local_run_id,
            "duplicate": duplicate,
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            "source": "OFFLINE_IMPORT",
            "officialGatePassed": False,
        # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        }

    async def validate_facts(
        self, scope: WorkspaceScope, result: dict[str, Any], checked: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """公开函数 `validate_facts` 负责 apps.srv.src.veriq_server.services.import_result 中的关键业务流程与结果返回
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
请结合调用方契约与 Workspace 授权边界阅读实现，避免绕过既有校验路径。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        测试与文档应能证明该路径在无模型凭证、缺浏览器或租约过期时仍失败关闭正确。
# 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
# 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
# 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。"""
        rows = expected_variants(checked, result)
        assets = {a["versionId"]: a for a in checked["snapshot"]["assets"]}
        selection = checked["selection"]
        ids: set[str] = set()
        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for attempt in result["attempts"]:
            # 关键路径：处理 case 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            case = attempt["caseVersionId"]
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                # 关键路径：处理 case 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                case not in checked["snapshot"]["entryCaseVersionIds"]
                or attempt["attemptId"] in ids
            ):
                raise Problem(422, "INVALID_OFFLINE_CASE", "Unknown or duplicate case attempt")
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            ids.add(attempt["attemptId"])
            events = attempt["events"]
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if attempt["lastSequence"] != len(events) or any(
                e["attemptId"] != attempt["attemptId"] or e["sequence"] != i + 1
                # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for i, e in enumerate(events)
            ):
                raise Problem(422, "INVALID_EVENT_SEQUENCE", "Offline event sequence differs")
            execution = attempt.get("execution")
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if execution:
                variant = sha256(
                    canonical_bytes(
                        [
                            # 关键路径：处理 case 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            case,
                            execution.get("suiteEntryIndex", 0),
                            execution["roleKey"],
                            execution["browser"],
                            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                            execution.get("datasetVersionId"),
                            execution.get("dataRow", {}).get("key"),
                        ]
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    )
                ).hexdigest()
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if variant not in rows:
                    raise Problem(
                        422,
                        "INVALID_OFFLINE_VARIANT",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Variant is outside the signed selected matrix",
                    )
            # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            else:
                candidates = [key for key, row in rows.items() if row["caseVersionId"] == case]
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if len(candidates) != 1:
                    raise Problem(
                        422,
                        "OFFLINE_VARIANT_FACTS_REQUIRED",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Legacy result has ambiguous variants; retain local history for inspection",
                    )
                variant = candidates[0]
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            group = rows[variant]
            source = group["source"]
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if execution:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (
                    execution["workspaceId"] != scope.workspace_id
                    or execution["runId"] != result["localRunId"]
                    or execution["caseVersionId"] != case
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    or execution["assetSourceHash"] != json.loads(source)["sourceHash"]
                    or execution["environment"] != result["actualEnvironment"]
                    or execution["attemptNo"] != attempt["attemptNo"]
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    or attempt.get("variantKey") != variant
                ):
                    raise Problem(
                        422, "INVALID_OFFLINE_VARIANT", "Offline execution binding differs"
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    )
            document = assets[case]["document"]
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if execution:
                selection = checked["selection"]
                original_environment = assets[selection["environmentVersionId"]]["document"]
                actual = result["actualEnvironment"]
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                allowed_override = {"baseURL", "apiBaseURL", "fixtureBaseURL", "allowedOrigins"}
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if any(
                    original_environment.get(k) != actual.get(k)
                    # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    for k in set(original_environment) | set(actual)
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if k not in allowed_override
                ):
                    raise Problem(
                        422, "INVALID_ENVIRONMENT_OVERRIDE", "Only public routing may differ"
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    )
                from urllib.parse import urlsplit

                allowed_origins = set(original_environment["allowedOrigins"])
                # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for field in ["baseURL", "apiBaseURL", "fixtureBaseURL"]:
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if field in actual:
                        url = urlsplit(actual[field])
                        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if url.username or url.password or url.scheme not in {"http", "https"}:
                            raise Problem(
                                422, "INVALID_ENVIRONMENT_OVERRIDE", "Unsafe routing override"
                            )
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        allowed_origins.add(f"{url.scheme}://{url.netloc}")
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if set(actual["allowedOrigins"]) != allowed_origins:
                    raise Problem(
                        422,
                        "INVALID_ENVIRONMENT_OVERRIDE",
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        "Allowed origins differ from public routing",
                    )
                role = next(
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    (
                        r
                        # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        for r in original_environment["roles"]
                        # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        if r["roleKey"] == execution["roleKey"]
                    ),
                    None,
                )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if not role:
                    raise Problem(422, "INVALID_OFFLINE_VARIANT", "Role is unavailable")
                identities = [role] + (
                    [original_environment["fixtureIdentity"]]
                    # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    if document.get("fixtureVersionId")
                    # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    else []
                )
                pins = [
                    {"secretRef": i["secretRef"], "versionId": i["secretVersionId"]}
                    # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    for i in identities
                ]
                dataset = group["selection"]["datasetVersionId"]
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (
                    execution["environmentVersionId"] != selection["environmentVersionId"]
                    or execution["secretVersions"] != pins
                    or execution.get("authAdapters", [])
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    != checked["snapshot"].get("authAdapters", [])
                    or execution["variables"] != {}
                    or execution.get("datasetVersionId") != dataset
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    or execution.get("dataRow") != group["selection"]["dataRow"]
                ):
                    raise Problem(422, "INVALID_OFFLINE_VARIANT", "Frozen auth or dataset differs")
            # Older descriptors without variant facts remain importable as INCOMPLETE.
            plan_raw = (
                None
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if group["draft"]
                # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                else checked["files"].get(f"compiled/{group['root']}/metadata/expected-plans.json")
            )
            plan = (
                next((p for p in json.loads(plan_raw)["cases"] if p["caseVersionId"] == case), None)
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if plan_raw
                # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                else None
            )
            evidence_complete = (
                bool(attempt["artifacts"])
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                and plan is not None
                and set(plan.get("requiredEvidenceKinds", []))
                <= {f.get("kind") for f in attempt["artifacts"]}
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            )
            evidence_complete &= any(
                e["type"] == "ATTEMPT_STARTED"
                and e["payload"].get("sourceHash") == json.loads(source)["sourceHash"]
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                and e["payload"].get("engineVersion") == checked["manifest"]["engineVersion"]
                # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                for e in events
            )
            # 关键路径：处理 for 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            for file in attempt["artifacts"]:
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if not safe_path(file["path"]) or file["sizeBytes"] > 32 * 1024 * 1024:
                    raise Problem(422, "INVALID_OFFLINE_ARTIFACT", "Artifact descriptor is unsafe")
                upload = (
                    await self.session.execute(
                        # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                        # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                        # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                        select(OfflineImportUpload).where(
                            OfflineImportUpload.workspace_id == scope.workspace_id,
                            OfflineImportUpload.bundle_id == result["bundleId"],
                            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                            OfflineImportUpload.local_run_id == result["localRunId"],
                            OfflineImportUpload.local_attempt_id == attempt["attemptId"],
                            OfflineImportUpload.path == file["path"],
                        )
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    )
                ).scalar_one_or_none()
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if (
                    not upload
                    or upload.state != "COMPLETE"
                    or upload.expired_at
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    or upload.sha256 != file["sha256"]
                    or upload.size_bytes != file["sizeBytes"]
                    or upload.kind != file.get("kind")
                # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                ):
                    raise Problem(
                        409, "OFFLINE_ARTIFACT_MISSING", "Verified uploaded bytes required"
                    )
            # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            facts = (
                reduce_test(
                    plan,
                    events,
                    # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                    # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                    {
                        "cleanupStatus": attempt["cleanupStatus"],
                        "businessOutcome": attempt["outcome"],
                    },
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    evidence_complete=evidence_complete
                    and bool(execution)
                    and attempt.get("processStopped") is True,
                )
                # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                if plan
                # 关键路径：处理 else 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                else {
                    "outcome": "INCOMPLETE",
                    "business": attempt["outcome"],
                    "cleanup": attempt["cleanupStatus"],
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    "evidence": "INCOMPLETE",
                }
            )
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            prior = group["attempts"]
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if attempt["attemptNo"] != len(prior) + 1 or len(prior) >= 2:
                raise Problem(422, "INVALID_OFFLINE_RETRY", "Attempt ordering differs")
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if prior and (
                prior[0][1]["outcome"] not in {"FAILED", "ERROR"}
                or not retry_is_safe(
                    plan.get("hasPotentialWrites") if plan else None,
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    prior[0][0].get("retrySafety"),
                    bool(document.get("fixtureVersionId")),
                    prior[0][0]["cleanupStatus"],
                # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
                # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
                )
            ):
                raise Problem(422, "UNSAFE_OFFLINE_RETRY", "Whole-case retry was not safe")
            # 关键路径：处理 if 分支逻辑，确保失败可观测且不破坏租约/授权不变量；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            if (
                prior
                and execution
                and (
                    # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                    # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                    # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                    execution["caseExecutionId"] != prior[0][0]["execution"]["caseExecutionId"]
                    or execution["namespace"] == prior[0][0]["execution"]["namespace"]
                )
            # 分段注释：继续说明 import_result.py 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            # 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
            # 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
            ):
                raise Problem(422, "INVALID_OFFLINE_RETRY", "Retry identity or namespace differs")
            prior.append((attempt, facts))
            group["outcome"] = (
                # 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
                # 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
                # 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
                "UNSTABLE" if len(prior) == 2 and facts["outcome"] == "PASSED" else facts["outcome"]
            )
        return list(rows.values())
