"""Settings 校验控制面运行配置：强制异步 MySQL、生产 HTTPS、主密钥轮换环互斥，以及 SMTP 成对凭据与生产 TLS 约束。

配置来源优先级为 JSON 文件、VERIQ_* 环境变量、CLI 覆盖；SecretStr 字段在 operator_config_values 展开前保持遮蔽。
artifact/AI/容量槽位等运行参数也在此集中声明，供服务层读取而不另设隐式默认值散落。
"""

import json
import os
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


class Settings(BaseModel):
    """控制面强类型配置模型；extra=forbid，生产环境额外强制 HTTPS 公网源以及 SMTP TLS，Settings 的失败路径返回稳定错误。"""

    model_config = ConfigDict(extra="forbid")
    database_url: SecretStr
    public_url: str
    master_key: SecretStr
    master_key_id: str = Field(default="primary", pattern=r"^[A-Za-z0-9_-]{1,80}$")
    previous_master_keys: dict[str, SecretStr] = Field(default_factory=dict)
    signing_key: SecretStr
    environment: Literal["production", "development"] = "production"
    host: str = "127.0.0.1"
    port: int = Field(default=8888, ge=1, le=65535)
    session_hours: int = Field(default=12, ge=1, le=168)
    reset_minutes: int = Field(default=30, ge=1, le=60)

    bundle_issuer_path: str | None = None
    bundle_lifetime_days: int = Field(default=30, ge=1, le=365)
    approved_engine_inventory_path: str | None = None
    artifact_backend: Literal["FILE", "S3"] = "FILE"
    artifact_directory: str = "var/veriq/artifacts"
    artifact_retention_days: int = Field(default=30, ge=1, le=3650)
    artifact_success_retention_days: int = Field(default=14, ge=1, le=3650)
    artifact_s3_bucket: str | None = None
    artifact_s3_endpoint: str | None = None
    artifact_s3_region: str = "us-east-1"
    runtime_job_slots: int = Field(default=1, ge=1, le=100)
    compile_slots: int = Field(default=2, ge=1, le=100)
    cleanup_slots: int = Field(default=2, ge=1, le=100)

    ai_allowed_base_urls: list[str] = Field(
        default_factory=lambda: ["https://api.openai.com/v1", "https://api.anthropic.com/v1"],
        max_length=20,
    )

    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_from: str | None = None
    smtp_username: SecretStr | None = None
    smtp_password: SecretStr | None = None
    smtp_security: Literal["starttls", "tls", "none"] = "starttls"
    smtp_timeout: int = Field(default=10, ge=1, le=30)

    @model_validator(mode="after")
    def production_origin(self) -> "Settings":
        """交叉校验主密钥环、生产公网源与 SMTP 成套配置，拒绝任何不安全或不完整的组合，Settings.production_origin 的失败路径返回稳定错误。"""
        if self.master_key_id in self.previous_master_keys:
            raise ValueError("Active key id must not appear in previous keys")
        for value in self.previous_master_keys.values():
            self.key(value)
        if self.environment == "production" and not self.public_url.startswith("https://"):
            raise ValueError("Production requires HTTPS public URL")
        if self.smtp_host:
            if (
                not self.smtp_from
                or "@" not in self.smtp_from
                or any(c in self.smtp_from for c in "\r\n")
            ):
                raise ValueError("SMTP requires a valid sender address")
            if bool(self.smtp_username) != bool(self.smtp_password):
                raise ValueError("SMTP username and password must be configured together")
            if self.environment == "production" and self.smtp_security == "none":
                raise ValueError("Production SMTP requires TLS")
        elif self.smtp_from or self.smtp_username or self.smtp_password:
            raise ValueError("SMTP host is required when delivery is configured")
        return self

    @field_validator("database_url")
    @classmethod
    def database(cls, v: SecretStr) -> SecretStr:
        """要求 mysql+asyncmy:// 形式的 DSN，排除同步驱动与非 MySQL 方言进入控制面，Settings.database 的失败路径返回稳定错误。"""
        if not v.get_secret_value().startswith("mysql+asyncmy://"):
            raise ValueError("An async MySQL database is required")
        return v

    @field_validator("master_key", "signing_key")
    @classmethod
    def key(cls, v: SecretStr) -> SecretStr:
        """密钥必须为精确 32 字节的十六进制编码字符串，长度不符或解码失败时一律拒绝，Settings.key 的失败路径返回稳定错误。"""
        if len(v.get_secret_value()) != 64:
            raise ValueError("Key must contain 32 bytes encoded as hex")
        if len(bytes.fromhex(v.get_secret_value())) != 32:
            raise ValueError("Key must encode 32 bytes")
        return v

    @field_validator("public_url")
    @classmethod
    def url(cls, v: str) -> str:
        """公网 URL 必须是无用户信息、无查询与片段的 HTTP(S) origin，末尾斜杠会被剥离，Settings.url 的失败路径返回稳定错误。"""
        u = urlsplit(v)
        if (
            u.scheme not in {"http", "https"}
            or not u.hostname
            or u.username
            or u.password
            or u.query
            or u.fragment
            or u.path not in {"", "/"}
        ):
            raise ValueError("Public URL must be an HTTP(S) origin")
        return v.rstrip("/")


def resolve_settings_values(path: Path, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    """合并配置文件、VERIQ_* 环境变量与 CLI 覆盖为原始字典，供 Settings 校验，resolve_settings_values 的失败路径返回稳定错误。"""
    values = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(values, dict):
        raise ValueError("Configuration must be a JSON object")
    for key in Settings.model_fields:
        if (value := os.environ.get("VERIQ_" + key.upper())) is not None:
            values[key] = (
                json.loads(value)
                if key in {"previous_master_keys", "ai_allowed_base_urls"}
                else value
            )
    values.update({k: v for k, v in (overrides or {}).items() if v is not None})
    return values


def load_settings(path: Path, overrides: dict[str, Any] | None = None) -> Settings:
    """读取并校验配置文件，返回不可变语义的 Settings 实例供应用与 CLI 共享使用，load_settings 的失败路径返回稳定错误。"""
    return Settings.model_validate(resolve_settings_values(path, overrides))


def operator_config_values(value: Any) -> Any:
    """递归展开 SecretStr，生成可写回操作员配置文件的明文 JSON 可序列化结构，operator_config_values 的失败路径返回稳定错误。"""
    if isinstance(value, SecretStr):
        return value.get_secret_value()
    if isinstance(value, dict):
        return {key: operator_config_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [operator_config_values(item) for item in value]
    return value
