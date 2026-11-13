"""SQLAlchemy 模型与异步引擎：所有表以 veriq_ 为前缀，Workspace 作为资源与授权边界，会话隔离级别为 READ COMMITTED。

uuid/hash 列使用 ascii_bin 校对，邮箱用 utf8mb4_0900_as_ci；复合外键强制同 Workspace 引用不可跨租户。
Job/Attempt/容量与发布围栏相关约束在表级 CheckConstraint 固化，防止服务层遗漏破坏不变量。
Database 隐藏连接参数并启用 pool_pre_ping，连接时固定 UTC 时区。"""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    ForeignKeyConstraint,
    BigInteger,
    JSON,
    Index,
)
from sqlalchemy.dialects.mysql import DATETIME, LONGBLOB
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .settings import Settings


class Base(DeclarativeBase):
    """全部 ORM 模型的声明式基类，集中注册元数据，供 Alembic 迁移脚本与异步引擎共享同一套表定义。表前缀统一为 veriq_。
    Base 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    pass


uuid_type = String(36, collation="ascii_bin")
hash_type = String(64, collation="ascii_bin")


class Installation(Base):
    """安装单例行记录是否已初始化以及 setup 密钥摘要；开局与依赖安装护栏的突变必须 FOR UPDATE 该行。该行 id 恒为 1。
    Installation 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_installation"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    initialized: Mapped[bool] = mapped_column(Boolean, default=False)
    setup_secret_hash: Mapped[str | None] = mapped_column(hash_type)


class User(Base):
    """控制面用户账号：唯一邮箱（大小写不敏感）、Argon2 口令哈希、禁用标记与系统管理员标志。邮箱唯一索引防重复注册。邮箱唯一索引防止重复注册。
    User 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_users"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    email: Mapped[str] = mapped_column(String(254, collation="utf8mb4_0900_as_ci"), unique=True)
    display_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(255, collation="ascii_bin"))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    system_admin: Mapped[bool] = mapped_column(Boolean, default=False)


class UserSession(Base):
    """登录会话行仅存令牌 SHA-256 与过期时间；改密或强制吊销通过删除行立即失效 Cookie。token_hash 全局唯一。
    UserSession 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_user_sessions"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class UserToken(Base):
    """密码重置一次性令牌只存哈希与过期/消费标记；新签发清空同用户旧令牌以保证链接互斥。consumed 标记防二次使用。consumed 标记防止令牌二次使用。
    UserToken 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_user_tokens"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditLog(Base):
    """安全审计追加日志可绑定 actor、target 与 Workspace，随业务事务提交失败则回滚。不承载业务补偿逻辑。
    AuditLog 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_audit_logs"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    actor_id: Mapped[str | None] = mapped_column(uuid_type)
    target_id: Mapped[str | None] = mapped_column(uuid_type)
    workspace_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    action: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Workspace(Base):
    """租户 Workspace 持有稳定 ascii key、显示名与归档标记，是资源与授权的根边界。归档后仍保留历史只读。归档后历史数据仍可只读保留。
    Workspace 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_workspaces"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class WorkspaceMember(Base):
    """Workspace 成员关系以复合主键携带角色与状态，授权查询以此表为真源。status 区分邀请中与生效。status 区分邀请中与已生效成员。
    WorkspaceMember 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_workspace_members"
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_users.id"), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    status: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))


class WorkspaceInvite(Base):
    """成员邀请以 token_hash 唯一，含过期、消费与吊销标志，防止重复接受。revoked 与 consumed 互不复活。
    WorkspaceInvite 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_workspace_invites"
    __table_args__ = (UniqueConstraint("token_hash"),)
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    email: Mapped[str] = mapped_column(String(254, collation="utf8mb4_0900_as_ci"))
    role: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    token_hash: Mapped[str] = mapped_column(hash_type)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Database:
    """异步引擎与会话工厂：READ COMMITTED、utf8mb4、UTC，并 hide_parameters 防日志泄密。
    Database 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    def __init__(self, settings: Settings):
        """根据 Settings 创建隐藏 SQL 参数的异步引擎，以及 expire_on_commit=False 的会话工厂供请求复用。
        __init__ 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        self.engine = create_async_engine(
            settings.database_url.get_secret_value(),
            isolation_level="READ COMMITTED",
            pool_pre_ping=True,
            connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+00:00'"},
            hide_parameters=True,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def close(self) -> None:
        """释放异步引擎连接池中的全部连接，供 CLI 子命令与应用进程关闭路径安全地调用，Database.close 的失败路径返回稳定错误。
        close 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        await self.engine.dispose()


# 不可变源码、内容与校验溯源均归属既有 Workspace，查询与外键不得跨租户拼接。
class Resource(Base):
    """Workspace 内资源头：kind+key 唯一，跟踪状态与 latest_version_id 发布指针。跨 Workspace 查询必须失败。
    Resource 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_resources"
    __table_args__ = (
        UniqueConstraint("workspace_id", "kind", "key"),
        UniqueConstraint("workspace_id", "id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    kind: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    name: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    latest_version_id: Mapped[str | None] = mapped_column(uuid_type)


class ResourceDraft(Base):
    """可编辑草稿以 revision 乐观锁保护 document_json，发布时冻结为不可变版本。更新必须比对 revision。
    ResourceDraft 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_resource_drafts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "resource_id"], ["veriq_resources.workspace_id", "veriq_resources.id"]
        ),
    )
    resource_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    revision: Mapped[int] = mapped_column(BigInteger)
    document_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    updated_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ResourceVersion(Base):
    """不可变已发布版本绑定草稿修订、哈希、引擎与校验回执，禁止就地改写历史。version_no 在资源内递增。version_no 在同一资源内单调递增。
    ResourceVersion 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_resource_versions"
    __table_args__ = (
        UniqueConstraint("resource_id", "version_no"),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("resource_id", "draft_revision"),
        ForeignKeyConstraint(
            ["workspace_id", "resource_id"], ["veriq_resources.workspace_id", "veriq_resources.id"]
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    resource_id: Mapped[str] = mapped_column(uuid_type)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    kind: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    version_no: Mapped[int] = mapped_column(Integer)
    draft_revision: Mapped[int] = mapped_column(BigInteger)
    document_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    sha256: Mapped[str] = mapped_column(hash_type)
    source_hash: Mapped[str] = mapped_column(hash_type)
    engine_version: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    receipt_id: Mapped[str] = mapped_column(uuid_type)
    published_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    published_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ResourceDependency(Base):
    """同 Workspace 版本依赖边两侧外键均带 workspace_id，阻断跨租户引用。依赖版本必须同租户。依赖版本必须与引用方同租户。
    ResourceDependency 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_resource_dependencies"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "dependency_version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
    )
    workspace_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    version_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    dependency_version_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)


class Artifact(Base):
    """按 Workspace+sha256 内容寻址产物，可 INLINE/外部后端，含 incarnation 与过期删除戳。
    Artifact 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_artifacts"
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    sha256: Mapped[str] = mapped_column(hash_type, primary_key=True)
    content: Mapped[bytes | None] = mapped_column(LONGBLOB, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    storage_backend: Mapped[str] = mapped_column(
        String(16), default="INLINE", server_default="INLINE"
    )
    storage_incarnation: Mapped[str | None] = mapped_column(uuid_type)
    expired_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    deleted_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))


class ArtifactDeletion(Base):
    """待物理删除队列记录后端与 incarnation，供维护任务幂等清理外部对象。deleted_at 空表示仍待清理。deleted_at 为空表示仍待物理清理。
    ArtifactDeletion 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_artifact_deletions"
    __table_args__ = (Index("ix_artifact_delete_pending", "workspace_id", "deleted_at"),)
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    sha256: Mapped[str] = mapped_column(hash_type)
    storage_backend: Mapped[str] = mapped_column(String(16))
    storage_incarnation: Mapped[str | None] = mapped_column(uuid_type)
    deleted_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))


class ArtifactPublication(Base):
    """发布围栏 PENDING/COMMITTED/RETIRED，在线上传与离线上传所有者互斥。CheckConstraint 固化所有者互斥。
    ArtifactPublication 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_artifact_publications"
    __table_args__ = (
        Index("ix_artifact_publication_pending", "workspace_id", "state", "id"),
        CheckConstraint("state IN ('PENDING','COMMITTED','RETIRED')", name="ck_publication_state"),
        CheckConstraint(
            "(upload_id IS NULL) <> (offline_upload_id IS NULL)", name="ck_publication_owner"
        ),
        ForeignKeyConstraint(
            ["workspace_id", "offline_upload_id"],
            ["veriq_offline_import_uploads.workspace_id", "veriq_offline_import_uploads.id"],
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    sha256: Mapped[str] = mapped_column(hash_type)
    storage_backend: Mapped[str] = mapped_column(String(16))
    upload_id: Mapped[str | None] = mapped_column(uuid_type, ForeignKey("veriq_attempt_uploads.id"))
    offline_upload_id: Mapped[str | None] = mapped_column(uuid_type)
    state: Mapped[str] = mapped_column(String(16), default="PENDING")


class Job(Base):
    """执行任务 TEST/VALIDATE/CLEANUP，含 fencing fence、重试上限≤1 与主体外键约束。active_attempt_id 指向当前尝试。
    Job 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_jobs"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("workspace_id", "validation_key"),
        Index("ix_veriq_job_claim", "workspace_id", "state", "created_at", "id"),
        ForeignKeyConstraint(
            ["workspace_id", "maintenance_id"],
            ["veriq_maintenance_receipts.workspace_id", "veriq_maintenance_receipts.id"],
            name="fk_job_maintenance",
        ),
        CheckConstraint(
            "kind <> 'TEST' OR subject_id = case_execution_id", name="ck_job_case_subject"
        ),
        CheckConstraint(
            "kind <> 'CLEANUP' OR (maintenance_id IS NOT NULL AND subject_id = maintenance_id AND origin_attempt_id IS NOT NULL)",
            name="ck_job_cleanup_subject",
        ),
        CheckConstraint("kind IN ('TEST','VALIDATE','CLEANUP')", name="ck_job_kind"),
        CheckConstraint("max_retries >= 0 AND max_retries <= 1", name="ck_job_retry_bound"),
        CheckConstraint(
            "(kind = 'TEST' AND run_id IS NOT NULL AND case_execution_id IS NOT NULL) OR (kind <> 'TEST' AND run_id IS NULL AND case_execution_id IS NULL)",
            name="ck_job_subject",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "run_id", "case_execution_id"],
            [
                "veriq_case_executions.workspace_id",
                "veriq_case_executions.run_id",
                "veriq_case_executions.id",
            ],
            name="fk_job_run_execution",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "origin_attempt_id"],
            ["veriq_attempts.workspace_id", "veriq_attempts.id"],
            name="fk_job_origin_attempt",
            use_alter=True,
        ),
        ForeignKeyConstraint(
            ["workspace_id", "run_id"],
            ["veriq_runs.workspace_id", "veriq_runs.id"],
            name="fk_job_run",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "case_execution_id"],
            ["veriq_case_executions.workspace_id", "veriq_case_executions.id"],
            name="fk_job_execution",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "id", "active_attempt_id"],
            ["veriq_attempts.workspace_id", "veriq_attempts.job_id", "veriq_attempts.id"],
            name="fk_job_active_attempt",
            use_alter=True,
        ),
        ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "manifest_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    kind: Mapped[str] = mapped_column(String(16, collation="ascii_bin"))
    subject_id: Mapped[str] = mapped_column(uuid_type)
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"), index=True)
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    manifest_hash: Mapped[str] = mapped_column(hash_type)
    validation_key: Mapped[str | None] = mapped_column(hash_type)
    required_capabilities: Mapped[dict[str, Any]] = mapped_column(JSON)
    active_attempt_id: Mapped[str | None] = mapped_column(uuid_type)
    run_id: Mapped[str | None] = mapped_column(uuid_type)
    case_execution_id: Mapped[str | None] = mapped_column(uuid_type)
    requested_runtime_id: Mapped[str | None] = mapped_column(uuid_type)
    requested_location: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    requester_service_token_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_service_tokens.id", name="fk_job_service_requester")
    )
    origin_attempt_id: Mapped[str | None] = mapped_column(uuid_type)
    maintenance_id: Mapped[str | None] = mapped_column(uuid_type)
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    wait_reason: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    max_retries: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    fence: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ValidationReceipt(Base):
    """校验回执将成功 VALIDATE Attempt 与编译产物摘要钉到资源修订供发布核对。job_id 唯一约束防重复回执。
    ValidationReceipt 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_validation_receipts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "resource_id"], ["veriq_resources.workspace_id", "veriq_resources.id"]
        ),
        ForeignKeyConstraint(
            ["workspace_id", "job_id"], ["veriq_jobs.workspace_id", "veriq_jobs.id"]
        ),
        ForeignKeyConstraint(
            ["workspace_id", "compiled_bundle_sha256"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        UniqueConstraint("job_id"),
        ForeignKeyConstraint(
            ["workspace_id", "job_id", "attempt_id", "runtime_id"],
            [
                "veriq_attempts.workspace_id",
                "veriq_attempts.job_id",
                "veriq_attempts.id",
                "veriq_attempts.runtime_id",
            ],
            name="fk_validation_attempt",
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    resource_id: Mapped[str] = mapped_column(uuid_type)
    job_id: Mapped[str] = mapped_column(uuid_type)
    revision: Mapped[int] = mapped_column(BigInteger)
    source_hash: Mapped[str] = mapped_column(hash_type)
    engine_version: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    compiled_bundle_sha256: Mapped[str] = mapped_column(hash_type)
    runtime_id: Mapped[str] = mapped_column(uuid_type)
    attempt_id: Mapped[str] = mapped_column(uuid_type)
    compiler_trust: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    validated_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class SecretRef(Base):
    """Workspace 密钥引用名只存 key；密文与身份白名单在 SecretVersion。不在此表存放任何密文字节。本表不存放任何密文字节内容。
    SecretRef 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    SecretRef 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

    __tablename__ = "veriq_secret_refs"
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class SecretVersion(Base):
    """密钥不可变版本：主密钥封装密文、允许身份列表与吊销标记，解析须版本钉死。revoked 后不可再被解析投递。revoked 后不可再被解析或投递。
    SecretVersion 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    SecretVersion 触及凭证材料：管理面不得回传明文，日志与审计只能保留摘要或引用标识。
    """

    __tablename__ = "veriq_secret_versions"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "secret_ref"],
            ["veriq_secret_refs.workspace_id", "veriq_secret_refs.key"],
        ),
        UniqueConstraint("workspace_id", "id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    secret_ref: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    key_id: Mapped[str] = mapped_column(String(80, collation="ascii_bin"))
    nonce: Mapped[bytes] = mapped_column(LONGBLOB)
    ciphertext: Mapped[bytes] = mapped_column(LONGBLOB)
    allowed_identity_ids: Mapped[list[str]] = mapped_column(JSON)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class AuthAdapterVersion(Base):
    """认证适配器不可变版本含内容哈希与配置 JSON，可吊销但不可改历史字节。content_hash 用于快照钉死。content_hash 用于执行快照钉死。
    AuthAdapterVersion 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_auth_adapter_versions"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    content_hash: Mapped[str] = mapped_column(hash_type)
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Runtime(Base):
    """执行设备 Runtime：用户或服务账号二选一所有者，含信任状态、位置与能力。trust_status 影响正式门禁资格。
    Runtime 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_runtimes"
    __table_args__ = (
        CheckConstraint(
            "(owner_user_id IS NULL) <> (owner_service_account_id IS NULL)",
            name="ck_runtime_one_owner",
        ),
    )
    owner_service_account_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_service_accounts.id")
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    owner_user_id: Mapped[str | None] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    name: Mapped[str] = mapped_column(String(160))
    location: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    trust_status: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    capabilities: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    last_seen_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))


class RuntimeBinding(Base):
    """Runtime 与 Workspace 绑定：共享范围、凭据投递许可与激活状态。active=false 立即切断派发。
    RuntimeBinding 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_runtime_bindings"
    runtime_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_runtimes.id"), primary_key=True
    )
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    shared_with_workspace: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_credential_delivery: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class RuntimeGrant(Base):
    """私有 Runtime 显式共享给 Workspace 内具名用户的授权行，非全员默认开放。授权变更需管理权限。变更共享授权需要管理工作区权限。
    RuntimeGrant 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_runtime_grants"
    __table_args__ = (
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
    )
    runtime_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"), primary_key=True)


class RuntimeEnrollment(Base):
    """人机注册请求仅存审批码与轮询密钥哈希，短窗过期不可复活，明文不落库。审批与轮询密钥职责分离。审批码与轮询密钥职责严格分离。
    RuntimeEnrollment 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_runtime_enrollments"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    user_code_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    device_code_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    last_polled_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    request_hash: Mapped[str] = mapped_column(hash_type, index=True)
    name: Mapped[str] = mapped_column(String(160))
    capabilities: Mapped[dict[str, Any]] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    runtime_id: Mapped[str | None] = mapped_column(uuid_type, ForeignKey("veriq_runtimes.id"))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)


class RuntimeToken(Base):
    """设备凭证代际以哈希存当前/候选轮换令牌，配合 fencing 防旧代重放。轮换候选未确认前不覆盖当前。轮换候选未确认前不覆盖当前令牌。
    RuntimeToken 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_runtime_tokens"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    runtime_id: Mapped[str] = mapped_column(uuid_type)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    __table_args__ = (
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
    )
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    rotation_request_id: Mapped[str | None] = mapped_column(uuid_type)
    successor_hash: Mapped[str | None] = mapped_column(hash_type)


class ServiceAccount(Base):
    """Workspace 服务账号用于无人值守 Runtime 注册与维护触发，禁用后令牌失效。名称仅在 Workspace 内有意义。
    ServiceAccount 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_service_accounts"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(160))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ServiceToken(Base):
    """服务账号令牌只存哈希可吊销，供 /internal 维护与 service enroll 消费。吊销立即拒绝后续 Bearer。
    ServiceToken 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_service_tokens"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    service_account_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_service_accounts.id"), index=True
    )
    token_hash: Mapped[str] = mapped_column(hash_type, unique=True)
    purpose: Mapped[str] = mapped_column(String(40, collation="ascii_bin"))
    operation_scopes: Mapped[list[str] | None] = mapped_column(JSON)
    plan_scopes: Mapped[list[str] | None] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    consumed_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    revoked_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class ExecutionPlan(Base):
    """执行计划保存经授权的已发布资源选择与并发修订号，每次触发独立冻结配置并递增计划内序号，归档保留历史关联而不允许继续派发新任务或扩大服务令牌权限。"""

    __tablename__ = "veriq_execution_plans"
    __table_args__ = (UniqueConstraint("workspace_id", "id"),)
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    name: Mapped[str] = mapped_column(String(160))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    next_sequence: Mapped[int] = mapped_column(Integer, default=0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    selection: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class Run(Base):
    """一次套件/用例执行批次：幂等键绑定意图，状态机受 30 分钟预算与取消约束。idempotency_key 防重复创建。
    Run 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_runs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("workspace_id", "idempotency_key"),
        UniqueConstraint("plan_id", "plan_sequence", name="uq_run_plan_sequence"),
        ForeignKeyConstraint(
            ["workspace_id", "plan_id"],
            ["veriq_execution_plans.workspace_id", "veriq_execution_plans.id"],
            name="fk_run_plan",
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    created_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    plan_id: Mapped[str | None] = mapped_column(uuid_type)
    plan_revision: Mapped[int | None] = mapped_column(Integer)
    plan_sequence: Mapped[int | None] = mapped_column(Integer)
    requester_service_token_id: Mapped[str | None] = mapped_column(
        uuid_type, ForeignKey("veriq_service_tokens.id")
    )
    idempotency_key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    request_hash: Mapped[str] = mapped_column(hash_type)
    trigger_kind: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    reason_code: Mapped[str | None] = mapped_column(String(80, collation="ascii_bin"))
    source: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class CaseExecution(Base):
    """Run 内单用例执行：绑定发布或冻结草稿版本，并聚合 Attempt 结果与门禁。与 Job.subject 外键对齐。
    CaseExecution 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_case_executions"
    __table_args__ = (
        UniqueConstraint("workspace_id", "run_id", "id"),
        ForeignKeyConstraint(
            ["workspace_id", "source_snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "published_case_version_id"],
            ["veriq_resource_versions.workspace_id", "veriq_resource_versions.id"],
        ),
        CheckConstraint(
            "(published_case_version_id IS NULL) <> (candidate_version_id IS NULL)",
            name="ck_case_source_kind",
        ),
        CheckConstraint(
            "case_version_id = COALESCE(published_case_version_id, candidate_version_id)",
            name="ck_case_source_identity",
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("run_id", "variant_key"),
        ForeignKeyConstraint(
            ["workspace_id", "run_id"], ["veriq_runs.workspace_id", "veriq_runs.id"]
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    run_id: Mapped[str] = mapped_column(uuid_type)
    case_version_id: Mapped[str] = mapped_column(uuid_type)
    published_case_version_id: Mapped[str | None] = mapped_column(uuid_type)
    candidate_version_id: Mapped[str | None] = mapped_column(uuid_type)
    source_snapshot_hash: Mapped[str] = mapped_column(hash_type)
    variant_key: Mapped[str] = mapped_column(hash_type)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))


class Attempt(Base):
    """Job 一次领取尝试：租约、围栏、阶段与容量；过期或未知进程失权威并隔离容量。lease_token 仅存哈希。lease_token 仅以哈希形式持久化。
    Attempt 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_attempts"
    __table_args__ = (
        Index("ix_veriq_attempt_expiry", "workspace_id", "phase", "lease_expires_at", "id"),
        UniqueConstraint("workspace_id", "id", "runtime_id"),
        ForeignKeyConstraint(
            ["workspace_id", "snapshot_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "manifest_hash"],
            ["veriq_artifacts.workspace_id", "veriq_artifacts.sha256"],
        ),
        CheckConstraint(
            "fencing_token >= 1 AND fencing_token <= 9007199254740991", name="ck_attempt_fence"
        ),
        CheckConstraint(
            "phase IN ('LEASED','PREPARING','RUNNING','CLEANING','FINALIZING','FINISHED')",
            name="ck_attempt_phase",
        ),
        CheckConstraint(
            "capacity_state IN ('HELD','QUARANTINED','RELEASED')", name="ck_attempt_capacity_state"
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("job_id", "attempt_no"),
        UniqueConstraint("workspace_id", "job_id", "id"),
        UniqueConstraint("workspace_id", "job_id", "id", "runtime_id"),
        ForeignKeyConstraint(
            ["workspace_id", "job_id"], ["veriq_jobs.workspace_id", "veriq_jobs.id"]
        ),
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
        CheckConstraint("attempt_no >= 1 AND attempt_no <= 2", name="ck_attempt_retry_bound"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    job_id: Mapped[str] = mapped_column(uuid_type)
    runtime_id: Mapped[str] = mapped_column(uuid_type)
    attempt_no: Mapped[int] = mapped_column(Integer)
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    manifest_hash: Mapped[str] = mapped_column(hash_type)
    lease_token_hash: Mapped[str] = mapped_column(hash_type)
    fencing_token: Mapped[int] = mapped_column(BigInteger)
    lease_expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    activated_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    phase: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    outcome: Mapped[str | None] = mapped_column(String(24, collation="ascii_bin"))
    capacity_state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))
    facts: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    execution_provenance: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    finished_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    finish_hash: Mapped[str | None] = mapped_column(hash_type)
    finish_receipt: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    last_sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class CapacityPool(Base):
    """命名容量池 claim 时固定顺序加锁增减 used；默认全局浏览器 4、Workspace 2。used 不得超过 limit。
    CapacityPool 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """

    __tablename__ = "veriq_capacity_pools"
    key: Mapped[str] = mapped_column(String(240, collation="ascii_bin"), primary_key=True)
    limit: Mapped[int] = mapped_column(Integer)
    used: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (CheckConstraint("used >= 0 AND used <= `limit`", name="ck_capacity_bound"),)


class ResourceLease(Base):
    """Attempt 容量占用行 HELD/QUARANTINED/RELEASED，释放时必须回退 pool.used。隔离态不回退 used 直至调和。
    ResourceLease 路径涉及租约或 fencing：过期、错配令牌或不属于本设备的占用必须失败关闭而非降级继续。
    ResourceLease 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_resource_leases"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id"], ["veriq_attempts.workspace_id", "veriq_attempts.id"]
        ),
    )
    attempt_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    pool_key: Mapped[str] = mapped_column(
        String(240, collation="ascii_bin"), ForeignKey("veriq_capacity_pools.key"), primary_key=True
    )
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    state: Mapped[str] = mapped_column(String(24, collation="ascii_bin"))


class ClaimReceipt(Base):
    """领取回执记录 Runtime 成功 claim Job 的事实，支撑审计与重复领取诊断。与 fence 递增一起审计。与 fencingToken 递增一并审计。
    ClaimReceipt 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    ClaimReceipt 的领取/竞争语义依赖数据库锁或原子更新，禁止先读计数再无锁启动执行。
    """

    __tablename__ = "veriq_claim_receipts"
    __table_args__ = (
        Index("ix_veriq_claim_idle", "runtime_id", "attempt_id"),
        Index("ix_veriq_claim_expiry", "workspace_id", "created_at"),
        ForeignKeyConstraint(
            ["runtime_id", "workspace_id"],
            ["veriq_runtime_bindings.runtime_id", "veriq_runtime_bindings.workspace_id"],
        ),
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id", "runtime_id"],
            ["veriq_attempts.workspace_id", "veriq_attempts.id", "veriq_attempts.runtime_id"],
        ),
    )
    runtime_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    client_request_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    request_hash: Mapped[str] = mapped_column(hash_type)
    attempt_id: Mapped[str | None] = mapped_column(uuid_type)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class AttemptEvent(Base):
    """执行事件流条目须在有效租约与围栏校验后按序追加，供报告只读消费。序号冲突拒绝写入。序号冲突时拒绝写入事件；AttemptEvent 的查询与外键均不得跨租户拼接。
    AttemptEvent 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_attempt_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id"], ["veriq_attempts.workspace_id", "veriq_attempts.id"]
        ),
    )
    attempt_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    event_hash: Mapped[str] = mapped_column(hash_type)
    document: Mapped[dict[str, Any]] = mapped_column(JSON)


class AttemptUpload(Base):
    """在线证据上传会话分块写入并与 publication 围栏联动，提交前对报告不可见。完成后才提交 publication。
    AttemptUpload 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_attempt_uploads"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "attempt_id"], ["veriq_attempts.workspace_id", "veriq_attempts.id"]
        ),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    attempt_id: Mapped[str] = mapped_column(uuid_type, index=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    sha256: Mapped[str] = mapped_column(hash_type)
    size_bytes: Mapped[int] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    content: Mapped[bytes] = mapped_column(LONGBLOB, default=bytes)
    expired_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
    complete: Mapped[bool] = mapped_column(Boolean, default=False)


class MaintenanceReceipt(Base):
    """幂等维护触发回执以 key 绑定操作，清理 Job 以其标识为 subject_id。相同 key 重放同一回执。相同 key 重放返回同一回执。
    MaintenanceReceipt 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_maintenance_receipts"
    __table_args__ = (UniqueConstraint("workspace_id", "id"),)
    id: Mapped[str] = mapped_column(uuid_type)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), primary_key=True
    )
    idempotency_key: Mapped[str] = mapped_column(
        String(160, collation="ascii_bin"), primary_key=True
    )
    request_hash: Mapped[str] = mapped_column(hash_type)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON)


class AiProvider(Base):
    """Workspace AI 提供方限制允许 base URL、密钥引用与预算；测试可不依赖真实模型。密钥经主密钥封装存放。
    AiProvider 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    AiProvider 属于 AI 辅助路径：无有效 Provider 时不得假装成功，模型输出不得自动发布为正式资产。
    """

    __tablename__ = "veriq_ai_providers"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    revision: Mapped[int] = mapped_column(Integer)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    key_id: Mapped[str] = mapped_column(String(80))
    key_version: Mapped[str] = mapped_column(uuid_type)
    nonce: Mapped[bytes] = mapped_column(LONGBLOB)
    ciphertext: Mapped[bytes] = mapped_column(LONGBLOB)


class AiGeneration(Base):
    """AI 生成草稿含预览/失败/人工审核状态机，模型输出永不自动发布为资源版本。审核通过才可进入草稿编辑。审核通过后才可进入草稿编辑流。
    AiGeneration 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    AiGeneration 属于 AI 辅助路径：无有效 Provider 时不得假装成功，模型输出不得自动发布为正式资产。
    """

    __tablename__ = "veriq_ai_generations"
    __table_args__ = (
        UniqueConstraint("workspace_id", "request_id", name="uq_ai_request"),
        Index("ix_ai_history", "workspace_id", "created_at", "id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    provider_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_ai_providers.id"))
    actor_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    request_id: Mapped[str] = mapped_column(uuid_type)
    request_hash: Mapped[str] = mapped_column(hash_type)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    month: Mapped[str] = mapped_column(String(7))
    status: Mapped[str] = mapped_column(String(20))
    purpose: Mapped[str] = mapped_column(String(24))
    reserved_micros: Mapped[int] = mapped_column(BigInteger)
    cost_micros: Mapped[int | None] = mapped_column(BigInteger)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)


class Bundle(Base):
    """离线导出包元数据含清单哈希、过期与签名信息；字节由导出流水线组装签名。下载需 Workspace 授权。下载接口必须校验 Workspace 授权。
    Bundle 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_bundles"
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_workspaces.id"), index=True
    )
    exported_by: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    manifest_hash: Mapped[str] = mapped_column(hash_type)
    archive_hash: Mapped[str] = mapped_column(hash_type)
    snapshot_hash: Mapped[str] = mapped_column(hash_type)
    signature: Mapped[bytes] = mapped_column(LONGBLOB)
    contains_draft: Mapped[bool] = mapped_column(Boolean, default=False)
    validation_status: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class BundleExport(Base):
    """导出幂等预订用 Idempotency-Key 绑定 Workspace 与请求指纹，同键可安全重放。并发导出受信号量限制。
    BundleExport 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_bundle_exports"
    __table_args__ = (UniqueConstraint("workspace_id", "idempotency_key"),)
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    idempotency_key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"))
    actor_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    request_hash: Mapped[str] = mapped_column(hash_type)
    state: Mapped[str] = mapped_column(String(16))
    bundle_id: Mapped[str | None] = mapped_column(uuid_type, ForeignKey("veriq_bundles.id"))
    authority: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class OfflineImport(Base):
    """离线结果导入头：幂等键与清单哈希，来源固定 OFFLINE_IMPORT，重复返回既有回执。不提升非正式结果门禁。导入不提升非正式结果的正式门禁。
    OfflineImport 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    OfflineImport 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    __tablename__ = "veriq_offline_imports"
    __table_args__ = (
        UniqueConstraint("workspace_id", "bundle_id", "local_run_id"),
        UniqueConstraint("workspace_id", "id"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    bundle_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_bundles.id"))
    local_run_id: Mapped[str] = mapped_column(uuid_type)
    actor_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    run_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_runs.id"))
    request_hash: Mapped[str] = mapped_column(hash_type)
    declared: Mapped[dict[str, Any]] = mapped_column(JSON)
    verified: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))


class OfflineImportKey(Base):
    """导入幂等键登记确保同 Workspace 键不被不同清单或主体悄悄复用覆盖。键与主体一并固化。键与导入主体一并固化登记。
    OfflineImportKey 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    OfflineImportKey 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    __tablename__ = "veriq_offline_import_keys"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "import_id"],
            ["veriq_offline_imports.workspace_id", "veriq_offline_imports.id"],
        ),
    )
    workspace_id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    key: Mapped[str] = mapped_column(String(160, collation="ascii_bin"), primary_key=True)
    import_id: Mapped[str] = mapped_column(uuid_type)
    actor_id: Mapped[str] = mapped_column(uuid_type)
    request_hash: Mapped[str] = mapped_column(hash_type)


class OfflineAttempt(Base):
    """导入生成的离线 Attempt 投影供报告只读；变体缺失时正式门禁保持未通过。不参与在线领取状态机。不参与在线领取与租约状态机。
    OfflineAttempt 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    """

    __tablename__ = "veriq_offline_attempts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "import_id"],
            ["veriq_offline_imports.workspace_id", "veriq_offline_imports.id"],
        ),
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("case_execution_id", "attempt_no"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type)
    import_id: Mapped[str] = mapped_column(uuid_type)
    case_execution_id: Mapped[str] = mapped_column(
        uuid_type, ForeignKey("veriq_case_executions.id")
    )
    local_attempt_id: Mapped[str] = mapped_column(uuid_type)
    attempt_no: Mapped[int] = mapped_column(Integer)
    outcome: Mapped[str] = mapped_column(String(24))
    facts: Mapped[dict[str, Any]] = mapped_column(JSON)
    document: Mapped[dict[str, Any]] = mapped_column(JSON)

    @property
    def last_sequence(self) -> int:
        """从离线 Attempt 文档读取 lastSequence 整型字段，供事件流与报告对齐导入侧已经写入的最大事件序号值。
        last_sequence 实现于 apps/srv/src/veriq_server/db.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
        """
        return int(self.document["lastSequence"])


class OfflineImportUpload(Base):
    """离线产物分块上传与 publication 围栏绑定，未 COMMITTED 前不作已提交证据。分块校验摘要与大小。分块写入时校验摘要与声明大小。
    OfflineImportUpload 必须坚持 Workspace 归属与成员授权，嵌套资源引用不得跨空间隐式放行。
    OfflineImportUpload 处理导入或离线回传时需保持幂等键与来源标识，重复提交不得制造双份业务副作用。
    """

    __tablename__ = "veriq_offline_import_uploads"
    __table_args__ = (
        UniqueConstraint("workspace_id", "id"),
        UniqueConstraint("workspace_id", "bundle_id", "local_run_id", "local_attempt_id", "path"),
    )
    id: Mapped[str] = mapped_column(uuid_type, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_workspaces.id"))
    bundle_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_bundles.id"))
    local_run_id: Mapped[str] = mapped_column(uuid_type)
    local_attempt_id: Mapped[str] = mapped_column(uuid_type)
    actor_id: Mapped[str] = mapped_column(uuid_type, ForeignKey("veriq_users.id"))
    path: Mapped[str] = mapped_column(String(240, collation="ascii_bin"))
    sha256: Mapped[str] = mapped_column(hash_type)
    size_bytes: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16))
    sensitivity: Mapped[str] = mapped_column(String(24))
    content: Mapped[bytes | None] = mapped_column(LONGBLOB)
    state: Mapped[str] = mapped_column(String(16))
    storage_incarnation: Mapped[str | None] = mapped_column(uuid_type)
    created_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    expires_at: Mapped[datetime] = mapped_column(DATETIME(fsp=6))
    expired_at: Mapped[datetime | None] = mapped_column(DATETIME(fsp=6))
