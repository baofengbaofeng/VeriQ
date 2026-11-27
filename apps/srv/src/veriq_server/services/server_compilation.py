"""独立编译进程处理已冻结的校验作业，短事务领取与核验回执，耗时的 Node 编译在事务及控制服务进程之外进行。

数据库期限和独立围栏只授权当前服务端编译结果，历史设备尝试仍拥有原有的独立回执路径。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import asset_source_hash, canonical_bytes, validate_schema
from ..db import Attempt, Database, Job, User, ValidationReceipt
from ..repositories.resource import ResourceRepository
from ..server_compiler import ServerCompileError, compile_snapshot, local_release_available
from ..service import Problem, audit, lock_installation
from ..settings import Settings
from .connected_datasets import http_capabilities, project_source, upgrade_queued
from .engines import ApprovedEngines, supports_validation
from .execution_principal import ServicePrincipal
from .jobs import database_time
from .resource import ResourceService
from .workspace import WorkspaceRepository

logger = logging.getLogger(__name__)
_LEASE = timedelta(minutes=5)
_BUILD_LIMIT = 240
_IDLE_POLL = 1
_MAX_DB_RETRY = 30
# 各错误码对应 MySQL 的连接中断、死锁或锁等待超时，迁移缺失和权限配置故障不会在轮询中被隐藏。
_TRANSIENT_MYSQL_ERRORS = (1205, 1213, 2002, 2003, 2006, 2013, 2055)


@dataclass(frozen=True)
class _Claim:
    """领取后将数据库读出的不可变输入随围栏带到编译进程，回写仍需重新核对持久作业和批准库存。"""

    job_id: str
    compilation_id: str
    source_digests: tuple[str, str]
    inventory_hash: str
    engine: dict[str, Any]
    snapshot: dict[str, Any]
    connected: bool


def _invalid_output(message: str) -> Problem:
    """将编译产物核对失败统一归入稳定的问题码，展示可定位的固定说明而不回传编译器原始异常。"""
    return Problem(409, "INVALID_COMPILED_BUNDLE", message)


def verify_compiled_output(
    snapshot: dict[str, Any],
    engine: dict[str, Any],
    bundle_bytes: bytes,
    files: dict[str, bytes],
    *,
    connected: bool,
) -> None:
    """核对实际编译字节、固定库存和冻结入口，任何描述符对应的成员都须在签发回执前验证摘要及长度。"""
    bundle = json.loads(bundle_bytes)
    if (
        validate_schema("CompiledAssetBundle", bundle)
        or canonical_bytes(bundle) != bundle_bytes
        or bundle["sourceHash"] != snapshot["sourceHash"]
        or any(
            bundle[key] != engine[key]
            for key in ("engineVersion", "compilerVersion", "runnerSdkVersion", "dependencies")
        )
    ):
        raise _invalid_output("Compiled descriptor differs from frozen source or approved engine")

    # 描述符中的路径不是文件系统读取请求，仅能匹配编译桥已安全读取并返回的同名文件和实际字节。
    declared = {item["path"]: item for item in bundle["files"]}
    approved = {item["path"]: item for item in engine["files"]}
    if (
        len(declared) != len(bundle["files"])
        or set(files) != set(declared) | {"engine/compiler.tgz"}
        or "engine/compiler.tgz" in declared
        or any(
            declared.get(path) != entry
            for path, entry in approved.items()
            if path != "engine/compiler.tgz"
        )
    ):
        raise _invalid_output("Compiled inventory differs from approved files")
    for path, content in files.items():
        entry = approved[path] if path == "engine/compiler.tgz" else declared[path]
        if entry["sizeBytes"] != len(content) or entry["sha256"] != sha256(content).hexdigest():
            raise _invalid_output("Compiled file bytes differ from retained descriptor")

    # 入口必须精确对应服务端冻结的 CASE 版本，零入口输出只能作为资源校验产物保留。
    case_ids = sorted(snapshot["entryCaseVersionIds"])
    entries = bundle["entrypoints"]
    if (
        sorted(entry["caseVersionId"] for entry in entries) != case_ids
        or bool(bundle.get("validationOnly")) != (not case_ids)
        or (not case_ids and "validation.ts" not in files)
        or any(
            entry["path"] != f"cases/{entry['caseVersionId']}.test.ts" or entry["path"] not in files
            for entry in entries
        )
    ):
        raise _invalid_output("Compiled entrypoints differ from frozen source")

    # 可执行入口的旁车省略临时验证目标，联网投影从同一份冻结文档推导，不能替换成客户端声明的快照。
    expected = (
        {key: value for key, value in snapshot.items() if key != "validationTarget"}
        if case_ids
        else snapshot
    )
    if connected:
        expected = project_source(expected)
    if files.get("source/asset-snapshot.json") != canonical_bytes(expected):
        raise _invalid_output("Compiled source sidecar differs from frozen source")
    plans = json.loads(files.get("metadata/expected-plans.json", b"null"))
    if (
        validate_schema("ExpectedPlansV1", plans)
        or sorted(plan["caseVersionId"] for plan in plans["cases"]) != case_ids
    ):
        raise _invalid_output("Compiled expected plans differ from frozen source")


async def _authorize(session: AsyncSession, job: Job, settings: Settings) -> None:
    """领取与接纳结果均复查当前发起者的空间权限，计划兼容重验证沿用独立服务主体的授权规则。"""
    try:
        if job.requester_service_token_id:
            plan_id = job.required_capabilities.get("revalidationPlanId")
            if not isinstance(plan_id, str):
                raise Problem(403, "REQUESTER_REVOKED", "Current plan scope required")
            principal = ServicePrincipal(job.requester_service_token_id, job.created_by)
            await principal.require(session, job.workspace_id, plan_id, "trigger")
            return
        user = await session.get(User, job.created_by)
        if not user or user.disabled:
            raise Problem(403, "REQUESTER_REVOKED", "Validation requester is inactive")
        scope = WorkspaceScope(job.workspace_id)
        if job.required_capabilities.get("publishedValidationJobId"):
            await WorkspaceRepository(session, scope).authorize(
                user, Permission.EXECUTE, write=True
            )
        else:
            await ResourceService(session, user, settings=settings).editable(scope, job.subject_id)
    except Problem as error:
        if error.status not in (401, 403, 404):
            raise
        # 原请求者权限变化只终结持有当前围栏的校验，后来获得权限的操作者仍能显式提交同一修订的新校验。
        raise Problem(
            403, "REQUESTER_REVOKED", "Validation requester authorization is inactive"
        ) from None


async def _source(repo: ResourceRepository, job: Job) -> tuple[dict[str, Any], bool]:
    """核对冻结源和清单的摘要、工作区、资源、修订及引擎，按原协议验证通过后补齐历史验证作业的联网投影。"""
    snapshot = json.loads((await repo.artifact(job.snapshot_hash)).content)
    manifest = json.loads((await repo.artifact(job.manifest_hash)).content)
    if validate_schema("AssetSnapshotV1", snapshot) or "validationTarget" not in snapshot:
        raise Problem(409, "INVALID_COMPILED_SOURCE", "Frozen validation source has invalid shape")
    if (
        snapshot["workspaceId"] != job.workspace_id
        or snapshot["engineVersion"] != job.required_capabilities.get("engineVersion")
        or asset_source_hash(snapshot) != snapshot["sourceHash"]
        or snapshot["validationTarget"]["resourceId"] != job.subject_id
    ):
        raise Problem(409, "INVALID_COMPILED_SOURCE", "Frozen validation source is inconsistent")
    connected = bool(job.required_capabilities.get("connectedDatasets"))
    projected = project_source(snapshot) if connected else snapshot
    expected = {
        "schemaVersion": "1.0",
        "workspaceId": job.workspace_id,
        "jobId": job.id,
        "kind": "VALIDATE",
        "resourceId": job.subject_id,
        "revision": snapshot["validationTarget"]["revision"],
        "sourceHash": snapshot["sourceHash"],
        "engineVersion": snapshot["engineVersion"],
        "snapshotSha256": sha256(canonical_bytes(projected)).hexdigest(),
    }
    if manifest != expected or (
        await repo.artifact(expected["snapshotSha256"])
    ).content != canonical_bytes(projected):
        raise Problem(409, "INVALID_COMPILED_SOURCE", "Frozen validation manifest is inconsistent")
    # 清单须先与原协议的冻结输入完全吻合，才可升级尚未执行的历史验证，避免把损坏的来源改写成可信投影。
    if (not connected and any(asset["kind"] == "DATASET" for asset in snapshot["assets"])) or (
        connected
        and not job.required_capabilities.get("httpDatasets")
        and http_capabilities(snapshot)
    ):
        async with repo.session.begin_nested():
            await upgrade_queued(repo, job)
    return snapshot, bool(job.required_capabilities.get("connectedDatasets"))


def _error_result(code: str, diagnostics: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """保留编译器安全结构化诊断及错误码，超界或不符合契约的值不进入作业响应和审计记录。"""
    result: dict[str, Any] = {
        "errorCode": code if re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code) else "COMPILATION_FAILED"
    }
    if (
        diagnostics
        and len(diagnostics) <= 100
        and all(not validate_schema("CompilerDiagnosticV1", entry) for entry in diagnostics)
    ):
        result["diagnostics"] = diagnostics
    return result


def _finish_job(
    session: AsyncSession, job: Job, outcome: str, error: dict[str, Any] | None = None
) -> None:
    """固定服务端编译的终态并撤销活动围栏期限，审计归因到原始发起人而不记录资源正文或编译日志。"""
    job.state, job.outcome, job.wait_reason = "FINISHED", outcome, None
    job.server_compile_expires_at = None
    job.server_compile_result = error
    audit(
        session,
        "resource.server_compilation_finished",
        job.created_by,
        job.id,
        workspace_id=job.workspace_id,
    )


def _local_engines(settings: Settings) -> dict[str, dict[str, Any]]:
    """单目录对应当前配置的引擎版本，历史发行可通过版本映射独立部署，每个目录都须核对批准的字节。"""
    inventory = ApprovedEngines(settings)
    engines = {}
    for version in sorted(
        {settings.validation_engine_version, *settings.server_compiler_release_dirs}
    ):
        try:
            engine, _ = inventory.require(version)
        except Problem:
            continue
        if local_release_available(settings, engine):
            engines[version] = engine
    return engines


def _eligible(engine: dict[str, Any]) -> ColumnElement[bool]:
    """在队列查询中按冻结引擎版本及批准的数据能力筛选，使节点可以越过队首继续处理本机能运行的作业。"""
    caps = Job.required_capabilities
    eligible: ColumnElement[bool] = caps["engineVersion"].as_string() == engine["engineVersion"]
    for capability in ("connectedDatasets", "httpDatasets"):
        if not supports_validation(engine, {capability: True}):
            eligible = and_(eligible, caps[capability].as_string().is_(None))
    return eligible


async def _claim(db: Database, settings: Settings) -> _Claim | None:
    """领取待校验作业或替换过期的服务端围栏，已转交旧设备的在途执行仍按既有设备协议保持租约并结案。

    全局安装锁串行化设备旧租约和新 Worker 领取。只在事务内读取权威工作区、批准库存和冻结内容。
    """
    engines = _local_engines(settings)
    if not engines:
        return None
    async with db.sessions.begin() as session:
        await lock_installation(session)
        clock = await database_time(session)
        job = (
            await session.execute(
                select(Job)
                .where(
                    Job.kind == "VALIDATE",
                    or_(*(_eligible(engine) for engine in engines.values())),
                    Job.active_attempt_id.is_(None),
                    ~select(Attempt.id)
                    .where(
                        Attempt.workspace_id == Job.workspace_id,
                        Attempt.job_id == Job.id,
                        Attempt.phase != "FINISHED",
                    )
                    .exists(),
                    or_(
                        Job.state == "QUEUED",
                        and_(
                            Job.state == "RUNNING",
                            Job.server_compilation_id.is_not(None),
                            Job.server_compile_expires_at <= clock,
                        ),
                    ),
                )
                .order_by(Job.created_at, Job.id)
                .limit(1)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if job is None:
            return None

        version = job.required_capabilities["engineVersion"]
        engine = engines[version]
        inventory_hash = sha256(canonical_bytes(engine)).hexdigest()
        try:
            ApprovedEngines(settings).require_validation(
                version, job.required_capabilities, inventory_hash=inventory_hash
            )
        except Problem:
            # 本机探测与事务内复核之间批准库存已经变化，下轮轮询将重新确认可用发行，本轮保持原作业状态。
            return None

        # 在同一数据库事务中改换围栏，将已过期的领取与本次领取永久区分，阻止旧进程覆盖本次作业结论。
        job.server_compilation_id = str(uuid4())
        job.server_compile_expires_at = clock + _LEASE
        job.server_compile_result = None
        job.state, job.outcome, job.wait_reason = "RUNNING", None, None
        repo = ResourceRepository(session, WorkspaceScope(job.workspace_id))
        try:
            await _authorize(session, job, settings)
            snapshot, connected = await _source(repo, job)
        except (Problem, ValueError, KeyError, TypeError) as error:
            code = error.code if isinstance(error, Problem) else "INVALID_COMPILED_SOURCE"
            _finish_job(session, job, "ERROR", _error_result(code))
            return None
        if not supports_validation(engine, job.required_capabilities):
            # 旧清单可能未声明实际依赖的数据协议，保存升级后的要求并释放围栏，供拥有对应发行的节点继续领取。
            job.state = "QUEUED"
            job.server_compilation_id = None
            job.server_compile_expires_at = None
            return None
        return _Claim(
            job.id,
            job.server_compilation_id,
            (job.snapshot_hash, job.manifest_hash),
            inventory_hash,
            engine,
            snapshot,
            connected,
        )


async def _finalize(
    db: Database,
    settings: Settings,
    claim: _Claim,
    output: tuple[bytes, dict[str, bytes]] | None,
    error: dict[str, Any] | None,
) -> None:
    """在发布回执与持久编译字节原子提交之前，再次检查当前围栏、期限、发起者和批准引擎。"""
    async with db.sessions.begin() as session:
        await lock_installation(session)
        clock = await database_time(session)
        repo = ResourceRepository(session, WorkspaceScope(claim.snapshot["workspaceId"]))
        job = await repo.job(claim.job_id)
        # 数据库来源约束禁止服务端标识与活动设备尝试并存，结束时仍须验证当前作业确实持有本次编译围栏。
        if (
            job.state != "RUNNING"
            or job.server_compilation_id != claim.compilation_id
            or job.server_compile_expires_at is None
            or job.server_compile_expires_at <= clock
        ):
            return
        # 作业若在执行期间被重建或库存被撤销，曾经领取的结果不能继续获得当前环境的可信回执。
        try:
            if (job.snapshot_hash, job.manifest_hash) != claim.source_digests:
                raise Problem(409, "STALE_SOURCE_HASH", "Frozen validation input changed")
            await _authorize(session, job, settings)
            ApprovedEngines(settings).require_validation(
                claim.snapshot["engineVersion"],
                job.required_capabilities,
                inventory_hash=claim.inventory_hash,
            )
        except Problem as problem:
            error = _error_result(problem.code)
        if error is not None or output is None:
            _finish_job(session, job, "ERROR", error or _error_result("COMPILATION_FAILED"))
            return
        if not await _retain_compilation(repo, job, claim.snapshot, *output):
            # 大型产物持久化也可能用尽围栏期限，回滚这次尚未签发的所有字节，使重新领取可从冻结源独立重建。
            await session.rollback()
            return
        _finish_job(session, job, "PASSED")


async def _retain_compilation(
    repo: ResourceRepository,
    job: Job,
    snapshot: dict[str, Any],
    bundle: bytes,
    files: dict[str, bytes],
) -> bool:
    """在围栏事务中保存已核验的原始字节和规范回执，任何文件写入失败都会使整次接受原子回滚。"""
    for path, content in files.items():
        media_type = "text/typescript" if path.endswith(".ts") else "application/octet-stream"
        await repo.store(content, media_type)
    bundle_hash = await repo.store(bundle)
    validated_at = await database_time(repo.session)
    if job.server_compile_expires_at is None or job.server_compile_expires_at <= validated_at:
        return False
    target = snapshot["validationTarget"]
    repo.session.add(
        ValidationReceipt(
            id=str(uuid4()),
            workspace_id=job.workspace_id,
            resource_id=target["resourceId"],
            job_id=job.id,
            revision=target["revision"],
            source_hash=snapshot["sourceHash"],
            engine_version=snapshot["engineVersion"],
            compiled_bundle_sha256=bundle_hash,
            server_compilation_id=job.server_compilation_id,
            compiler_trust="MANAGED",
            validated_at=validated_at,
        )
    )
    return True


async def _return_claim(db: Database, claim: _Claim) -> None:
    """本机发行或工具在领取后失效时归还自己的围栏，已由其它 Worker 接管或完成的任务保持原状。"""
    async with db.sessions.begin() as session:
        await lock_installation(session)
        await session.execute(
            update(Job)
            .where(
                Job.id == claim.job_id,
                Job.state == "RUNNING",
                Job.server_compilation_id == claim.compilation_id,
                Job.server_compile_expires_at > await database_time(session),
            )
            .values(state="QUEUED", server_compile_expires_at=None, server_compilation_id=None)
        )


async def compile_next(db: Database, settings: Settings) -> bool:
    """领取并编译一个待校验资源，失败写结构化作业终态，等待超时或产物核验失败从不生成可信回执。"""
    claim = await _claim(db, settings)
    if claim is None:
        return False
    output = None
    error = None
    # 耗时编译在数据库事务外执行，进程总超时短于数据库围栏期限，留出核验产物及提交最终回执的时间。
    try:
        async with asyncio.timeout(_BUILD_LIMIT):
            output = await compile_snapshot(
                settings, claim.engine, claim.snapshot, connected=claim.connected
            )
        verify_compiled_output(claim.snapshot, claim.engine, *output, connected=claim.connected)
    except ServerCompileError as problem:
        if not problem.diagnostics and problem.code in {
            "ENGINE_RELEASE_UNAVAILABLE",
            "ENGINE_RELEASE_HASH_MISMATCH",
            "SERVER_COMPILER_NOT_CONFIGURED",
            "SERVER_COMPILER_NODE_REQUIRED",
            "SERVER_COMPILER_TOOL_UNAVAILABLE",
        }:
            await _return_claim(db, claim)
            if problem.code.startswith("SERVER_COMPILER_"):
                raise Problem(503, problem.code, "Server compiler tools are unavailable") from None
            logger.warning("Server compiler release changed after claim")
            return False
        error = _error_result(problem.code, problem.diagnostics)
    except Problem as problem:
        error = _error_result(problem.code)
    except TimeoutError:
        error = _error_result("SERVER_COMPILATION_TIMEOUT")
    except (OSError, ValueError, KeyError, TypeError):
        logger.warning("VeriQ server compiler output could not be read")
        error = _error_result("INVALID_COMPILED_BUNDLE")
    await _finalize(db, settings, claim, output, error)
    return True


async def serve_compiler(
    db: Database, settings: Settings, stop: asyncio.Event, *, once: bool
) -> None:
    """按受管部署轮询待编译作业，停止信号到达后不领取下一项，已开始编译仍按有界围栏完成。"""
    tool_paths = (
        settings.server_compiler_node_path,
        settings.server_compiler_npm_cli_path,
        settings.server_compiler_tsx_path,
    )
    if not _local_engines(settings) or any(
        not path or not Path(path).is_absolute() or not Path(path).is_file() for path in tool_paths
    ):
        raise Problem(
            503, "SERVER_COMPILER_NOT_CONFIGURED", "Server compiler paths are unavailable"
        )
    retry_pause = _IDLE_POLL
    while not stop.is_set():
        try:
            processed = await compile_next(db, settings)
        except DBAPIError as error:
            args = error.orig.args if error.orig is not None else ()
            transient = error.connection_invalidated or (
                args and args[0] in _TRANSIENT_MYSQL_ERRORS
            )
            if once or not transient:
                raise
            # 未确认提交的领取会自然到期，已提交的回执则由终态拦住后续重试，重连不主动重放旧围栏。
            logger.warning("VeriQ server compiler database temporarily unavailable")
            delay = retry_pause
            retry_pause = min(retry_pause * 2, _MAX_DB_RETRY)
        else:
            if once:
                return
            retry_pause = _IDLE_POLL
            if processed:
                continue
            delay = _IDLE_POLL
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except TimeoutError:
            continue
