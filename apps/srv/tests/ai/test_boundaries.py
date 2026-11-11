"""Pure boundary checks: production changes to purpose/AAD or bounds break these."""

import pytest
from cryptography.exceptions import InvalidTag
from veriq_server.credentials.crypto import Keyring
from veriq_server.infrastructure.providers import DraftContext
from veriq_server.contracts import canonical_bytes


def test_provider_key_ciphertext_is_not_a_business_credential():
    business = Keyring("primary", {"primary": bytes(32)})
    provider = Keyring("primary", {"primary": bytes(32)}, purpose="veriq-ai-provider-v1")
    ciphertext = provider.encrypt("workspace", "ref", "version", "synthetic-api-key")
    assert provider.decrypt("workspace", "ref", "version", ciphertext) == "synthetic-api-key"
    with pytest.raises(InvalidTag):
        business.decrypt("workspace", "ref", "version", ciphertext)
    with pytest.raises(InvalidTag):
        provider.decrypt("other-workspace", "ref", "version", ciphertext)


def test_token_bound_includes_unicode_system_schema_and_all_context():
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
    import json
    from veriq_server.settings import resolve_settings_values

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
    import httpx
    from veriq_server.infrastructure.providers import limit_response

    response = httpx.Response(200, headers={"Content-Encoding": "gzip"})
    with pytest.raises(ValueError, match="AI_RESPONSE_ENCODING"):
        await limit_response(response)
