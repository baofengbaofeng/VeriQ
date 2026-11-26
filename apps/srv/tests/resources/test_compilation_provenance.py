"""校验回执测试比较真实 DTO 投影与接口契约，并验证两种来源只能证明其绑定的已完成作业，防止混用设备与服务端身份。"""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast
from uuid import uuid4

import pytest
from jsonschema import ValidationError

from veriq_server.db import Job, ValidationReceipt
from veriq_server.services.compilation_provenance import validation_origin_matches
from veriq_server.services.publish import receipt_dto
from veriq_server.validation import validate_api


def test_server_receipt_exposes_only_server_compilation_identity() -> None:
    """服务端部署未注册执行设备也能提交成功回执，API 仍须带实际来源的标识并拒绝混入旧设备字段。"""
    compilation_id = str(uuid4())
    row = cast(
        ValidationReceipt,
        SimpleNamespace(
            id=str(uuid4()),
            workspace_id=str(uuid4()),
            resource_id=str(uuid4()),
            job_id=str(uuid4()),
            revision=1,
            source_hash="a" * 64,
            engine_version="0.1.0",
            compiled_bundle_sha256="b" * 64,
            validated_at=datetime.now(UTC).replace(tzinfo=None),
            runtime_id=None,
            attempt_id=None,
            server_compilation_id=compilation_id,
            compiler_trust="MANAGED",
        ),
    )
    dto = receipt_dto(row)
    assert dto["serverCompilationId"] == compilation_id
    assert "runtimeId" not in dto and "attemptId" not in dto
    validate_api("ValidationReceiptDTO", dto)
    with pytest.raises(ValidationError):
        validate_api(
            "ValidationReceiptDTO", dict(dto, runtimeId=str(uuid4()), attemptId=str(uuid4()))
        )


@pytest.mark.parametrize("server_source", [False, True])
def test_compiler_origin_binds_completed_job_and_rejects_mixed_sources(server_source: bool) -> None:
    """两个编译来源都需要等到对应作业成功结束，租约重领、跨空间复制和交叉填入字段均无法复用旧回执。"""
    job = Job(
        id=str(uuid4()),
        workspace_id=str(uuid4()),
        subject_id=str(uuid4()),
        kind="VALIDATE",
        state="FINISHED",
        outcome="PASSED",
        server_compilation_id=str(uuid4()) if server_source else None,
        active_attempt_id=None if server_source else str(uuid4()),
    )
    receipt = ValidationReceipt(
        job_id=job.id,
        workspace_id=job.workspace_id,
        resource_id=job.subject_id,
        compiler_trust="MANAGED",
        runtime_id=None if server_source else str(uuid4()),
        attempt_id=job.active_attempt_id,
        server_compilation_id=job.server_compilation_id,
    )
    assert validation_origin_matches(job, receipt)
    job.state = "RUNNING"
    assert not validation_origin_matches(job, receipt)
    job.state = "FINISHED"
    job.outcome = "ERROR"
    assert not validation_origin_matches(job, receipt)
    job.outcome = "PASSED"
    job.workspace_id = str(uuid4())
    assert not validation_origin_matches(job, receipt)
    job.workspace_id = receipt.workspace_id
    if server_source:
        receipt.runtime_id = str(uuid4())
        assert not validation_origin_matches(job, receipt)
        receipt.runtime_id = None
        job.server_compilation_id = str(uuid4())
    else:
        job.active_attempt_id = str(uuid4())
    assert not validation_origin_matches(job, receipt)
