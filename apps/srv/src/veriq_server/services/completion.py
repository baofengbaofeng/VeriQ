"""
CompletionService 追加执行事件，完成后写入回执并归约 Run 与 Job 的结果。

finish 核对设备和发起者，仅以同一清单重放既有回执，新完成还须通过围栏和租约检查。
validation 生成 ValidationReceipt。retry_is_safe 要求声明夹具且清理成功，或无潜在写入且已观察为只读。
整案重试最多一次，重试通过记为 UNSTABLE。
"""

import json
from hashlib import sha256
from typing import Any
from uuid import uuid4
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..contracts import canonical_bytes, validate_schema
from ..credentials.resolve import CredentialProofTransport
from ..db import Attempt, AttemptEvent, AttemptUpload, Job, ValidationReceipt, CaseExecution, Run
from ..repositories.resource import ResourceRepository
from ..service import Problem
from ..settings import Settings
from .connected_datasets import protected_test, protected_event_context, protected_event
from .capacity import CapacityService
from .engines import ApprovedEngines
from .jobs import require_requester, database_time
from .lease import LeaseService
from .results import reduce_test, aggregate
from .runtime import RuntimeService
from .process_stop import validate_process_stop_claim
from .notification_events import record_run_transition


class CompletionService:
    """在租约证明下完成 Attempt 收尾、事件持久化与结果聚合，CompletionService 遵守本文件边界，失败返回稳定 Problem。
    CompletionService 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、
    错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def __init__(self, session: AsyncSession, settings: Settings):
        """注入会话与 Settings，供租约校验与重试策略读取，CompletionService.__init__ 遵守本文件边界。
        __init__ 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        self.session, self.settings = session, settings

    async def events(
        self, attempt_id: str, proof: CredentialProofTransport, events: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """在有效围栏下按序追加 AttemptEvent，序号冲突拒绝，CompletionService.events 遵守本文件边界。
        events 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        attempt, job, _, _ = await LeaseService(self.session, self.settings).proof(
            attempt_id, proof
        )
        protected = await protected_event_context(
            ResourceRepository(self.session, WorkspaceScope(attempt.workspace_id)), attempt, job
        )
        for event in events:
            if event["attemptId"] != attempt_id or validate_schema("ExecutionEventV1", event):
                raise Problem(400, "INVALID_EVENT", "Event does not match assigned Attempt")
            if event["type"] == "ATTEMPT_FINISHED":
                payload = event["payload"]
                authentication = payload.get("authentication")
                browser_sso = protected is not None and protected["browserSso"]
                authentication_passed = authentication and authentication["outcome"] == "PASSED"
                # 认证结果只适用于冻结的 SSO 角色，通过的用例必须包含最终身份核验成功，不能省略认证证明。
                if (
                    (authentication is not None and not browser_sso)
                    or (authentication_passed and authentication["stage"] != "IDENTITY")
                    or (
                        browser_sso and payload["outcome"] == "PASSED" and not authentication_passed
                    )
                ):
                    raise Problem(
                        409, "INVALID_EVENT", "Authentication does not match assigned Attempt"
                    )
            if (protected is not None and not protected_event(protected, event)) or (
                protected is None
                and event["type"] == "ASSERTION_RESULT"
                and "sample" in event["payload"]
            ):
                raise Problem(
                    409,
                    "DATASET_EVIDENCE_FORBIDDEN",
                    "Protected event contains unapproved evidence",
                )
            if protected is not None and event["type"] == "ASSERTION_RESULT":
                source, _ = protected["sources"][event["stepId"], event["assertionId"]]
                event = {**event, "payload": {**event["payload"], "expectedSource": source}}
            digest = sha256(canonical_bytes(event)).hexdigest()
            existing = await self.session.get(AttemptEvent, (attempt_id, event["sequence"]))
            if existing:
                if existing.event_hash != digest:
                    raise Problem(409, "EVENT_CONFLICT", "Event replay differs")
                continue
            if event["sequence"] != attempt.last_sequence + 1:
                raise Problem(409, "EVENT_SEQUENCE", "Events must be contiguous")
            self.session.add(
                AttemptEvent(
                    attempt_id=attempt_id,
                    workspace_id=attempt.workspace_id,
                    sequence=event["sequence"],
                    event_hash=digest,
                    document=event,
                )
            )
            attempt.last_sequence = event["sequence"]
            await self.session.flush()
        return {"acceptedThrough": attempt.last_sequence}

    async def finish(
        self, attempt_id: str, proof: CredentialProofTransport, data: dict[str, Any]
    ) -> dict[str, Any]:
        """校验租约与 fence 后落库 outcome，触发 Job/Run 聚合或安全重试，CompletionService.finish 遵守本文件边界。
        finish 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，
        勿假设通用成功默认值。
        """
        runtime, binding, _ = await RuntimeService(self.session).require_device(proof.authorization)
        attempt = await self.session.get(Attempt, attempt_id)
        if (
            not attempt
            or attempt.runtime_id != runtime.id
            or attempt.workspace_id != binding.workspace_id
        ):
            raise Problem(403, "ATTEMPT_FORBIDDEN", "Attempt is not assigned to this Runtime")
        job = await self.session.get(Job, attempt.job_id)
        assert job
        await require_requester(self.session, job, runtime.id)
        if attempt.finish_receipt:
            if attempt.finish_hash != data["manifestSha256"]:
                raise Problem(
                    409, "FINISH_CONFLICT", "Different manifest cannot overwrite completed Attempt"
                )
            return attempt.finish_receipt
        await LeaseService(self.session, self.settings).proof(attempt_id, proof)
        repo = ResourceRepository(self.session, WorkspaceScope(job.workspace_id))
        uploads = (
            (
                await self.session.execute(
                    select(AttemptUpload).where(
                        AttemptUpload.attempt_id == attempt.id, AttemptUpload.complete.is_(True)
                    )
                )
            )
            .scalars()
            .all()
        )
        uploaded = {u.sha256: u for u in uploads}
        if data["manifestSha256"] not in uploaded:
            raise Problem(
                409, "COMPLETION_MANIFEST_REQUIRED", "Upload exact completion manifest bytes first"
            )
        manifest = json.loads((await repo.artifact(data["manifestSha256"])).content)
        if (
            validate_schema("CompletionManifestV1", manifest)
            or manifest["attemptId"] != attempt.id
            or manifest["jobManifestSha256"] != attempt.manifest_hash
            or manifest["kind"] != job.kind
            or data["kind"] != job.kind
            or manifest["cleanupStatus"] != data["cleanupStatus"]
        ):
            raise Problem(409, "INVALID_COMPLETION", "Completion does not match frozen assignment")
        # 完成清单先通过身份、租约和原始字节绑定后才校验范围，保证任何归约或发布回执都不会把错平台的正声明变成可释放的在
        # 线容量证明。
        validate_process_stop_claim(
            runtime.capabilities, manifest["processStopped"], manifest.get("processStopScope")
        )
        events = [
            r.document
            for r in (
                await self.session.execute(
                    select(AttemptEvent)
                    .where(AttemptEvent.attempt_id == attempt.id)
                    .order_by(AttemptEvent.sequence)
                )
            ).scalars()
        ]
        evidence_complete = data["lastSequence"] == attempt.last_sequence
        matched_evidence: list[AttemptUpload] = []
        for entry in manifest["evidence"]:
            # 不同路径可共享相同字节，例如空编译元数据，但清单中的每个路径仍须匹配自身已完成的上传。
            # 摘要索引可用于核对闭包成员。证据须逐项匹配摘要、大小、敏感级别和文件名，并由 ARTIFACT_CREATED
            # 关联该上传 ID、kind 和完整文件项。任一匹配缺失会使证据不完整。
            matched = [
                upload
                for upload in uploads
                if upload.sha256 == entry["sha256"]
                and upload.size_bytes == entry["sizeBytes"]
                and upload.metadata_json["sensitivity"] == entry["sensitivity"]
                and upload.metadata_json["filename"] == entry["path"]
                and any(
                    e["type"] == "ARTIFACT_CREATED"
                    and e["payload"]["artifactId"] == upload.id
                    and e["payload"]["kind"] == upload.metadata_json["kind"]
                    and e["payload"]["file"] == entry
                    for e in events
                )
            ]
            if matched:
                matched_evidence.extend(matched)
            else:
                evidence_complete = False
        evidence_complete &= set(manifest["requiredEvidence"]) <= {
            e["sha256"] for e in manifest["evidence"]
        }
        safe_to_retry = False
        if job.kind == "VALIDATE":
            facts = await self.validation(
                job,
                attempt,
                runtime.trust_status,
                manifest,
                uploaded,
                repo,
                evidence_complete,
                matched_evidence,
            )
        elif job.kind == "TEST":
            assignment = json.loads((await repo.artifact(attempt.manifest_hash)).content)
            bundle = json.loads((await repo.artifact(assignment["compiledBundleSha256"])).content)
            metadata = next(
                (f for f in bundle["files"] if f["path"] == "metadata/expected-plans.json"), None
            )
            if (
                not metadata
                or metadata["sha256"] != manifest["expectedPlansSha256"]
                or manifest["caseVersionId"] != assignment["caseVersionId"]
            ):
                raise Problem(
                    409, "EXPECTED_PLAN_REQUIRED", "Completion must bind approved expected plan"
                )
            plans = json.loads((await repo.artifact(metadata["sha256"])).content)
            if validate_schema("ExpectedPlansV1", plans):
                raise Problem(409, "EXPECTED_PLAN_REQUIRED", "Expected plan is invalid")
            plan = next(
                (p for p in plans["cases"] if p["caseVersionId"] == assignment["caseVersionId"]),
                None,
            )
            if not plan:
                raise Problem(409, "EXPECTED_PLAN_REQUIRED", "Expected CASE is absent")
            safe_to_retry = retry_is_safe(
                plan.get("hasPotentialWrites"),
                manifest.get("retrySafety"),
                bool(job.required_capabilities.get("cleanupSnapshotSha256")),
                manifest["cleanupStatus"],
            )
            evidence_kinds = {u.metadata_json["kind"] for u in matched_evidence}
            required = set(plan["requiredEvidenceKinds"])
            if await protected_test(repo, job, attempt.snapshot_hash):
                # 矩阵、命名依赖及认证模式取自冻结快照，设备声明不能把普通任务降级为仅需结构化证据。
                required.discard("TRACE")
                evidence_complete &= not evidence_kinds
            evidence_complete &= required <= evidence_kinds
            evidence_complete &= any(
                e["type"] == "ATTEMPT_STARTED"
                and e["payload"]["engineVersion"] == assignment["engineVersion"]
                and e["payload"]["sourceHash"] == bundle["sourceHash"]
                for e in events
            )
            facts = reduce_test(
                plan,
                events,
                manifest,
                evidence_complete=evidence_complete,
                cancel_requested=job.state == "CANCEL_REQUESTED",
            )
        else:
            assignment = json.loads((await repo.artifact(attempt.manifest_hash)).content)
            if (
                manifest["fixtureVersionId"] != assignment["fixtureVersionId"]
                or manifest["namespace"] != assignment["namespace"]
            ):
                raise Problem(409, "INVALID_COMPLETION", "Cleanup namespace differs")
            status = manifest["cleanupStatus"]
            evidence_complete &= sum(e["type"] == "ATTEMPT_STARTED" for e in events) == 1
            evidence_complete &= sum(e["type"] == "ATTEMPT_FINISHED" for e in events) == 1
            evidence_complete &= any(
                e["type"] == "CLEANUP_RESULT" and e["payload"]["cleanupStatus"] == status
                for e in events
            )
            facts = {
                "business": manifest["businessOutcome"],
                "cleanup": status,
                "evidence": "COMPLETE" if evidence_complete else "INCOMPLETE",
                "outcome": "ERROR"
                if status == "FAILED"
                else "PASSED"
                if status == "SUCCEEDED" and evidence_complete
                else "INCOMPLETE",
            }
        # 各 kind 的归约器只裁定业务结果；停止布尔值与实际提供的范围单独保留，历史清单未声明范围时不得替它补造全后代或受
        # 控集合的保证。
        facts["processStopped"] = manifest["processStopped"]
        if "processStopScope" in manifest:
            facts["processStopScope"] = manifest["processStopScope"]
        was_cancelled = job.state == "CANCEL_REQUESTED"
        attempt.phase, attempt.outcome, attempt.facts = "FINISHED", facts["outcome"], facts
        if attempt.finished_at is None:
            attempt.finished_at = await database_time(self.session)
        attempt.finish_hash = data["manifestSha256"]
        receipt = {
            "attemptId": attempt.id,
            "accepted": True,
            "outcome": facts["outcome"],
            "manifestSha256": attempt.finish_hash,
        }
        attempt.finish_receipt = receipt
        job.state, job.outcome = "FINISHED", facts["outcome"]
        await CapacityService(self.session, self.settings).release(attempt)
        retry_candidate = (
            job.kind == "TEST"
            and job.max_retries == 1
            and attempt.attempt_no == 1
            and attempt.outcome in {"FAILED", "ERROR"}
            and not was_cancelled
        )
        if retry_candidate and not safe_to_retry:
            # 首次测试结案符合重试条件但安全性未确认时，保留原终局、回执和历史，继续归约且禁止重排。
            attempt.facts = {**facts, "retryReasonCode": "RETRY_SAFETY_UNCONFIRMED"}
        if retry_candidate and safe_to_retry:
            snapshot = json.loads((await repo.artifact(attempt.snapshot_hash)).content)
            snapshot["attemptNo"], snapshot["namespace"] = 2, "attempt_" + uuid4().hex
            job.snapshot_hash = await repo.store(canonical_bytes(snapshot))
            assignment = json.loads((await repo.artifact(attempt.manifest_hash)).content)
            assignment["snapshotSha256"] = assignment["executionSnapshotSha256"] = job.snapshot_hash
            job.manifest_hash = await repo.store(canonical_bytes(assignment))
            if cleanup_hash := job.required_capabilities.get("cleanupSnapshotSha256"):
                cleanup = json.loads((await repo.artifact(cleanup_hash)).content)
                cleanup["namespace"] = snapshot["namespace"]
                job.required_capabilities = {
                    **job.required_capabilities,
                    "cleanupSnapshotSha256": await repo.store(canonical_bytes(cleanup)),
                }
            job.state, job.outcome = "QUEUED", None
            if job.case_execution_id:
                execution = await self.session.get(CaseExecution, job.case_execution_id)
                assert execution
                execution.state, execution.outcome = "QUEUED", None
        else:
            await self.aggregate_job(job, attempt)
        return receipt

    async def validation(
        self,
        job: Job,
        attempt: Attempt,
        trust: str,
        manifest: dict[str, Any],
        uploaded: dict[str, AttemptUpload],
        repo: ResourceRepository,
        evidence_complete: bool,
        matched_evidence: list[AttemptUpload],
    ) -> dict[str, Any]:
        """VALIDATE 成功时写入 ValidationReceipt 并绑定编译产物摘要，CompletionService.validation 遵守本文件边界。
        validation 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if trust != "MANAGED":
            raise Problem(
                403, "UNTRUSTED_COMPILER", "Only approved managed compiler completion may publish"
            )
        source = json.loads((await repo.artifact(attempt.snapshot_hash)).content)
        # 已领取的任务可能跨越批准库存更新，签发前用当前发行条目和任务冻结能力重新判断是否可以接纳完成。
        engine = ApprovedEngines(self.settings).require_validation(
            source["engineVersion"],
            job.required_capabilities,
            inventory_hash=manifest["engineInventorySha256"],
        )
        if not evidence_complete:
            raise Problem(
                409, "INVALID_EVIDENCE", "Compiler evidence must match retained uploads and events"
            )
        if manifest["businessOutcome"] == "ERROR":
            required_logs = set(manifest["requiredEvidence"]) & {
                e["sha256"] for e in manifest["evidence"]
            }
            if not any(
                u.sha256 in required_logs and u.metadata_json["kind"] == "LOG" and u.size_bytes > 0
                for u in matched_evidence
            ):
                raise Problem(
                    409,
                    "COMPILE_DIAGNOSTIC_REQUIRED",
                    "Compilation failure requires an uploaded nonempty LOG",
                )
            return {
                "outcome": "ERROR",
                "business": "ERROR",
                "cleanup": manifest["cleanupStatus"],
                "evidence": "COMPLETE",
                "errorCode": manifest["failureCode"],
                **({"diagnostics": manifest["diagnostics"]} if "diagnostics" in manifest else {}),
            }
        bundle_hash = manifest["compiledBundleSha256"]
        if bundle_hash not in uploaded:
            raise Problem(
                409,
                "COMPILED_BYTES_REQUIRED",
                "Compiled descriptor must be uploaded by this Attempt",
            )
        bundle = json.loads((await repo.artifact(bundle_hash)).content)
        if (
            validate_schema("CompiledAssetBundle", bundle)
            or bundle["sourceHash"] != source["sourceHash"]
            or any(
                bundle[k] != engine[k]
                for k in ["engineVersion", "compilerVersion", "runnerSdkVersion", "dependencies"]
            )
        ):
            raise Problem(
                409,
                "INVALID_COMPILED_BUNDLE",
                "Compiled descriptor differs from frozen source or approved engine",
            )
        files = {f["path"]: f for f in bundle["files"]}
        if len(files) != len(bundle["files"]) or sorted(
            e["caseVersionId"] for e in bundle["entrypoints"]
        ) != sorted(source["entryCaseVersionIds"]):
            raise Problem(409, "INVALID_COMPILED_BUNDLE", "Compiled entries differ")
        for file in [*bundle["files"], *engine["files"]]:
            if (
                file["sha256"] not in uploaded
                or (await repo.artifact(file["sha256"])).size_bytes != file["sizeBytes"]
            ):
                raise Problem(
                    409, "COMPILED_BYTES_REQUIRED", "Actual approved file bytes are missing"
                )
        for fixed in engine["files"]:
            if fixed["path"] != "engine/compiler.tgz" and files.get(fixed["path"]) != fixed:
                raise Problem(409, "ENGINE_INVENTORY_MISMATCH", "Release files differ")
        source_file = files.get("source/asset-snapshot.json")
        expected_source = (
            {k: v for k, v in source.items() if k != "validationTarget"}
            if source["entryCaseVersionIds"]
            else source
        )
        if job.required_capabilities.get("connectedDatasets"):
            from .connected_datasets import project_source

            expected_source = project_source(expected_source)
        if (
            not source_file
            or (await repo.artifact(source_file["sha256"])).content
            != canonical_bytes(expected_source)
            or bool(bundle.get("validationOnly")) != (not source["entryCaseVersionIds"])
            or any(
                e["path"] != f"cases/{e['caseVersionId']}.test.ts" or e["path"] not in files
                for e in bundle["entrypoints"]
            )
        ):
            raise Problem(
                409,
                "INVALID_COMPILED_SOURCE",
                "Retained compiler source or entrypoints differ from frozen assignment",
            )
        metadata = files.get("metadata/expected-plans.json")
        if not metadata:
            raise Problem(409, "EXPECTED_PLAN_REQUIRED", "Compiler must emit expected plan")
        plans = json.loads((await repo.artifact(metadata["sha256"])).content)
        if validate_schema("ExpectedPlansV1", plans) or sorted(
            p["caseVersionId"] for p in plans["cases"]
        ) != sorted(source["entryCaseVersionIds"]):
            raise Problem(409, "EXPECTED_PLAN_REQUIRED", "Expected plan does not match source")
        if manifest["businessOutcome"] != "PASSED" or manifest["cleanupStatus"] not in {
            "NOT_REQUIRED",
            "SUCCEEDED",
        }:
            return {
                "outcome": "ERROR",
                "business": manifest["businessOutcome"],
                "cleanup": manifest["cleanupStatus"],
                "evidence": "COMPLETE",
            }
        target = source["validationTarget"]
        self.session.add(
            ValidationReceipt(
                id=str(uuid4()),
                workspace_id=job.workspace_id,
                resource_id=target["resourceId"],
                job_id=job.id,
                revision=target["revision"],
                source_hash=source["sourceHash"],
                engine_version=source["engineVersion"],
                compiled_bundle_sha256=bundle_hash,
                runtime_id=attempt.runtime_id,
                attempt_id=attempt.id,
                compiler_trust="MANAGED",
                validated_at=await database_time(self.session),
            )
        )
        return {
            "outcome": "PASSED",
            "business": "PASSED",
            "cleanup": manifest["cleanupStatus"],
            "evidence": "COMPLETE",
        }

    async def aggregate_job(self, job: Job, attempt: Attempt) -> None:
        """根据 Attempt 结果更新 Job 终态，必要时调度唯一一次重试，CompletionService.aggregate_job 遵守本文件边界。
        aggregate_job 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if job.case_execution_id:
            execution = await self.session.get(CaseExecution, job.case_execution_id)
            assert execution
            history = (
                (
                    await self.session.execute(
                        select(Attempt).where(Attempt.job_id == job.id).order_by(Attempt.attempt_no)
                    )
                )
                .scalars()
                .all()
            )
            execution.state = "FINISHED"
            execution.outcome = (
                "UNSTABLE"
                if attempt.outcome == "PASSED" and any(a.outcome != "PASSED" for a in history[:-1])
                else attempt.outcome
            )
            job.outcome = execution.outcome
        if job.run_id:
            await self.aggregate_run(job.run_id)

    async def aggregate_run(self, run_id: str) -> None:
        """汇总 CaseExecution 结果更新 Run 状态与正式门禁相关字段，CompletionService.aggregate_run 遵守本文件边界。
        aggregate_run 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、
        错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        run = await self.session.get(Run, run_id)
        assert run
        cases = (
            (
                await self.session.execute(
                    select(CaseExecution).where(CaseExecution.run_id == run.id)
                )
            )
            .scalars()
            .all()
        )
        if all(c.state == "FINISHED" for c in cases):
            previous = run.state
            run.state, run.outcome = (
                "FINISHED",
                aggregate([c.outcome or "INCOMPLETE" for c in cases]),
            )
            await record_run_transition(self.session, run, previous)


def retry_is_safe(
    has_potential_writes: bool | None,
    observed: str | None,
    fixture_declared: bool,
    cleanup_status: str,
) -> bool:
    """判断失败是否允许整案重试；不安全副作用场景返回 False 禁止重放，retry_is_safe 遵守本文件边界，失败返回稳定
    Problem。
    retry_is_safe 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、
    错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return (fixture_declared and cleanup_status == "SUCCEEDED") or (
        has_potential_writes is False and observed == "READ_ONLY_OBSERVED"
    )
