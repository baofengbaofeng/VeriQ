"""以相同密钥材料、不同请求配置和畸形模型响应分别覆盖供应商凭据、输入预算和输出解析的边界。"""

import json

import httpx
import pytest
from cryptography.exceptions import InvalidTag
from emulator import emulator

from veriq_server.contracts import canonical_bytes
from veriq_server.credentials.crypto import Keyring
from veriq_server.infrastructure.providers import DraftContext, ProviderGateway, limit_response
from veriq_server.settings import resolve_settings_values


def test_provider_key_ciphertext_is_not_a_business_credential():
    """使用相同密钥字节分别初始化凭据和供应商密钥环，检查改变用途或工作区后均无法通过认证解密。"""
    business = Keyring("primary", {"primary": bytes(32)})
    provider = Keyring("primary", {"primary": bytes(32)}, purpose="veriq-ai-provider-v1")
    ciphertext = provider.encrypt("workspace", "ref", "version", "synthetic-api-key")
    assert provider.decrypt("workspace", "ref", "version", ciphertext) == "synthetic-api-key"
    with pytest.raises(InvalidTag):
        business.decrypt("workspace", "ref", "version", ciphertext)
    with pytest.raises(InvalidTag):
        provider.decrypt("other-workspace", "ref", "version", ciphertext)


def test_token_bound_includes_unicode_system_schema_and_all_context():
    """用中文需求及长结构描述构造上下文，核对预算上界按含系统消息的完整请求字节数加固定余量计算。"""
    value = DraftContext(
        {"requirement": "中文" * 100, "data": {"selected": "x" * 2000}},
        {"type": "string", "description": "x" * 3000},
        128,
    )
    assert value.input_bound() == len(canonical_bytes(value.messages())) + 8192
    assert (
        value.input_bound()
        > len(canonical_bytes(value.context)) + len(canonical_bytes(value.schema)) + 8192
    )


def test_ai_endpoint_allowlist_uses_normal_environment_precedence(monkeypatch, tmp_path):
    """分别从文件、环境变量与显式参数提供一个不同地址，核对供应商端点白名单沿用服务设置的覆盖顺序。"""
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"ai_allowed_base_urls": ["https://file.example/v1"]}))
    monkeypatch.setenv("VERIQ_AI_ALLOWED_BASE_URLS", '["https://environment.example/v1"]')
    assert resolve_settings_values(config)["ai_allowed_base_urls"] == [
        "https://environment.example/v1"
    ]
    assert resolve_settings_values(
        config, {"ai_allowed_base_urls": ["https://override.example/v1"]}
    )["ai_allowed_base_urls"] == ["https://override.example/v1"]


async def test_gateway_rejects_encoded_response_before_decompression():
    """提供声明压缩编码的供应商响应，在读取任何解压内容前核对网关返回的错误码及异常类型。"""
    response = httpx.Response(200, headers={"Content-Encoding": "gzip"})
    with pytest.raises(ValueError, match="AI_RESPONSE_ENCODING"):
        await limit_response(response)


async def test_fix1_sdk_raw_unicode_failure_retains_usage():
    """让供应商返回包含孤立代理码点的正文，确认生成失败时仍保留协议报告的确切输入和输出用量。"""
    async with emulator() as model:
        model.raw_content = "\ud800"
        gateway = ProviderGateway(
            {"adapter": "OPENAI_COMPATIBLE", "model": "emulator", "baseURL": model.base_url},
            "synthetic-key",
        )
        reply = await gateway.generate(
            DraftContext({"requirement": "REQ-1"}, {"type": "object"}, 128)
        )
        assert reply.error_code == "AI_INVALID_JSON"
        assert reply.output is None
        assert (reply.input_tokens, reply.output_tokens) == (80, 40)
        assert len(model.calls) == 1
