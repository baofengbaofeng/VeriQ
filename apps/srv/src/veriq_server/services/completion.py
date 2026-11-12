"""CompletionService 处理事件追加、finish、校验回执落地与 Run/Job 聚合；整案重试最多一次且重试通过记 UNSTABLE。
finish 校验围栏与租约后写入 outcome；validation 生成 ValidationReceipt。
retry_is_safe 判断失败是否允许整案重试，避免不安全副作用重放。
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
from .capacity import CapacityService
from .engines import ApprovedEngines
from .jobs import require_requester, database_time
from .lease import LeaseService
from .results import reduce_test, aggregate
from .runtime import RuntimeService


class CompletionService:
    """在租约证明下完成 Attempt 收尾、事件持久化与结果聚合，CompletionService 遵守本文件边界，失败返回稳定 Problem。
    CompletionService 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    def __init__(self, session: AsyncSession, settings: Settings):
        """注入会话与 Settings，供租约校验与重试策略读取，CompletionService.__init__ 遵守本文件边界。
        __init__ 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.session, self.settings = session, settings

    async def events(
        self, attempt_id: str, proof: CredentialProofTransport, events: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """在有效围栏下按序追加 AttemptEvent，序号冲突拒绝，CompletionService.events 遵守本文件边界。
        events 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        attempt, _, _, _ = await LeaseService(self.session, self.settings).proof(attempt_id, proof)
        for event in events:
            if event["attemptId"] != attempt_id or validate_schema("ExecutionEventV1", event):
                raise Problem(400, "INVALID_EVENT", "Event does not match assigned Attempt")
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
        finish 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
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
            # Distinct paths may legitimately share bytes (for example empty compiler
            # metadata). Bind each entry to its own complete upload/event, not an
            # arbitrary last upload in the digest index used for closure membership.
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
            evidence_complete &= set(plan["requiredEvidenceKinds"]) <= evidence_kinds
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
            # Keep the existing terminal reducer/history; only suppress unsafe replay.
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
        validation 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        if trust != "MANAGED":
            raise Problem(
                403, "UNTRUSTED_COMPILER", "Only approved managed compiler completion may publish"
            )
        source = json.loads((await repo.artifact(attempt.snapshot_hash)).content)
        engine, inventory_hash = ApprovedEngines(self.settings).require(source["engineVersion"])
        if manifest["engineInventorySha256"] != inventory_hash:
            raise Problem(409, "ENGINE_INVENTORY_MISMATCH", "Compiler release inventory differs")
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
        aggregate_job 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
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
        aggregate_run 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
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
            run.state, run.outcome = (
                "FINISHED",
                aggregate([c.outcome or "INCOMPLETE" for c in cases]),
            )


def retry_is_safe(
    has_potential_writes: bool | None,
    observed: str | None,
    fixture_declared: bool,
    cleanup_status: str,
) -> bool:
    """判断失败是否允许整案重试；不安全副作用场景返回 False 禁止重放，retry_is_safe 遵守本文件边界，失败返回稳定 Problem。
    retry_is_safe 实现于 apps/srv/src/veriq_server/services/completion.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    return (fixture_declared and cleanup_status == "SUCCEEDED") or (
        has_potential_writes is False and observed == "READ_ONLY_OBSERVED"
    )
