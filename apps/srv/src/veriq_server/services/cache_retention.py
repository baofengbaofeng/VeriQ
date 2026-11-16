"""VeriQ 缓存回收先完成整个工作区可达引用闭包再处理到期内联候选，预算不足、强引用缺失或载荷不可解释时整页保留，
绝不拿部分扫描结果证明不可达或直接删除外置对象。
"""

from datetime import timedelta
from hashlib import sha256
import json
import math
import re
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, select, update, func
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import Artifact, Base, AuditLog
from ..settings import Settings
from ..service import Problem
from .jobs import database_time

DIGEST = re.compile(r"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])")
REFERENCE_COLUMNS = {
    "source_hash",
    "snapshot_hash",
    "manifest_hash",
    "archive_hash",
    "source_snapshot_hash",
    "compiled_bundle_sha256",
}
BINARY_LEAVES = {
    "application/zip",
    "application/octet-stream",
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/webm",
}


class IncompleteGraph(ValueError):
    """引用闭包不能完整证明时使用稳定原因代替业务载荷和路径，调用方仅把原因写入最小审计行并保留全部候选，
    不把未知格式当成没有子引用的普通叶子节点。
    """


def references(value: Any, *, depth: int = 0) -> set[str]:
    """保守收集 JSON 键值及文本中出现的全部十六进制内容摘要，实际不是制品引用的哈希只会额外保护内容；
    超过嵌套边界或非可移植值导致闭包不可证明，不能安静忽略。
    """
    if depth > 64:
        raise IncompleteGraph("depth")
    if isinstance(value, str):
        return set(DIGEST.findall(value))
    if isinstance(value, float) and not math.isfinite(value):
        raise IncompleteGraph("nonfinite")
    if value is None or isinstance(value, (int, float, bool)):
        return set()
    if isinstance(value, dict):
        result = set()
        for key, child in value.items():
            result.update(references(key, depth=depth + 1))
            result.update(references(child, depth=depth + 1))
        return result
    if isinstance(value, list):
        result = set()
        for child in value:
            result.update(references(child, depth=depth + 1))
        return result
    raise IncompleteGraph("value")


async def protected_closure(session: AsyncSession, workspace: str, settings: Settings) -> set[str]:
    """扫描已注册模型的直接制品列和所有工作区 JSON 根，随后只沿现存内联内容继续扩展；所有强外键根必须存在，
    过期归档墓碑可作为终止点，其它缺失或损坏根会阻止整页回收。
    """
    roots: set[str] = set()
    strong: set[str] = set()
    root_budget = settings.lifecycle_graph_max_rows
    byte_budget = settings.lifecycle_graph_max_bytes
    for table in Base.metadata.tables.values():
        if "workspace_id" not in table.c or table.name == "veriq_artifacts":
            continue
        hash_columns = [column for column in table.c if column.name in REFERENCE_COLUMNS]
        json_columns = [column for column in table.c if isinstance(column.type, JSON)]
        if "sha256" in table.c:
            hash_columns.append(table.c.sha256)
        if not hash_columns and not json_columns:
            continue
        columns = [*hash_columns, *json_columns]
        lengths = [
            func.octet_length(column).label("veriq_bytes_" + str(index))
            for index, column in enumerate(json_columns)
        ]
        probe = (
            select(*hash_columns, *lengths)
            .where(table.c.workspace_id == workspace)
            .limit(root_budget + 1)
            .subquery()
        )
        totals = (
            await session.execute(
                select(
                    func.count(),
                    *[
                        func.coalesce(func.sum(probe.c["veriq_bytes_" + str(index)]), 0)
                        for index in range(len(json_columns))
                    ],
                ).select_from(probe)
            )
        ).one()
        if int(totals[0]) > root_budget:
            raise IncompleteGraph("root_budget")
        if sum(int(value) for value in totals[1:]) > byte_budget:
            raise IncompleteGraph("byte_budget")
        rows = (
            (
                await session.execute(
                    select(*columns).where(table.c.workspace_id == workspace).limit(root_budget + 1)
                )
            )
            .mappings()
            .all()
        )
        if len(rows) > root_budget:
            raise IncompleteGraph("root_budget")
        root_budget -= len(rows)
        for row in rows:
            for column in hash_columns:
                digest = row[column.name]
                if digest is None:
                    continue
                if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
                    raise IncompleteGraph("root_hash")
                roots.add(digest)
                if column.name in REFERENCE_COLUMNS:
                    strong.add(digest)
            for column in json_columns:
                document = row[column.name]
                try:
                    size = len(json.dumps(document, allow_nan=False).encode())
                except (TypeError, ValueError):
                    raise IncompleteGraph("root_json") from None
                byte_budget -= size
                if byte_budget < 0:
                    raise IncompleteGraph("byte_budget")
                roots.update(references(document))
    protected: set[str] = set()
    pending = list(roots)
    inspected = 0
    while pending:
        digest = pending.pop()
        if digest in protected:
            continue
        inspected += 1
        if inspected > settings.lifecycle_graph_max_nodes:
            raise IncompleteGraph("node_budget")
        # 内容列在长度检查之后才加载，避免单个异常大对象绕过整图字节预算；未找到的普通文本哈希不是强引用，
        # 仍保留其摘要但不会虚构它有任何可扫描的子对象。
        identity = (
            await session.execute(
                select(
                    Artifact.size_bytes,
                    Artifact.storage_backend,
                    Artifact.expired_at,
                    Artifact.media_type,
                    func.length(Artifact.content),
                ).where(
                    Artifact.workspace_id == workspace,
                    Artifact.sha256 == digest,
                )
            )
        ).first()
        protected.add(digest)
        if identity is None:
            if digest in strong:
                raise IncompleteGraph("missing_root")
            continue
        size, backend, expired, media, stored_size = identity
        if expired is not None:
            continue
        media = media.split(";", 1)[0].lower()
        if media in BINARY_LEAVES:
            continue
        if backend != "INLINE":
            raise IncompleteGraph("external_document")
        if size > byte_budget or size < 0 or stored_size is None or stored_size != size:
            raise IncompleteGraph("byte_budget")
        raw = (
            await session.execute(
                select(Artifact.content).where(
                    Artifact.workspace_id == workspace, Artifact.sha256 == digest
                )
            )
        ).scalar_one()
        if raw is None or len(raw) != size or sha256(raw).hexdigest() != digest:
            raise IncompleteGraph("corrupt_document")
        byte_budget -= size
        try:
            if media == "application/json" or media.endswith("+json"):
                document = json.loads(raw)
                children = references(document)
            elif media.startswith("text/") or media in {
                "application/javascript",
                "application/typescript",
            }:
                children = references(raw.decode("utf-8"))
            else:
                raise IncompleteGraph("unknown_media")
        except (UnicodeDecodeError, ValueError):
            raise IncompleteGraph("malformed_document") from None
        pending.extend(children - protected)
    return protected


async def expire_cache(
    session: AsyncSession, settings: Settings, workspace: str, limit: int, cursor: str
) -> tuple[int, bool, str | None]:
    """在调用方持有安装锁的同一事务内完成闭包和年龄候选扫描，仅清除证明不再可达的内联载荷并保留逻辑墓碑；外置对象、
    待发布围栏和幂等屏障继续由原制品维护服务拥有。
    """
    if cursor and not DIGEST.fullmatch(cursor):
        raise Problem(400, "INVALID_CURSOR", "Cache retention cursor is invalid")
    current = await database_time(session)
    try:
        protected = await protected_closure(session, workspace, settings)
    except IncompleteGraph as error:
        session.add(
            AuditLog(
                id=str(uuid4()),
                workspace_id=workspace,
                actor_id=None,
                target_id=workspace,
                action="artifact.gc_preserved_" + str(error),
                created_at=current,
            )
        )
        return 0, False, None
    rows = list(
        (
            await session.execute(
                select(Artifact.sha256)
                .where(
                    Artifact.workspace_id == workspace,
                    Artifact.sha256 > cursor,
                    Artifact.storage_backend == "INLINE",
                    Artifact.expired_at.is_(None),
                    Artifact.created_at
                    < current - timedelta(days=settings.metadata_retention_days),
                )
                .order_by(Artifact.sha256)
                .limit(limit + 1)
            )
        ).scalars()
    )
    count = 0
    for digest in rows[:limit]:
        if digest in protected:
            continue
        await session.execute(
            update(Artifact)
            .where(Artifact.workspace_id == workspace, Artifact.sha256 == digest)
            .values(
                expired_at=current,
                deleted_at=current,
                content=None,
            )
        )
        count += 1
    more = len(rows) > limit
    return count, more, rows[limit - 1] if more else None
