"""工作区内完整冻结源仅供服务端保存，联网任务采用剔除静态行的独立投影，编译回执仍以原始版本摘要为准。"""

import json
import re
from collections.abc import Iterable
from hashlib import sha256
from typing import Any
from uuid import uuid4

from sqlalchemy import or_, select

from ..contracts import asset_source_hash, canonical_bytes, validate_schema
from ..db import Attempt, CaseExecution, Job, Run, ValidationReceipt
from ..repositories.resource import ResourceRepository
from ..service import Problem, now
from .snapshots import execution_data_row


async def frozen_object(repo: ResourceRepository, digest: str, schema: str | None = None) -> dict:
    """仅将已读取静态字节的解码或结构失败归为永久溯源错误，数据库连接与事务错误继续沿原始重试路径上报。"""
    artifact = await repo.artifact(digest)
    try:
        value = json.loads(artifact.content)
        canonical_bytes(value)
        if not isinstance(value, dict) or (schema and validate_schema(schema, value)):
            raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid frozen document")
    except (ValueError, RecursionError):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid frozen document") from None
    return value


async def protected_test(repo: ResourceRepository, job: Job, snapshot_hash: str) -> bool:
    """只使用当前 Attempt 已冻结的矩阵或命名依赖确定证据策略，套件中其它变体和客户端参数都不改变本次义务。"""
    if job.kind != "TEST":
        return False
    subject = await frozen_object(repo, snapshot_hash)
    return bool(subject.get("datasetVersionId") or subject.get("datasetBindings"))


async def protected_event_context(
    repo: ResourceRepository, attempt: Attempt, job: Job
) -> dict | None:
    """只从已分配的冻结对象加载事件来源，同一批事件共享元数据。所需成员缺失时关闭对应的步骤事实。"""
    if job.kind != "TEST":
        return None
    subject = await frozen_object(repo, attempt.snapshot_hash)
    if not (subject.get("datasetVersionId") or subject.get("datasetBindings")):
        return None
    manifest = await frozen_object(repo, attempt.manifest_hash)
    ctx = {
        "subject": subject,
        "manifest": manifest,
        "steps": {},
        "sources": {},
        "httpAssertions": {},
    }
    case = await repo.session.get(CaseExecution, job.case_execution_id)
    if (
        not case
        or case.workspace_id != repo.scope.workspace_id
        or case.id != subject.get("caseExecutionId")
    ):
        return ctx
    source = await frozen_object(repo, case.source_snapshot_hash)
    # 只从服务器保留的 CASE 及其明确引用的资产生成出现位置；上传的展示元数据不能提供任何可写标识。
    try:
        if (
            source["workspaceId"] == case.workspace_id
            and asset_source_hash(source) == subject["assetSourceHash"]
            and case.case_version_id == manifest.get("caseVersionId")
            and case.case_version_id in source["entryCaseVersionIds"]
        ):
            owners = [
                a
                for a in source["assets"]
                if a["versionId"] == case.case_version_id and a["kind"] == "CASE"
            ]
            if len(owners) != 1 or owners[0]["document"].get("datasetBindings", {}) != subject.get(
                "datasetBindings", {}
            ):
                return ctx
            ctx["steps"], ctx["sources"] = protected_occurrences(
                source, case.case_version_id, subject, http_assertions=ctx["httpAssertions"]
            )
    except (TypeError, KeyError, ValueError, IndexError, AttributeError, RecursionError):
        # 无效或不完整的冻结关联只留下封闭的协议状态，任何步骤、断言或观察器事实均会在落库前被拒绝。
        pass
    return ctx


def protected_occurrences(
    source: dict, case_id: str, subject: dict, *, http_assertions: dict | None = None
) -> tuple[dict, dict]:
    """以编译器相同的展开路径和预算遍历单个真实 CASE；逐层校验引用种类并继承模板的 WARN。"""
    versions = {asset["versionId"]: (index, asset) for index, asset in enumerate(source["assets"])}
    if len(versions) != len(source["assets"]):
        raise ValueError("DUPLICATE_VERSION")
    steps, assertions = {}, {}
    count = 0

    def document(vid: str, kind: str) -> dict:
        asset = versions[vid][1]
        if asset["kind"] != kind:
            raise ValueError("REFERENCE_KIND_MISMATCH")
        return asset["document"]

    def wire(path: str) -> str:
        return "v_" + sha256(path.encode("utf-8")).hexdigest()

    def uses_matrix(value, fields) -> bool:
        if isinstance(value, dict):
            return any(uses_matrix(v, fields) for v in value.values())
        if isinstance(value, list):
            return any(uses_matrix(v, fields) for v in value)
        pattern = r"\{\{data\.([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}\}"
        return isinstance(value, str) and any(key in fields for key in re.findall(pattern, value))

    def scoped(fields, parameters):
        return (fields - parameters.keys()) | {
            key for key, value in parameters.items() if uses_matrix(value, fields)
        }

    def collect_assertions(items, parent, step_id, fields, depth=0, warn=False):
        nonlocal count
        for index, item in enumerate(items):
            count += 1
            if depth > 5 or count > 5000:
                raise ValueError("EXPANDED_ASSERTION_LIMIT")
            path = f"{parent}/{index}"
            severity = "WARN" if warn else item["severity"]
            if item["type"] == "template":
                child = document(item["versionId"], "ASSERTION_TEMPLATE")
                collect_assertions(
                    child["assertions"],
                    path + "/template",
                    step_id,
                    scoped(fields, item.get("parameters", {})),
                    depth + 1,
                    severity == "WARN",
                )
                continue
            label = "CASE"
            if "datasetExpected" in item:
                vid = subject["datasetBindings"][item["datasetExpected"]["alias"]]
                label = "DATASET:" + vid
                if (
                    http_assertions is not None
                    and document(vid, "DATASET").get("source", {}).get("kind") == "HTTP"
                ):
                    http_assertions[step_id, wire(path)] = vid
            elif item["type"] != "responseSchema" and uses_matrix(item.get("expected"), fields):
                label = "DATASET:" + subject["datasetVersionId"]
            assertions[step_id, wire(path)] = (label, severity)

    def collect_steps(items, parent, fields, depth=0):
        for index, step in enumerate(items):
            if depth > 5 or len(steps) >= 500:
                raise ValueError("EXPANDED_STEP_LIMIT")
            path = f"{parent}/{index}"
            step_id = wire(path)
            steps[step_id] = {o["id"] for o in step.get("observers", [])}
            for stage in ["beforeAssertions", "afterAssertions"]:
                collect_assertions(step.get(stage, []), path + "/" + stage, step_id, fields)
            if step["action"] == "callFlow":
                collect_steps(
                    document(step["versionId"], "FLOW")["steps"],
                    path + "/flow",
                    scoped(fields, step.get("parameters", {})),
                    depth + 1,
                )

    matrix = (
        document(subject["datasetVersionId"], "DATASET") if subject.get("datasetVersionId") else {}
    )
    fields = set(matrix.get("fields", matrix.get("columns", {})))
    collect_steps(
        document(case_id, "CASE")["steps"], f"/assets/{versions[case_id][0]}/document/steps", fields
    )
    return steps, assertions


def protected_event(ctx: dict, event: dict) -> bool:
    """受保护事件只接收固定字段和已编译的出现位置，错误码同 SDK 写前归约保持封闭。"""
    payload, kind = event["payload"], event["type"]
    step_id, assertion_id = event.get("stepId"), event.get("assertionId")
    if (
        ("stepId" in event)
        != (kind in {"STEP_STARTED", "STEP_FINISHED", "ASSERTION_RESULT", "OBSERVER_RESULT"})
        or ("assertionId" in event) != (kind == "ASSERTION_RESULT")
        or ("stepId" in event and step_id not in ctx["steps"])
        or "message" in payload
        or (
            "errorCode" in payload
            and validate_schema("ProtectedExecutionErrorCode", payload["errorCode"])
        )
    ):
        return False
    blocked_step = payload.get("blockedByStepId", step_id)
    if ("blockedByStepId" in payload and blocked_step not in ctx["steps"]) or (
        "blockedByAssertionId" in payload
        and (blocked_step, payload["blockedByAssertionId"]) not in ctx["sources"]
    ):
        return False
    if kind == "ASSERTION_RESULT":
        remote = ctx["httpAssertions"].get((step_id, assertion_id))
        sample = payload.get("sample")
        if sample is not None and (
            not remote or sample["sourceVersionId"] != remote or payload["status"] == "SKIPPED"
        ):
            return False
        if remote and sample is None and payload["status"] not in {"ERROR", "SKIPPED"}:
            return False
        return (
            (step_id, assertion_id) in ctx["sources"]
            and payload["expectedSource"] == "PROTECTED_CASE"
            and ctx["sources"][step_id, assertion_id][1] == payload["severity"]
            and payload["actual"] == {"present": False}
            and payload["expected"] is None
        )
    if kind == "OBSERVER_RESULT":
        return not payload["requests"] and payload["observerId"] in ctx["steps"][step_id]
    if kind == "ATTEMPT_STARTED":
        return payload == {
            "engineVersion": ctx["manifest"].get("engineVersion"),
            "sourceHash": ctx["subject"].get("assetSourceHash"),
        }
    return kind in {
        "STEP_STARTED",
        "STEP_FINISHED",
        "PHASE_CHANGED",
        "CLEANUP_RESULT",
        "ATTEMPT_FINISHED",
    }


def checksum(value: Any) -> str:
    """对约定传递的对象使用跨语言规范编码计算摘要，树行在此之前已按矩阵语义去掉与执行无关的排序字段。"""
    return sha256(canonical_bytes(value)).hexdigest()


def http_capabilities(source: dict) -> dict:
    """编译必须重建整个不可变闭包，因而包含 HTTP 定义的套件在验证及各执行变体均要求新版引擎的双组件能力。"""
    if not isinstance(source.get("assets"), list) or not all(
        isinstance(a, dict) and (a.get("kind") != "DATASET" or isinstance(a.get("document"), dict))
        for a in source["assets"]
    ):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid frozen dataset assets")
    return (
        {"httpDatasets": "1.0"}
        if any(
            asset.get("kind") == "DATASET"
            and isinstance(asset["document"].get("source"), dict)
            and asset["document"]["source"].get("kind") == "HTTP"
            for asset in source["assets"]
        )
        else {}
    )


def project_source(source: dict) -> dict:
    """数据资产保留版本、声明与双重摘要，顺序沿用冻结快照以便还原；没有数据集的旧任务可以继续按原契约读取。"""
    if not any(a["kind"] == "DATASET" for a in source["assets"]):
        return source
    assets = []
    for a in source["assets"]:
        if a["kind"] != "DATASET":
            assets.append(a)
            continue
        doc = a["document"]
        schema = {k: doc[k] for k in ("schemaVersion", "columns", "shape", "fields") if k in doc}
        assets.append(
            {
                **{k: a[k] for k in ("kind", "resourceId", "versionId", "sha256")},
                "schema": schema,
                "contentSha256": checksum(doc),
            }
        )
    return {**source, "assets": assets, "schemaVersion": "2.0", "originalSha256": checksum(source)}


def project_execution(execution: dict, source: dict) -> dict:
    """矩阵只给执行目录保留行键与行摘要，别名独立锁定版本；源中包含其它套件变体的数据时也启用联网格式。"""
    if not any(a["kind"] == "DATASET" for a in source["assets"]):
        return execution
    projected = {**execution, "schemaVersion": "2.0"}
    if row := projected.pop("dataRow", None):
        if not projected.get("datasetVersionId"):
            raise Problem(
                409, "COMPILED_PROVENANCE_REQUIRED", "Original row has no assigned version"
            )
        projected["selectedRow"] = {
            "versionId": execution["datasetVersionId"],
            "rowKey": row["key"],
            "rowSha256": checksum(row),
        }
    return projected


def revalidation_group(
    original_id: str, requester: str, token: str | None, plan: str | None, features: dict
) -> str:
    """验证任务的同组键同时绑定原发布验证、实际触发者和计划；功能升级会生成独立键，重试代次则属于原组。"""
    return checksum(
        {
            "connectedDatasets": "2.0",
            **features,
            "validationJobId": original_id,
            "requester": requester,
            "serviceToken": token,
            "planId": plan,
        }
    )


def revalidation_key(group: str, generation: int) -> str:
    """首代直接使用组键，之后每次失败重试都有自己的持久键，创建与历史溯源核查必须采用相同规则。"""
    return checksum({"group": group, "generation": generation}) if generation else group


async def revalidate_bundle(
    repo: ResourceRepository,
    validation: Job,
    source: dict,
    bundle: dict,
    receipt: ValidationReceipt,
    *,
    requester: str,
    service_token: str | None = None,
    plan_id: str | None = None,
) -> tuple[Job, str | None]:
    """旧发布回执不可变，以独立幂等验证任务重新编译原始冻结快照，使用同一个版本和引擎，绝不读取当前草稿。"""
    retained = {k: v for k, v in source.items() if k != "validationTarget"}
    expected = project_source(retained)
    if expected is retained:
        return validation, receipt.compiled_bundle_sha256
    member = next((f for f in bundle["files"] if f["path"] == "source/asset-snapshot.json"), None)
    if not member:
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Compiled source missing")
    needed = http_capabilities(source)
    projected = member["sha256"] == checksum(expected) and validation.required_capabilities.get(
        "connectedDatasets"
    )
    if projected and all(validation.required_capabilities.get(k) == v for k, v in needed.items()):
        return validation, receipt.compiled_bundle_sha256
    if not projected and member["sha256"] != checksum(retained):
        raise Problem(
            409, "COMPILED_PROVENANCE_REQUIRED", "Retained source differs from frozen version"
        )
    group = revalidation_group(validation.id, requester, service_token, plan_id, needed)
    # 已有版本使用单一幂等键；同一组后续重验证另取代次键。保留失败任务和旧依赖的关联，使既有运行终态可追查。
    existing = (
        await repo.session.execute(
            select(Job)
            .where(
                Job.workspace_id == repo.scope.workspace_id,
                Job.subject_id == validation.subject_id,
                or_(
                    Job.validation_key == group,
                    Job.required_capabilities["revalidationGroup"].as_string() == group,
                ),
            )
            .order_by(
                Job.required_capabilities["revalidationGeneration"].as_integer().desc(),
                Job.id.desc(),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    generation = 0
    if existing:
        if existing.state != "CANCEL_REQUESTED" and (
            existing.state != "FINISHED" or existing.outcome == "PASSED"
        ):
            return existing, None
        generation = existing.required_capabilities.get("revalidationGeneration", 0) + 1

    jid = str(uuid4())
    manifest = await frozen_object(repo, validation.manifest_hash, "JobManifestV1")
    manifest.update(
        jobId=jid, snapshotSha256=await repo.store(canonical_bytes(project_source(source)))
    )
    job = Job(
        id=jid,
        workspace_id=validation.workspace_id,
        kind="VALIDATE",
        subject_id=validation.subject_id,
        state="QUEUED",
        snapshot_hash=validation.snapshot_hash,
        manifest_hash=await repo.store(canonical_bytes(manifest)),
        validation_key=revalidation_key(group, generation),
        required_capabilities={
            "engineVersion": source["engineVersion"],
            "compileAssets": True,
            "connectedDatasets": "2.0",
            **needed,
            "publishedValidationJobId": validation.id,
            "revalidationGroup": group,
            "revalidationGeneration": generation,
            **({"revalidationPlanId": plan_id} if service_token else {}),
        },
        requester_service_token_id=service_token,
        created_by=requester,
        created_at=now(),
    )
    repo.session.add(job)
    await repo.session.flush()
    return job, None


async def static_bytes(
    repo: ResourceRepository, job: Job, snapshot_hash: str, selection: dict
) -> bytes:
    """验证候选源只在验证任务内可读，执行任务从其用例冻结的完整闭包重建编译输入，行选择还必须匹配该次矩阵。"""
    denied = Problem(403, "DATASET_NOT_ASSIGNED", "Dataset selection is not assigned to Attempt")
    subject = json.loads((await repo.artifact(snapshot_hash)).content)
    if subject.get("workspaceId") != repo.scope.workspace_id:
        raise denied
    mode = selection["selection"]
    if (
        job.kind == "VALIDATE"
        and mode == "VALIDATION_SOURCE"
        and job.required_capabilities.get("connectedDatasets")
    ):
        if asset_source_hash(subject) != subject["sourceHash"]:
            raise Problem(409, "SOURCE_HASH_MISMATCH", "Frozen validation source differs")
        return canonical_bytes(subject)
    if job.kind != "TEST" or mode == "VALIDATION_SOURCE" or subject.get("schemaVersion") != "2.0":
        raise denied
    case = await repo.session.get(CaseExecution, job.case_execution_id)
    if (
        not case
        or case.workspace_id != repo.scope.workspace_id
        or case.id != subject["caseExecutionId"]
    ):
        raise denied
    source = json.loads((await repo.artifact(case.source_snapshot_hash)).content)
    if (
        source["workspaceId"] != case.workspace_id
        or asset_source_hash(source) != subject["assetSourceHash"]
    ):
        raise denied
    asset = next(
        (
            a
            for a in source["assets"]
            if a["kind"] == "DATASET" and a["versionId"] == selection["versionId"]
        ),
        None,
    )
    if not asset:
        raise denied
    doc = asset["document"]
    if asset["sha256"] != checksum({"kind": "DATASET", "document": doc}):
        raise Problem(409, "DATASET_HASH_MISMATCH", "Frozen dataset differs")
    if doc.get("source", {}).get("kind") == "HTTP" and (
        mode != "DATASET" or job.required_capabilities.get("httpDatasets") != "1.0"
    ):
        raise denied
    if mode == "DATASET":
        return canonical_bytes(doc)
    row = subject.get("selectedRow", {})
    if (
        row.get("versionId") != asset["versionId"]
        or row.get("versionId") != subject.get("datasetVersionId")
        or row.get("rowKey") != selection["rowKey"]
    ):
        raise denied
    rows = doc["rows"] if doc["schemaVersion"] == "1.0" else doc["source"]["rows"]
    selected = next((execution_data_row(r) for r in rows if r["key"] == row["rowKey"]), None)
    if not selected or checksum(selected) != row["rowSha256"]:
        raise Problem(409, "ROW_HASH_MISMATCH", "Frozen row differs")
    return canonical_bytes(selected)


async def legacy_source(repo: ResourceRepository, job: Job) -> dict | None:
    """旧任务未携带能力标记时检查服务器保留的原始源，避免升级前派发的租约继续从普通附件入口下载完整数据正文。"""
    if job.kind not in {"TEST", "VALIDATE"} or job.required_capabilities.get("connectedDatasets"):
        return None
    digest = job.snapshot_hash
    if job.kind == "TEST":
        case = await repo.session.get(CaseExecution, job.case_execution_id)
        if not case or case.workspace_id != repo.scope.workspace_id:
            raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Missing original case")
        digest = case.source_snapshot_hash
    source = await frozen_object(repo, digest)
    assets = source.get("assets", [])
    if not isinstance(assets, list) or any(
        not isinstance(asset, dict) or not asset.get("kind") for asset in assets
    ):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical assets")
    if not any(asset["kind"] == "DATASET" for asset in assets):
        return None
    if (
        validate_schema("AssetSnapshotV1", source)
        or asset_source_hash(source) != source["sourceHash"]
    ):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical source")
    return source


def pending_validation(job: Job) -> str | None:
    """只有未携带属性才表示没有依赖；显式空值或不合法标识说明分配记录损坏，不能据此直接领取测试任务。"""
    if "validationJobId" not in job.required_capabilities:
        return None
    pending = job.required_capabilities["validationJobId"]
    if validate_schema("Id", pending):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid validation dependency")
    return pending


async def verify_redirect(
    repo: ResourceRepository,
    job: Job,
    original: Job,
    source: dict,
    *,
    pending: str | None = None,
    compiled: str | None = None,
) -> None:
    """旧调度器在有容量前可能已经写入最终包；用原验证、组键和投影清单查证替代关系，包摘要只用于选择候选。"""
    invalid = Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical validation redirect")
    run = await repo.session.get(Run, job.run_id)
    if not run or run.workspace_id != job.workspace_id:
        raise invalid
    # 同一旧验证以后可被新设备接手，领用时追加的 HTTP 能力不会改变静态代次写入的键或验证来源。
    group = revalidation_group(
        original.id, job.created_by, job.requester_service_token_id, run.plan_id, {}
    )
    manifest = await frozen_object(repo, original.manifest_hash, "ValidateJobManifestV1")
    projected = checksum(project_source(source))
    if (
        manifest["jobId"] != original.id
        or manifest["workspaceId"] != job.workspace_id
        or manifest["resourceId"] != original.subject_id
        or manifest["sourceHash"] != source["sourceHash"]
        or manifest["engineVersion"] != source["engineVersion"]
        or manifest["snapshotSha256"] not in (original.snapshot_hash, projected)
    ):
        raise invalid
    candidates: Iterable[Job]
    if pending is not None:
        candidates = [await repo.job(pending)]
    else:
        # 可执行回执须由该空间内替代验证的活动尝试成功签发；即使别的作业生成相同包字节，其回执也不能作证。
        candidates = await repo.session.scalars(
            select(Job)
            .join(ValidationReceipt, ValidationReceipt.job_id == Job.id)
            .where(
                Job.workspace_id == job.workspace_id,
                Job.subject_id == original.subject_id,
                Job.snapshot_hash == original.snapshot_hash,
                Job.state == "FINISHED",
                Job.outcome == "PASSED",
                Job.required_capabilities["revalidationGroup"].as_string() == group,
                ValidationReceipt.workspace_id == job.workspace_id,
                ValidationReceipt.resource_id == original.subject_id,
                ValidationReceipt.revision == manifest["revision"],
                ValidationReceipt.attempt_id == Job.active_attempt_id,
                ValidationReceipt.compiler_trust == "MANAGED",
                ValidationReceipt.source_hash == source["sourceHash"],
                ValidationReceipt.engine_version == source["engineVersion"],
                ValidationReceipt.compiled_bundle_sha256 == compiled,
            )
        )
    for linked in candidates:
        caps = linked.required_capabilities
        if not isinstance(caps, dict):
            continue
        generation = caps.get("revalidationGeneration")
        if (
            linked.kind != "VALIDATE"
            or linked.subject_id != original.subject_id
            or linked.snapshot_hash != original.snapshot_hash
            or linked.created_by != job.created_by
            or linked.requester_service_token_id != job.requester_service_token_id
            or caps.get("publishedValidationJobId") != original.id
            or caps.get("engineVersion") != source["engineVersion"]
            or caps.get("connectedDatasets") != "2.0"
            or caps.get("compileAssets") is not True
            or caps.get("revalidationPlanId")
            != (run.plan_id if job.requester_service_token_id else None)
            or caps.get("revalidationGroup") != group
            or type(generation) is not int
            or generation < 0
            or linked.validation_key != revalidation_key(group, generation)
        ):
            continue
        expected = {**manifest, "jobId": linked.id, "snapshotSha256": projected}
        if linked.manifest_hash == checksum(expected):
            await frozen_object(repo, linked.manifest_hash, "ValidateJobManifestV1")
            if compiled is not None:
                bundle = await frozen_object(repo, compiled, "CompiledAssetBundle")
                retained = {k: v for k, v in source.items() if k != "validationTarget"}
                members = [
                    f["sha256"]
                    for f in bundle["files"]
                    if f["path"] == "source/asset-snapshot.json"
                ]
                if (
                    bundle["sourceHash"] != source["sourceHash"]
                    or bundle["engineVersion"] != source["engineVersion"]
                    or members != [checksum(project_source(retained))]
                ):
                    raise invalid
            return
    raise invalid


async def historical_test_validation(
    repo: ResourceRepository, job: Job, source: dict, subject: dict, manifest: dict, expected: dict
) -> str:
    """历史测试清单只能是已编译或等待原验证的两种形状；逐项绑定用例、运行、原快照与回执，再允许写入新投影。"""
    invalid = Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical test assignment")
    case = await repo.session.get(CaseExecution, job.case_execution_id)
    if (
        not case
        or case.workspace_id != job.workspace_id
        or case.run_id != job.run_id
        or case.id != job.subject_id
        or subject["workspaceId"] != job.workspace_id
        or subject["runId"] != case.run_id
        or subject["caseExecutionId"] != case.id
        or subject["caseVersionId"] != case.case_version_id
        or case.case_version_id not in source["entryCaseVersionIds"]
        or subject["assetSourceHash"] != source["sourceHash"]
        or not isinstance(case.provenance, dict)
    ):
        raise invalid
    validation_id = case.provenance.get("validationJobId")
    if validate_schema("Id", validation_id):
        raise invalid
    expected = {
        **expected,
        "caseExecutionId": case.id,
        "caseVersionId": case.case_version_id,
        "executionSnapshotSha256": job.snapshot_hash,
    }
    pending = pending_validation(job)
    redirected = pending is not None and pending != validation_id
    if pending is not None:
        if manifest != {**expected, "pendingValidationJobId": validation_id} or (
            redirected and subject["schemaVersion"] != "2.0"
        ):
            raise invalid
    elif validate_schema("TestJobManifestV1", manifest) or any(
        manifest.get(k) != v for k, v in expected.items()
    ):
        raise invalid
    validation = await repo.job(validation_id)
    if validation.kind != "VALIDATE" or validation.snapshot_hash != case.source_snapshot_hash:
        raise invalid
    if pending is None or redirected:
        receipt = (
            await repo.session.execute(
                select(ValidationReceipt).where(
                    ValidationReceipt.workspace_id == job.workspace_id,
                    ValidationReceipt.job_id == validation_id,
                )
            )
        ).scalar_one_or_none()
        if (
            not receipt
            or validation.state != "FINISHED"
            or receipt.compiler_trust != "MANAGED"
            or receipt.source_hash != source["sourceHash"]
            or receipt.attempt_id != validation.active_attempt_id
            or receipt.engine_version != source["engineVersion"]
        ):
            raise invalid
        if redirected:
            await verify_redirect(repo, job, validation, source, pending=pending)
        elif receipt.compiled_bundle_sha256 != manifest["compiledBundleSha256"]:
            if subject["schemaVersion"] != "2.0":
                raise invalid
            await verify_redirect(
                repo, job, validation, source, compiled=manifest["compiledBundleSha256"]
            )
    return validation_id


async def upgrade_queued(repo: ResourceRepository, job: Job) -> bool:
    """已排队的历史任务只在任何新租约产生之前更换传输投影；原始验证源和既有尝试的不可变清单始终保留。"""
    if job.required_capabilities.get("connectedDatasets") and not job.required_capabilities.get(
        "httpDatasets"
    ):
        # 早期 V2 任务只记录静态通道能力。原始闭包可辨认当时尚未投入执行的 HTTP 定义，避免旧设备抢先取得租约。
        digest = job.snapshot_hash
        if job.kind == "TEST":
            case = await repo.session.get(CaseExecution, job.case_execution_id)
            if not case or case.workspace_id != repo.scope.workspace_id:
                raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Missing frozen case")
            digest = case.source_snapshot_hash
        if job.kind in {"VALIDATE", "TEST"}:
            retained = await frozen_object(repo, digest)
            if needed := http_capabilities(retained):
                caps = {**job.required_capabilities, **needed}
                if job.kind == "TEST":
                    if (
                        validate_schema("AssetSnapshotV1", retained)
                        or retained["workspaceId"] != job.workspace_id
                        or retained["engineVersion"] != caps.get("engineVersion")
                        or asset_source_hash(retained) != retained["sourceHash"]
                    ):
                        raise Problem(
                            409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical source"
                        )
                    manifest = await frozen_object(repo, job.manifest_hash)
                    subject = await frozen_object(
                        repo, job.snapshot_hash, "ConnectedExecutionSnapshotV2"
                    )
                    expected = {
                        "schemaVersion": "1.0",
                        "kind": job.kind,
                        "workspaceId": job.workspace_id,
                        "jobId": job.id,
                        "engineVersion": caps.get("engineVersion"),
                        "snapshotSha256": job.snapshot_hash,
                    }
                    dependency = await historical_test_validation(
                        repo, job, retained, subject, manifest, expected
                    )
                    if "validationJobId" not in caps:
                        caps["validationJobId"] = manifest["pendingValidationJobId"] = dependency
                        del manifest["compiledBundleSha256"]
                        job.manifest_hash = await repo.store(canonical_bytes(manifest))
                job.required_capabilities = caps
        return False
    source = await legacy_source(repo, job)
    if not source:
        return False
    manifest = await frozen_object(repo, job.manifest_hash)
    expected = {
        "schemaVersion": "1.0",
        "kind": job.kind,
        "workspaceId": job.workspace_id,
        "jobId": job.id,
        "engineVersion": job.required_capabilities.get("engineVersion"),
        "snapshotSha256": job.snapshot_hash,
    }
    if (
        source["workspaceId"] != expected["workspaceId"]
        or source["engineVersion"] != expected["engineVersion"]
    ):
        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Historical source identity differs")
    caps = {**job.required_capabilities, "connectedDatasets": "2.0", **http_capabilities(source)}
    if job.kind == "VALIDATE":
        target = source.get("validationTarget", {})
        expected.update(
            resourceId=job.subject_id,
            revision=target.get("revision"),
            sourceHash=source["sourceHash"],
        )
        if (
            validate_schema("ValidateJobManifestV1", manifest)
            or manifest != expected
            or target.get("resourceId") != job.subject_id
        ):
            raise Problem(
                409, "COMPILED_PROVENANCE_REQUIRED", "Invalid historical validation assignment"
            )
        manifest["snapshotSha256"] = await repo.store(canonical_bytes(project_source(source)))
    else:
        subject = await frozen_object(repo, job.snapshot_hash, "ExecutionSnapshotV1")
        validation_id = await historical_test_validation(
            repo, job, source, subject, manifest, expected
        )
        projected = project_execution(subject, source)
        job.snapshot_hash = await repo.store(canonical_bytes(projected))
        manifest["executionSnapshotSha256"] = manifest["snapshotSha256"] = job.snapshot_hash
        manifest.pop("compiledBundleSha256", None)
        manifest["pendingValidationJobId"] = caps["validationJobId"] = validation_id
    job.manifest_hash = await repo.store(canonical_bytes(manifest))
    job.required_capabilities = caps
    return True
