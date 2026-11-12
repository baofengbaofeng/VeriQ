"""RunService 在 Workspace 内创建幂等 Run、展开用例执行为 TEST Job，并处理取消；预算默认三十分钟。
create 绑定已发布或冻结草稿用例版本；idempotency_key 冲突复用既有 Run。
cancel 对未启动重试立即收尾并保留既有失败语义。
"""


import json
from hashlib import sha256
from typing import Any
from uuid import uuid4
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import Permission, WorkspaceScope
from ..contracts import canonical_bytes, validate_schema, asset_source_hash
from ..credentials.registry import IdentityRegistry
from ..db import Run, CaseExecution, Job, User, ResourceVersion, Attempt
from ..repositories.resource import ResourceRepository
from ..service import Problem, now, stamp
from .runtime import RuntimeService
from .workspace import WorkspaceRepository
from .snapshots import validate_initial_variables
from .results import aggregate


def run_dto(run: Run) -> dict[str, Any]:
    """导出 Run 对外字段含状态与时间戳，供列表与详情 API 使用，run_dto 遵守本文件边界，失败返回稳定 Problem。
    run_dto 实现于 apps/srv/src/veriq_server/services/runs.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return {
        "id": run.id,
        "workspaceId": run.workspace_id,
        "source": run.source,
        "triggerKind": run.trigger_kind,
        "state": run.state,
        "snapshotHash": run.snapshot_hash,
        "createdAt": stamp(run.created_at),
        **({"outcome": run.outcome} if run.outcome else {}),
        **({"reasonCode": run.reason_code} if run.reason_code else {}),
    }


class RunService:
    """编排 Run 创建、用例展开与取消，所有写入限定 actor 已授权 Workspace，RunService 遵守本文件边界。
    RunService 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """
    def __init__(self, session: AsyncSession, actor: User):
        """保存会话与发起用户，后续 authorize 使用其成员角色，RunService.__init__ 遵守本文件边界，失败返回稳定 Problem。
        __init__ 实现于 apps/srv/src/veriq_server/services/runs.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.session, self.actor = session, actor

    async def authorize(self, workspace_id: str) -> None:
        """校验 actor 对 Workspace 的执行权限，归档租户拒绝新 Run，RunService.authorize 遵守本文件边界。
        authorize 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(
            self.actor, Permission.EXECUTE, write=True
        )

    async def get(self, workspace_id: str, run_id: str) -> Run:
        """按 Workspace 与 run_id 加载 Run，缺失返回 Problem，RunService.get 遵守本文件边界。
        get 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        await WorkspaceRepository(self.session, WorkspaceScope(workspace_id)).authorize(self.actor)
        run = await self.session.get(Run, run_id)
        if not run or run.workspace_id != workspace_id:
            raise Problem(404, "RUN_NOT_FOUND", "Run not found")
        return run

    async def create(self, workspace_id: str, key: str, data: dict[str, Any]) -> dict[str, Any]:
        """幂等创建 Run 并展开 CaseExecution/Job；键冲突返回既有结果，RunService.create 遵守本文件边界。
        create 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        await self.authorize(workspace_id)
        if not key or len(key) > 160:
            raise Problem(400, "IDEMPOTENCY_KEY_REQUIRED", "Bounded idempotency key required")
        request_hash = sha256(
            canonical_bytes({"actorId": self.actor.id, "request": data})
        ).hexdigest()
        existing = (
            await self.session.execute(
                select(Run).where(Run.workspace_id == workspace_id, Run.idempotency_key == key)
            )
        ).scalar_one_or_none()
        if existing:
            if existing.request_hash != request_hash:
                raise Problem(409, "IDEMPOTENCY_CONFLICT", "Run request changed")
            return run_dto(existing)
        if (
            await self.session.execute(
                select(func.count()).select_from(Run).where(Run.state != "FINISHED")
            )
        ).scalar_one() >= 10:
            raise Problem(429, "RUN_LIMIT", "At most ten unfinished Runs are admitted")
        repo = ResourceRepository(self.session, WorkspaceScope(workspace_id))
        if (
            sum(k in data for k in ["caseVersionIds", "suiteVersionId", "draftValidationJobId"])
            != 1
        ):
            raise Problem(
                400,
                "INVALID_SELECTION",
                "Select CASE versions, one SUITE or one immutable draft validation job",
            )
        runtimes = [
            await RuntimeService(self.session).require_dispatch(self.actor, workspace_id, rid)
            for rid in data["runtimeIds"]
        ]
        if not runtimes:
            raise Problem(422, "RUNTIME_REQUIRED", "Explicit Runtime selection required")
        locations = {r.location for r in runtimes}
        location = data.get("executionLocation") or (
            next(iter(locations)) if len(locations) == 1 else None
        )
        if not location or any(r.location != location for r in runtimes):
            raise Problem(
                422,
                "RUNTIME_LOCATION_MISMATCH",
                "Selected Runtimes must match requested execution location",
            )
        environment_version = await repo.version(data["environmentVersionId"])
        if environment_version.kind != "ENVIRONMENT":
            raise Problem(422, "ENVIRONMENT_REQUIRED", "Selected published Environment is required")
        environment = environment_version.document_json["document"]
        selections: list[tuple[dict[str, Any], dict[str, Any], Job, str | None]] = []
        if "draftValidationJobId" in data:
            validation = await repo.job(data["draftValidationJobId"])
            if validation.kind != "VALIDATE":
                raise Problem(
                    422, "INVALID_DRAFT_CANDIDATE", "Immutable validation candidate required"
                )
            source = json.loads((await repo.artifact(validation.snapshot_hash)).content)
            target = source["validationTarget"]["versionId"]
            root = next(a for a in source["assets"] if a["versionId"] == target)
            if root["kind"] not in {"CASE", "SUITE"}:
                raise Problem(422, "INVALID_DRAFT_CANDIDATE", "Candidate must select CASE or SUITE")
            selections.append((root, source, validation, None))
        else:
            ids = [data["suiteVersionId"]] if "suiteVersionId" in data else data["caseVersionIds"]
            for version_id in ids:
                version = await repo.version(version_id)
                if version.kind != ("SUITE" if "suiteVersionId" in data else "CASE"):
                    raise Problem(422, "INVALID_SELECTION", "Resource kind differs from selection")
                receipt = await repo.receipt(version.receipt_id)
                if not receipt or receipt.compiler_trust != "MANAGED":
                    raise Problem(
                        409,
                        "COMPILED_PROVENANCE_REQUIRED",
                        "Published executable requires managed provenance",
                    )
                validation = await repo.job(receipt.job_id)
                if (
                    validation.state != "FINISHED"
                    or validation.active_attempt_id != receipt.attempt_id
                ):
                    raise Problem(
                        409,
                        "COMPILED_PROVENANCE_REQUIRED",
                        "Published receipt no longer matches validation Attempt",
                    )
                source = json.loads((await repo.artifact(validation.snapshot_hash)).content)
                if (
                    asset_source_hash(source) != source["sourceHash"]
                    or source["sourceHash"] != receipt.source_hash
                    or receipt.source_hash != version.source_hash
                ):
                    raise Problem(
                        409, "COMPILED_PROVENANCE_REQUIRED", "Published source identity differs"
                    )
                bundle = json.loads((await repo.artifact(receipt.compiled_bundle_sha256)).content)
                if (
                    validate_schema("CompiledAssetBundle", bundle)
                    or bundle["sourceHash"] != source["sourceHash"]
                ):
                    raise Problem(
                        409,
                        "COMPILED_PROVENANCE_REQUIRED",
                        "Compiled descriptor differs from source",
                    )
                for file in bundle["files"]:
                    if (await repo.artifact(file["sha256"])).size_bytes != file["sizeBytes"]:
                        raise Problem(409, "COMPILED_PROVENANCE_REQUIRED", "Compiled bytes differ")
                root = next(a for a in source["assets"] if a["versionId"] == version.id)
                selections.append((root, source, validation, receipt.compiled_bundle_sha256))
        run = Run(
            id=str(uuid4()),
            workspace_id=workspace_id,
            created_by=self.actor.id,
            idempotency_key=key,
            request_hash=request_hash,
            trigger_kind="DEBUG" if "draftValidationJobId" in data else "MANUAL",
            source=location,
            state="QUEUED",
            snapshot_hash=await repo.store(canonical_bytes({"request": data})),
            created_at=now(),
        )
        self.session.add(run)
        await self.session.flush()
        matrix: list[dict[str, Any]] = []
        for selection_index, (root, source, validation, bundle_hash) in enumerate(selections):
            assets = {a["versionId"]: a for a in source["assets"]}
            variants = (
                root["document"]["cases"]
                if root["kind"] == "SUITE"
                else [{"versionId": root["versionId"]}]
            )
            for ordinal, variant in enumerate(variants):
                case = assets[variant["versionId"]]
                document = case["document"]
                variables = data.get("variables", {})
                validate_initial_variables(document.get("initialVariables", {}), variables)
                dataset_id = variant.get("datasetVersionId", document.get("datasetVersionId"))
                rows = assets[dataset_id]["document"]["rows"] if dataset_id else [None]
                roles = variant.get("roleKeys", [document["roleKey"]])
                browsers = variant.get("browsers", data["browsers"])
                for role_key in [r for r in roles if r in data["roleKeys"]]:
                    selected_role = next(
                        (r for r in environment["roles"] if r["roleKey"] == role_key), None
                    )
                    if not selected_role:
                        raise Problem(
                            422, "ROLE_UNAVAILABLE", "Selected role is absent from Environment"
                        )
                    identities = [selected_role]
                    if document.get("fixtureVersionId"):
                        if not environment.get("fixtureIdentity"):
                            raise Problem(
                                422, "FIXTURE_IDENTITY_REQUIRED", "Fixture identity is required"
                            )
                        identities.append(environment["fixtureIdentity"])
                    adapters = await IdentityRegistry().freeze(
                        self.session, WorkspaceScope(workspace_id), identities
                    )
                    for browser in [b for b in browsers if b in data["browsers"]]:
                        for row in rows:
                            if len(matrix) >= 1000:
                                raise Problem(
                                    413, "MATRIX_LIMIT", "Run matrix exceeds 1000 variants"
                                )
                            provenance = {
                                "selectionIndex": selection_index,
                                "suiteEntryIndex": ordinal,
                                "caseVersionId": case["versionId"],
                                "datasetVersionId": dataset_id,
                                "rowKey": row["key"] if row else None,
                                "roleKey": role_key,
                                "browser": browser,
                                "validationJobId": validation.id,
                            }
                            execution = CaseExecution(
                                id=str(uuid4()),
                                workspace_id=workspace_id,
                                run_id=run.id,
                                case_version_id=case["versionId"],
                                published_case_version_id=case["versionId"]
                                if await self.session.get(ResourceVersion, case["versionId"])
                                else None,
                                candidate_version_id=None
                                if await self.session.get(ResourceVersion, case["versionId"])
                                else case["versionId"],
                                source_snapshot_hash=validation.snapshot_hash,
                                variant_key=sha256(canonical_bytes(provenance)).hexdigest(),
                                provenance=provenance,
                                state="QUEUED",
                            )
                            self.session.add(execution)
                            await self.session.flush()
                            frozen = {
                                "schemaVersion": "1.0",
                                "workspaceId": workspace_id,
                                "runId": run.id,
                                "caseExecutionId": execution.id,
                                "caseVersionId": case["versionId"],
                                "assetSourceHash": source["sourceHash"],
                                "environmentVersionId": environment_version.id,
                                "environment": environment,
                                "roleKey": role_key,
                                "browser": browser,
                                "variables": variables,
                                "secretVersions": [
                                    {"secretRef": r["secretRef"], "versionId": r["secretVersionId"]}
                                    for r in identities
                                ],
                                "authAdapters": adapters,
                                "namespace": "attempt_" + execution.id.replace("-", ""),
                                "attemptNo": 1,
                                "suiteEntryIndex": ordinal,
                                **({"dataRow": row, "datasetVersionId": dataset_id} if row else {}),
                            }
                            if validate_schema("ExecutionSnapshotV1", frozen):
                                raise Problem(
                                    422, "INVALID_SNAPSHOT", "Frozen execution context is invalid"
                                )
                            snapshot_hash = await repo.store(canonical_bytes(frozen))
                            jid = str(uuid4())
                            manifest = {
                                "schemaVersion": "1.0",
                                "workspaceId": workspace_id,
                                "jobId": jid,
                                "kind": "TEST",
                                "snapshotSha256": snapshot_hash,
                                "engineVersion": source["engineVersion"],
                                "caseExecutionId": execution.id,
                                "executionSnapshotSha256": snapshot_hash,
                                "caseVersionId": case["versionId"],
                            }
                            if bundle_hash:
                                manifest["compiledBundleSha256"] = bundle_hash
                            else:
                                manifest["pendingValidationJobId"] = validation.id
                            manifest_hash = await repo.store(canonical_bytes(manifest))
                            resource_keys = [
                                sha256(
                                    canonical_bytes(
                                        [
                                            "identity",
                                            environment_version.resource_id,
                                            identity["secretRef"],
                                            allowed,
                                        ]
                                    )
                                ).hexdigest()
                                for identity in identities
                                for allowed in identity["allowedIdentityIds"]
                            ]
                            if dataset_id and row:
                                resource_keys.append(
                                    sha256(
                                        canonical_bytes(
                                            ["data", assets[dataset_id]["resourceId"], row["key"]]
                                        )
                                    ).hexdigest()
                                )
                            cleanup_hash = None
                            if document.get("fixtureVersionId"):
                                cleanup_snapshot = {
                                    "schemaVersion": "1.0",
                                    "workspaceId": workspace_id,
                                    "namespace": frozen["namespace"],
                                    "fixtureVersionId": document["fixtureVersionId"],
                                    "fixture": assets[document["fixtureVersionId"]]["document"],
                                    "environment": environment,
                                    "authAdapters": adapters,
                                    "engineVersion": source["engineVersion"],
                                }
                                cleanup_hash = await repo.store(canonical_bytes(cleanup_snapshot))
                            self.session.add(
                                Job(
                                    id=jid,
                                    workspace_id=workspace_id,
                                    kind="TEST",
                                    subject_id=execution.id,
                                    run_id=run.id,
                                    case_execution_id=execution.id,
                                    state="QUEUED",
                                    snapshot_hash=snapshot_hash,
                                    manifest_hash=manifest_hash,
                                    requested_runtime_id=runtimes[0].id
                                    if len(runtimes) == 1
                                    else None,
                                    requested_location=location,
                                    max_retries=data.get("maxRetries", 0),
                                    required_capabilities={
                                        "engineVersion": source["engineVersion"],
                                        "browser": browser,
                                        "environmentVersionId": environment_version.id,
                                        "resourceKeys": resource_keys,
                                        "runtimeIds": [r.id for r in runtimes],
                                        **(
                                            {"cleanupSnapshotSha256": cleanup_hash}
                                            if cleanup_hash
                                            else {}
                                        ),
                                        **(
                                            {"validationJobId": validation.id}
                                            if not bundle_hash
                                            else {}
                                        ),
                                    },
                                    created_by=self.actor.id,
                                    created_at=now(),
                                )
                            )
                            matrix.append(
                                {
                                    "caseExecutionId": execution.id,
                                    "snapshotSha256": snapshot_hash,
                                    "provenance": provenance,
                                }
                            )
        run.snapshot_hash = await repo.store(
            canonical_bytes({"runId": run.id, "request": data, "matrix": matrix})
        )
        if not matrix:
            run.state, run.outcome, run.reason_code = "FINISHED", "INCOMPLETE", "NO_CASES_SELECTED"
        return run_dto(run)

    async def cancel(self, workspace_id: str, run_id: str) -> dict[str, Any]:
        """请求取消 Run 及其未完成 Job；未启动重试直接收尾，RunService.cancel 遵守本文件边界，失败返回稳定 Problem。
        cancel 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
        """
        await self.authorize(workspace_id)
        run = await self.get(workspace_id, run_id)
        if run.state == "FINISHED":
            return run_dto(run)
        run.state, run.reason_code = "CANCEL_REQUESTED", "USER_CANCELLED"
        jobs = (
            (
                await self.session.execute(
                    select(Job).where(Job.run_id == run.id, Job.state != "FINISHED")
                )
            )
            .scalars()
            .all()
        )
        active = False
        for job in jobs:
            assigned = (
                await self.session.get(Attempt, job.active_attempt_id)
                if job.active_attempt_id
                else None
            )
            if assigned and assigned.phase != "FINISHED":
                job.state = "CANCEL_REQUESTED"
                active = True
            else:
                history = (
                    (
                        await self.session.execute(
                            select(Attempt.outcome).where(
                                Attempt.job_id == job.id, Attempt.phase == "FINISHED"
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                outcome = aggregate([*(result or "INCOMPLETE" for result in history), "CANCELLED"])
                job.state, job.outcome = "FINISHED", outcome
                execution = await self.session.get(CaseExecution, job.case_execution_id)
                if execution:
                    execution.state, execution.outcome = "FINISHED", outcome
        if not active:
            cases = (
                (
                    await self.session.execute(
                        select(CaseExecution).where(CaseExecution.run_id == run.id)
                    )
                )
                .scalars()
                .all()
            )
            run.state, run.outcome = (
                "FINISHED",
                aggregate([c.outcome or "INCOMPLETE" for c in cases]),
            )
        return run_dto(run)
