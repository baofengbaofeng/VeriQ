"""将可编辑的 HTTP 数据集与部署方登记的固定路由配对，凭证和传输只接收完成授权后的配置。"""

from ipaddress import ip_address, ip_network
import re
from typing import Literal, Self
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

PRIVATE = tuple(
    ip_network(v) for v in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
)
HEADER = re.compile(r"[a-zA-Z][a-zA-Z0-9-]{0,78}")
RESERVED = {
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "expect",
    "te",
    "upgrade",
    "cookie",
    "set-cookie",
    "authorization",
    "forwarded",
    "content-type",
    "accept-encoding",
}


def safe_header(name: str) -> bool:
    """普通与签名请求头共用名称检查，传输以及代理控制头始终保留给托管客户端或专用认证节点。"""
    lower = name.lower()
    return (
        bool(HEADER.fullmatch(name))
        and lower not in RESERVED
        and not lower.startswith(("proxy-", "x-forwarded-", "x-original-", "x-rewrite-"))
    )


def literal_header(name: str) -> bool:
    """用户请求头不能保存平台或常见鉴权的明文值，受控鉴权头只有服务端绑定版本化凭证后才产生。"""
    return safe_header(name) and name.lower() not in {
        "api-key",
        "x-api-key",
        "x-auth-token",
        "x-access-token",
    }


def safe_path(path: str) -> bool:
    """只允许已经编码无歧义的绝对路径，排除网络路径、点段和二次解码以固定批准时的资源边界。"""
    return (
        bool(re.fullmatch(r"/[a-zA-Z0-9/_~.\-]*", path))
        and "//" not in path
        and not (set(path.split("/")) & {".", ".."})
    )


class CredentialGrant(BaseModel):
    """将单一不可变凭证版本限制在指定算法或鉴权方式，防止签名专用密钥被直接作为令牌传给上游。"""

    model_config = ConfigDict(extra="forbid")
    version_id: str
    purposes: list[Literal["BASIC", "BEARER", "API_KEY", "HMAC_SHA256", "AES256_GCM"]]


class DatasetConnection(BaseModel):
    """每个版本由部署方固定租户、环境、读取路径、授权用户与凭证范围，普通草稿只能选用这个登记项。"""

    model_config = ConfigDict(extra="forbid")
    workspace_id: str
    environment_version_id: str
    origin: str
    address: str
    allow_private: bool = False
    routes: dict[str, list[Literal["GET", "POST"]]]
    service_account_ids: list[str] = Field(default_factory=list)
    user_ids: list[str]
    identity_id: str
    credentials: dict[str, CredentialGrant] = Field(default_factory=dict)
    request_headers: list[str] = Field(default_factory=list)
    signature_header: str = "X-Signature"
    auth_kinds: list[Literal["NONE", "BASIC", "BEARER", "API_KEY", "HMAC_SHA256", "AES256_GCM"]] = (
        Field(default=["NONE"])
    )
    retry_reads: bool = False

    @model_validator(mode="after")
    def verify_target(self) -> Self:
        """服务启动时核对静态地址和 TLS 主机名，企业私网须单独批准而回环与链路本地地址始终关闭。"""
        url = urlsplit(self.origin)
        if (
            url.scheme != "https"
            or not url.hostname
            or not re.fullmatch(r"[a-z0-9.-]+", url.hostname)
            or self.origin != "https://" + url.hostname + (f":{url.port}" if url.port else "")
        ):
            raise ValueError("Expected an HTTPS DNS origin without credentials, path or query")
        # 固定数值地址取消取数时的 DNS 解析；企业私有网段只能通过显式策略放行，链路本地和转换前缀始终排除。
        address = ip_address(self.address)
        private = any(address in network for network in PRIVATE)
        if (not address.is_global and not (private and self.allow_private)) or (
            address.is_multicast
            or address.is_reserved
            or getattr(address, "ipv4_mapped", None)
            or "%" in self.address
            or self.address == "168.63.129.16"
            or any(
                address in ip_network(n)
                for n in (
                    "2002::/16",
                    "2001::/32",
                    "64:ff9b::/96",
                    "64:ff9b:1::/48",
                    "fd00:ec2::/32",
                    "fd20:ce::254/128",
                )
            )
        ):
            raise ValueError("Dataset destination address is forbidden")
        if not all(safe_path(path) for path in self.routes) or not all(
            literal_header(h) for h in self.request_headers
        ):
            raise ValueError("Invalid approved dataset route or header")
        if not safe_header(self.signature_header):
            raise ValueError("Invalid managed authentication header")
        return self
