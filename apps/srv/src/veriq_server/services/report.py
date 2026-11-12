"""Scoped, bounded projections of retained execution facts. Never a result writer."""

import base64
import json
from hashlib import sha256
from typing import Any
from urllib.parse import quote
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..auth.authorization import WorkspaceScope
from ..credentials.crypto import EncryptedValue
from ..credentials.service import configured_keyring
from ..db import (
    Run,
    CaseExecution,
    Job,
    Attempt,
    AttemptEvent,
    AttemptUpload,
    Artifact,
    User,
    SecretVersion,
    AuditLog,
)
from ..service import Problem, stamp
from ..contracts import canonical_bytes
from cryptography.exceptions import InvalidTag
from ..settings import Settings
from .workspace import WorkspaceRepository
from .runs import run_dto
from .gate import gate, current_gate

SENSITIVE = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "cleanuptoken",
    "x-veriq-lease-token",
    "x-veriq-fencing-token",
    "password",
    "token",
    "storagestate",
}


def redact(value: Any, secrets: set[str], *, dynamic_keys: bool = True) -> Any:
    protected = sorted(
        {
            v
            for s in secrets
            for v in (s, quote(s, safe=""), base64.b64encode(s.encode()).decode())
            if v
        },
        key=len,
        reverse=True,
    )

    def visit(item: Any) -> Any:
        if isinstance(item, str):
            for secret in protected:
                item = item.replace(secret, "[REDACTED]")
            return item
        if isinstance(item, list):
            return [visit(v) for v in item]
        if isinstance(item, dict):
            # Withhold the whole dynamic object: renaming protected keys could merge
            # distinct members (including an existing literal "[REDACTED]" key).
            if dynamic_keys and any(secret in k for k in item for secret in protected):
                return "[REDACTED]"
            if str(item.get("name", "")).lower() in SENSITIVE and "value" in item:
                item = {**item, "value": "[REDACTED]"}
            return {
                k: "[REDACTED]" if k.lower() in SENSITIVE else visit(v) for k, v in item.items()
            }
        return item

    return visit(value)


class ReportService:
    def __init__(self, session: AsyncSession, user: User, settings: Settings):
        self.session, self.user, self.settings = session, user, settings

    async def run(self, scope: WorkspaceScope, run_id: str) -> Run:
        await WorkspaceRepository(self.session, scope).authorize(self.user)
        run = await self.session.get(Run, run_id)
        if not run or run.workspace_id != scope.workspace_id:
            raise Problem(404, "RUN_NOT_FOUND", "Run not found")
        return run

    async def attempts(self, scope: WorkspaceScope, run_id: str) -> list[Attempt]:
        return list(
            (
                await self.session.execute(
                    select(Attempt)
                    .join(Job, Job.id == Attempt.job_id)
                    .where(
                        Job.workspace_id == scope.workspace_id,
                        Job.run_id == run_id,
                        Job.kind == "TEST",
                    )
                    .order_by(Attempt.id)
                    .limit(2001)
                )
            ).scalars()
        )

    async def get(self, scope: WorkspaceScope, run_id: str) -> dict[str, Any]:
        run = await self.run(scope, run_id)
        cases = list(
            (
                await self.session.execute(
                    select(CaseExecution)
                    .where(
                        CaseExecution.workspace_id == scope.workspace_id,
                        CaseExecution.run_id == run_id,
                    )
                    .order_by(CaseExecution.id)
                    .limit(1001)
                )
            ).scalars()
        )
        attempts = await self.attempts(scope, run_id)
        if len(cases) > 1000 or len(attempts) > 2000:
            raise Problem(409, "REPORT_LIMIT", "Run exceeds the admitted report bound")
        jobs = list(
            (
                await self.session.execute(
                    select(Job).where(Job.workspace_id == scope.workspace_id, Job.run_id == run_id)
                )
            ).scalars()
        )
        by_case = {job.id: job.case_execution_id for job in jobs}
        cleanup_rows = list(
            (
                await self.session.execute(
                    select(Job).where(
                        Job.workspace_id == scope.workspace_id,
                        Job.kind == "CLEANUP",
                        Job.origin_attempt_id.in_([a.id for a in attempts]),
                    )
                )
            ).scalars()
        )
        cleanups: dict[str, list[dict[str, Any]]] = {}
        for cleanup in cleanup_rows:
            assert cleanup.origin_attempt_id
            cleanups.setdefault(cleanup.origin_attempt_id, []).append(
                {"id": cleanup.id, "state": cleanup.state, "outcome": cleanup.outcome}
            )
        projected: dict[str, list[dict[str, Any]]] = {case.id: [] for case in cases}
        execution_gates, current_gates = [], []
        for attempt in attempts:
            at_execution = gate(attempt.outcome, attempt.execution_provenance)
            current = await current_gate(self.session, attempt)
            execution_gates.append(at_execution)
            current_gates.append(current)
            facts = {
                k: v
                for k, v in attempt.facts.items()
                if k
                in {
                    "outcome",
                    "business",
                    "cleanup",
                    "evidence",
                    "errorCode",
                    "retryReasonCode",
                    "diagnostics",
                }
            }
            case_id = by_case[attempt.job_id]
            assert case_id is not None
            projected[case_id].append(
                {
                    "id": attempt.id,
                    "attemptNo": attempt.attempt_no,
                    "runtimeId": attempt.runtime_id,
                    "phase": attempt.phase,
                    "outcome": attempt.outcome,
                    "facts": facts,
                    "createdAt": stamp(attempt.created_at),
                    "activatedAt": stamp(attempt.activated_at) if attempt.activated_at else None,
                    "finishedAt": stamp(attempt.finished_at) if attempt.finished_at else None,
                    "lastSequence": attempt.last_sequence,
                    "provenance": attempt.execution_provenance,
                    "gateAtExecution": at_execution,
                    "gateNow": current,
                    "compensations": cleanups.get(attempt.id, []),
                }
            )

        def combined(gates: list[dict[str, Any]]) -> dict[str, Any]:
            reasons = sorted({reason for item in gates for reason in item["reasons"]})
            if run.outcome != "PASSED":
                reasons.append("RUN_NOT_PASSED")
            if not gates:
                reasons.append("NO_EXECUTION")
            return {"passed": not reasons, "reasons": reasons}

        return {
            "run": run_dto(run),
            "cases": [
                {
                    "id": case.id,
                    "caseVersionId": case.case_version_id,
                    "state": case.state,
                    "outcome": case.outcome,
                    "provenance": case.provenance,
                    "attempts": sorted(projected[case.id], key=lambda a: a["attemptNo"]),
                }
                for case in cases
            ],
            "gateAtExecution": combined(execution_gates),
            "gateNow": combined(current_gates),
            "statistics": {
                "caseCount": len(cases),
                "firstPassCount": sum(
                    any(a["attemptNo"] == 1 and a["outcome"] == "PASSED" for a in projected[c.id])
                    for c in cases
                ),
                "retryPassCount": sum(
                    any(a["attemptNo"] == 2 and a["outcome"] == "PASSED" for a in projected[c.id])
                    for c in cases
                ),
                "infrastructureErrorCount": sum(a.outcome == "ERROR" for a in attempts),
            },
        }

    async def attempt(self, scope: WorkspaceScope, attempt_id: str) -> Attempt:
        await WorkspaceRepository(self.session, scope).authorize(self.user)
        attempt = await self.session.get(Attempt, attempt_id)
        if not attempt or attempt.workspace_id != scope.workspace_id:
            raise Problem(404, "ATTEMPT_NOT_FOUND", "Attempt not found")
        return attempt

    async def secrets(self, attempt: Attempt) -> tuple[set[str], bool]:
        snapshot = await self.session.get(Artifact, (attempt.workspace_id, attempt.snapshot_hash))
        if (
            not snapshot
            or snapshot.content is None
            or snapshot.expired_at
            or snapshot.size_bytes != len(snapshot.content)
            or sha256(snapshot.content).hexdigest() != snapshot.sha256
        ):
            return set(), False
        secrets: set[str] = set()

        def collect(value: Any) -> None:
            if isinstance(value, str) and value:
                secrets.add(value)
            elif isinstance(value, list):
                for v in value:
                    collect(v)
            elif isinstance(value, dict):
                for v in value.values():
                    collect(v)

        try:
            pins = json.loads(snapshot.content).get("secretVersions", [])
            ring = configured_keyring(self.settings)
            for pin in pins:
                row = await self.session.get(SecretVersion, pin["versionId"])
                if (
                    not row
                    or row.workspace_id != attempt.workspace_id
                    or row.secret_ref != pin["secretRef"]
                ):
                    return set(), False
                collect(
                    ring.decrypt(
                        row.workspace_id,
                        row.secret_ref,
                        row.id,
                        EncryptedValue(row.key_id, row.nonce, row.ciphertext),
                    )
                )
        except (ValueError, KeyError, InvalidTag):
            return set(), False
        return secrets, True

    async def events(
        self,
        scope: WorkspaceScope,
        attempt_id: str,
        after: int,
        limit: int = 100,
        byte_budget: int = 1024 * 1024,
    ) -> dict[str, Any]:
        attempt = await self.attempt(scope, attempt_id)
        rows = list(
            (
                await self.session.execute(
                    select(AttemptEvent)
                    .where(AttemptEvent.attempt_id == attempt.id, AttemptEvent.sequence > after)
                    .order_by(AttemptEvent.sequence)
                    .limit(limit + 1)
                )
            ).scalars()
        )
        secrets, available = await self.secrets(attempt)
        items: list[dict[str, Any]] = []
        total_bytes = 0
        for row in rows[:limit]:
            e = row.document
            payload = e["payload"]
            if e["type"] in {"LOG", "ARTIFACT_CREATED", "VARIABLE_EXTRACTED"}:
                payload = {"withheld": True}
            elif not available:
                payload = {
                    k: v
                    for k, v in payload.items()
                    if k in {"status", "durationMs", "severity", "cleanupStatus", "outcome"}
                }
            elif e["type"] == "ASSERTION_RESULT":
                payload = {
                    **payload,
                    "expected": redact(payload["expected"], secrets),
                    "actual": {
                        **payload["actual"],
                        **(
                            {"value": redact(payload["actual"]["value"], secrets)}
                            if "value" in payload["actual"]
                            else {}
                        ),
                    },
                }
            # Envelope, event payload and ActualValue keys are protocol-owned. Only
            # the JsonValue fields above may contain response-selected member names.
            item = redact(
                {**e, "payload": payload, "valuesAvailable": available},
                secrets,
                dynamic_keys=False,
            )
            size = len(canonical_bytes(item))
            if items and total_bytes + size > byte_budget:
                break
            items.append(item)
            total_bytes += size
        return {
            "items": items,
            "nextSequence": items[-1]["sequence"] if items else after,
            "hasMore": len(rows) > len(items),
        }

    async def artifacts(self, scope: WorkspaceScope, attempt_id: str) -> list[dict[str, Any]]:
        await self.attempt(scope, attempt_id)
        rows = (
            await self.session.execute(
                select(AttemptUpload, Artifact)
                .join(
                    Artifact,
                    (Artifact.workspace_id == AttemptUpload.workspace_id)
                    & (Artifact.sha256 == AttemptUpload.sha256),
                )
                .where(AttemptUpload.attempt_id == attempt_id, AttemptUpload.complete.is_(True))
                .order_by(AttemptUpload.id)
                .limit(1000)
            )
        ).all()
        return [
            {
                "id": upload.id,
                "attemptId": attempt_id,
                "sha256": upload.sha256,
                "sizeBytes": upload.size_bytes,
                "kind": upload.metadata_json["kind"],
                "sensitivity": "CREDENTIAL_RESTRICTED",
                "state": "EXPIRED" if upload.expired_at or artifact.expired_at else "AVAILABLE",
            }
            for upload, artifact in rows
        ]

    async def audit(self, scope: WorkspaceScope, after: str = "") -> dict[str, Any]:
        await WorkspaceRepository(self.session, scope).authorize(self.user)
        rows = list(
            (
                await self.session.execute(
                    select(AuditLog)
                    .where(AuditLog.workspace_id == scope.workspace_id, AuditLog.id > after)
                    .order_by(AuditLog.id)
                    .limit(101)
                )
            ).scalars()
        )
        return {
            "items": [
                {
                    "id": r.id,
                    "actorId": r.actor_id,
                    "targetId": r.target_id,
                    "action": r.action,
                    "createdAt": stamp(r.created_at),
                }
                for r in rows[:100]
            ],
            "nextCursor": rows[99].id if len(rows) > 100 else None,
        }

    async def display(self, scope: WorkspaceScope, run_id: str, attempt_id: str) -> dict[str, Any]:
        from ..contracts import validate_schema
        from ..repositories.resource import ResourceRepository

        await self.run(scope, run_id)
        attempt = await self.attempt(scope, attempt_id)
        job = await self.session.get(Job, attempt.job_id)
        if not job or job.run_id != run_id or job.kind != "TEST":
            raise Problem(404, "ATTEMPT_NOT_FOUND", "Attempt not found in this Run")
        repo = ResourceRepository(self.session, scope)
        snapshot = json.loads((await repo.artifact(attempt.snapshot_hash)).content)
        secrets, available = await self.secrets(attempt)
        environment = {k: snapshot[k] for k in ["browser", "environmentVersionId"] if k in snapshot}
        environment.update(
            {
                k: v
                for k, v in snapshot.get("environment", {}).items()
                if k in {"baseURL", "apiBaseURL", "locale", "timezone"}
            }
        )
        result: dict[str, Any] = {
            "display": None,
            "metadataStatus": "ABSENT",
            "environment": redact(environment, secrets, dynamic_keys=False) if available else {},
        }
        if not available:
            result["metadataStatus"] = "REDACTED"
            return result
        manifest = json.loads((await repo.artifact(attempt.manifest_hash)).content)
        if not manifest.get("compiledBundleSha256"):
            return result
        bundle = json.loads((await repo.artifact(manifest["compiledBundleSha256"])).content)
        member = next(
            (f for f in bundle["files"] if f["path"] == "metadata/report-display.json"), None
        )
        if not member:
            return result
        artifact = await repo.artifact(member["sha256"])
        if artifact.size_bytes != member["sizeBytes"]:
            raise Problem(409, "INVALID_ARTIFACT", "Report display size differs from descriptor")
        display = json.loads(artifact.content)
        if validate_schema("ReportDisplayV1", display) or len(
            {c["caseVersionId"] for c in display["cases"]}
        ) != len(display["cases"]):
            raise Problem(409, "INVALID_REPORT_DISPLAY", "Report display metadata is invalid")
        selected = next(
            (c for c in display["cases"] if c["caseVersionId"] == manifest["caseVersionId"]), None
        )
        expected_member = next(
            (f for f in bundle["files"] if f["path"] == "metadata/expected-plans.json"), None
        )
        if not selected or not expected_member:
            raise Problem(409, "INVALID_REPORT_DISPLAY", "Report case metadata is missing")
        expected = json.loads((await repo.artifact(expected_member["sha256"])).content)
        plan = next(
            (c for c in expected["cases"] if c["caseVersionId"] == selected["caseVersionId"]), None
        )
        steps = selected["steps"]
        if (
            not plan
            or len({s["id"] for s in steps}) != len(steps)
            or len(steps) != len(plan["steps"])
        ):
            raise Problem(409, "INVALID_REPORT_DISPLAY", "Report steps differ from expected plan")
        for actual, planned in zip(steps, plan["steps"], strict=True):
            if (
                any(actual.get(k) != planned.get(k) for k in ["id", "order", "parentId"])
                or len({a["id"] for a in actual["assertions"]}) != len(actual["assertions"])
                or {a["id"] for a in actual["assertions"]}
                != {a["id"] for a in planned["assertions"]}
                or [o["id"] for o in actual["observers"]] != planned["observers"]
            ):
                raise Problem(
                    409, "INVALID_REPORT_DISPLAY", "Report labels do not match expected execution"
                )
        projected = redact(selected, secrets, dynamic_keys=False)
        if validate_schema("ReportDisplayV1", {"schemaVersion": "1.0", "cases": [projected]}):
            return {**result, "metadataStatus": "REDACTED"}
        return {**result, "display": projected, "metadataStatus": "AVAILABLE"}
