import asyncio
import json
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

import veriq_server.settings
from veriq_server.settings import Settings, load_settings


def test_settings_precedence_and_secret_validation(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "database_url": "mysql+asyncmy://u:p@localhost/veriq_test",
                "public_url": "https://file.example.com",
                "master_key": "a" * 64,
                "signing_key": "b" * 64,
                "port": 8001,
            }
        )
    )
    monkeypatch.setenv("VERIQ_PORT", "8002")
    assert load_settings(path).port == 8002
    assert load_settings(path, {"port": 8003}).port == 8003
    assert load_settings(path).public_url == "https://file.example.com"
    assert "mysql+asyncmy" not in repr(load_settings(path))
    with pytest.raises(ValidationError):
        Settings(
            database_url="mysql+asyncmy://u:p@localhost/veriq_test",
            public_url="http://public.example.com",
            master_key="a" * 64,
            signing_key="b" * 64,
        )


async def test_real_cli_init_migrate_create_admin_and_serve(site, tmp_path):
    # 命令行用例复用 HTTP 夹具负责清理的专用测试库，并用独立监听端口让两套服务在用例期间并存。
    c, db = site
    env = os.environ.copy()
    env["VERIQ_DATABASE_URL"] = json.loads(
        Path(".superpowers/sdd/veriq-1/test-env.json").read_text()
    )["mysql_dsn"]
    path = tmp_path / "veriq.json"
    binary = str(Path("apps/srv/.venv/bin/veriq_server").resolve())

    async def command(*args, input=None):
        p = await asyncio.create_subprocess_exec(
            binary,
            "--config",
            str(path),
            *args,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await p.communicate(input.encode() if input else None)
        assert p.returncode == 0, "Operator command failed (output withheld to protect secrets)"
        assert env["VERIQ_DATABASE_URL"].encode() not in stdout + stderr
        return stdout.decode()

    await command("--public-url", "http://127.0.0.1:18890", "--environment", "development", "init")
    assert path.stat().st_mode & 0o777 == 0o600
    secret_path = path.with_suffix(".installation-secret")
    assert secret_path.stat().st_mode & 0o777 == 0o600
    original = path.read_bytes()
    secret_path.unlink()  # 删去安装密钥模拟配置先落盘后的中断，重跑 init 应补齐密钥并逐字节保留原来的配置文件。
    await command("init")
    assert path.read_bytes() == original
    await command("migrate")
    await command(
        "create-admin",
        "--email",
        "cli@example.com",
        "--display-name",
        "CLI Admin",
        input="CLI password 123!\nCLI password 123!\n",
    )
    assert not secret_path.exists()
    await command("doctor")
    p = await asyncio.create_subprocess_exec(
        binary,
        "--config",
        str(path),
        "--port",
        "18890",
        "serve",
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        import httpx

        async with httpx.AsyncClient(base_url="http://127.0.0.1:18890") as other:
            for _ in range(100):
                try:
                    response = await other.get("/api/v1/setup")
                    break
                except httpx.ConnectError:
                    await asyncio.sleep(0.05)
            else:
                pytest.fail("CLI serve failed to start")
            assert response.json()["data"]["initialized"] is True
            assert (await other.get("/api/v1/health/live")).status_code == 200
    finally:
        p.terminate()
        await p.communicate()


def test_incomplete_or_plaintext_production_smtp_is_rejected():
    """
    直接校验生产邮件设置的发件地址与成套选项，保留固定错误，并确认合法地址在启用加密时能够通过。
    """
    values = {
        "database_url": "mysql+asyncmy://u:p@localhost/veriq_test",
        "public_url": "https://veriq.example.com",
        "master_key": "a" * 64,
        "signing_key": "b" * 64,
    }
    for sender in (None, "", "invalid", "sender@example.com\r", "sender@example.com\n"):
        with pytest.raises(ValidationError) as invalid:
            Settings(**values, smtp_host="smtp.example.com", smtp_from=sender)
        assert (
            invalid.value.errors()[0]["msg"] == "Value error, SMTP requires a valid sender address"
        )
    with pytest.raises(ValidationError, match="Production SMTP requires TLS"):
        Settings(
            **values,
            smtp_host="smtp.example.com",
            smtp_from="sender@example.com",
            smtp_security="none",
        )
    with pytest.raises(
        ValidationError, match="SMTP username and password must be configured together"
    ):
        Settings(
            **values,
            smtp_host="smtp.example.com",
            smtp_from="sender@example.com",
            smtp_username="user",
        )
    with pytest.raises(ValidationError, match="SMTP host is required when delivery is configured"):
        Settings(**values, smtp_from="sender@example.com")
    valid = Settings(
        **values,
        smtp_host="smtp.example.com",
        smtp_from="sender@example.com",
        smtp_security="tls",
    )
    assert valid.smtp_from == "sender@example.com" and valid.smtp_security == "tls"


def test_resolve_settings_reads_every_declared_environment_field(tmp_path, monkeypatch):
    """
    以模型公开字段集合核对原始配置合并行为，覆盖结构化环境值、未知环境键和只读输入文件。
    """
    path = tmp_path / "all-fields.json"
    original = b'{"port":8001,"public_url":"https://file.example.com"}\n'
    path.write_bytes(original)
    expected = {key: f"from-env-{key}" for key in dict(Settings.model_fields)}
    expected["previous_master_keys"] = {"older": "raw-key"}
    expected["ai_allowed_base_urls"] = ["https://allowed.example.com"]
    for key, value in expected.items():
        monkeypatch.setenv(
            "VERIQ_" + key.upper(), value if isinstance(value, str) else json.dumps(value)
        )
    monkeypatch.setenv("VERIQ_UNKNOWN_SETTINGS_FIELD", "ignored")
    actual = veriq_server.settings.resolve_settings_values(path, {"port": 8003, "public_url": None})
    assert actual == {**expected, "port": 8003}
    assert path.read_bytes() == original


@pytest.mark.parametrize("resumed", [False, True])
async def test_init_resolves_all_effective_settings(tmp_path, monkeypatch, resumed):
    from argparse import Namespace
    from veriq_server import cli

    class Captured(Exception):
        pass

    config = tmp_path / "init.json"
    stored = {
        "database_url": "mysql+asyncmy://u:p@localhost/veriq_test",
        "public_url": "https://file.example.com",
        "master_key": "a" * 64,
        "signing_key": "b" * 64,
        "host": "file-host",
        "port": 8001,
    }
    if resumed:
        config.write_text(json.dumps(stored))
        config.with_suffix(".installation-secret").write_text("existing-operator-secret")
    monkeypatch.setenv("VERIQ_DATABASE_URL", stored["database_url"])
    monkeypatch.setenv("VERIQ_PUBLIC_URL", "https://env.example.com")
    monkeypatch.setenv("VERIQ_PORT", "8002")
    monkeypatch.setenv("VERIQ_SESSION_HOURS", "24")
    monkeypatch.setenv("VERIQ_MASTER_KEY", "c" * 64)
    monkeypatch.setenv("VERIQ_SIGNING_KEY", "d" * 64)
    monkeypatch.setenv("VERIQ_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("VERIQ_SMTP_FROM", "sender@example.com")
    monkeypatch.setenv("VERIQ_SMTP_PASSWORD", "synthetic-password")
    monkeypatch.setenv("VERIQ_SMTP_USERNAME", "synthetic-user")
    captured = []

    async def capture(settings):
        captured.append(settings)
        raise Captured

    monkeypatch.setattr(cli, "migrate", capture)
    with pytest.raises(Captured):
        await cli.run(
            Namespace(
                command="init",
                config=config,
                host="cli-host",
                port=8003,
                public_url="https://cli.example.com",
                environment=None,
            )
        )
    settings = captured[0]
    assert (settings.host, settings.port, settings.session_hours) == ("cli-host", 8003, 24)
    assert settings.public_url == "https://cli.example.com"
    assert settings.master_key.get_secret_value() == "c" * 64
    assert settings.signing_key.get_secret_value() == "d" * 64
    assert (
        settings.smtp_host == "smtp.example.com"
        and settings.smtp_username.get_secret_value() == "synthetic-user"
    )
    persisted = json.loads(config.read_text())
    if resumed:
        assert persisted["master_key"] == stored["master_key"]
        assert persisted["signing_key"] == stored["signing_key"]
        assert persisted["host"] == "cli-host" and persisted["port"] == 8003
        assert persisted["session_hours"] == 24 and persisted["smtp_host"] == "smtp.example.com"
    else:
        assert persisted["master_key"] == "c" * 64 and persisted["signing_key"] == "d" * 64
        assert persisted["port"] == 8003 and persisted["session_hours"] == 24
        assert persisted["smtp_host"] == "smtp.example.com"


@pytest.mark.parametrize(
    "bad_field,bad_value",
    [("VERIQ_MASTER_KEY", "bad-key"), ("VERIQ_SMTP_HOST", "smtp.example.com")],
)
async def test_init_validates_environment_before_writes(
    tmp_path, monkeypatch, bad_field, bad_value
):
    from argparse import Namespace
    from veriq_server import cli

    config = tmp_path / "invalid.json"
    monkeypatch.setenv("VERIQ_DATABASE_URL", "mysql+asyncmy://u:p@localhost/veriq_test")
    monkeypatch.setenv(bad_field, bad_value)
    with pytest.raises(ValidationError):
        await cli.run(
            Namespace(
                command="init",
                config=config,
                host=None,
                port=None,
                public_url="https://veriq.example.com",
                environment=None,
            )
        )
    assert not config.exists()


def test_keyring_file_environment_and_explicit_override_precedence(tmp_path, monkeypatch):
    path = tmp_path / "keyring.json"
    values = {
        "database_url": "mysql+asyncmy://u:p@localhost/veriq_test",
        "public_url": "https://example.test",
        "master_key": "a" * 64,
        "master_key_id": "active",
        "signing_key": "b" * 64,
        "previous_master_keys": {"old": "c" * 64},
    }
    path.write_text(json.dumps(values))
    assert load_settings(path).previous_master_keys["old"].get_secret_value() == "c" * 64
    monkeypatch.setenv("VERIQ_PREVIOUS_MASTER_KEYS", json.dumps({"older": "d" * 64}))
    assert load_settings(path).previous_master_keys["older"].get_secret_value() == "d" * 64
    assert (
        load_settings(path, {"previous_master_keys": {"explicit": "e" * 64}})
        .previous_master_keys["explicit"]
        .get_secret_value()
        == "e" * 64
    )


async def test_cli_keyring_roundtrip_and_resumed_init_preserves_key_id_pair(site, tmp_path):
    _, db = site
    path = tmp_path / "ring.json"
    env = os.environ.copy()
    env.update(
        VERIQ_DATABASE_URL=db.engine.url.render_as_string(hide_password=False),
        VERIQ_PUBLIC_URL="http://127.0.0.1",
        VERIQ_ENVIRONMENT="development",
        VERIQ_MASTER_KEY="a" * 64,
        VERIQ_MASTER_KEY_ID="active",
        VERIQ_SIGNING_KEY="b" * 64,
        VERIQ_PREVIOUS_MASTER_KEYS=json.dumps({"older": "c" * 64}),
    )
    binary = str(Path("apps/srv/.venv/bin/veriq_server").resolve())

    async def command():
        p = await asyncio.create_subprocess_exec(
            binary,
            "--config",
            str(path),
            "init",
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await p.communicate()
        for value in ["a" * 64, "b" * 64, "c" * 64, "d" * 64, env["VERIQ_PREVIOUS_MASTER_KEYS"]]:
            assert value.encode() not in stdout + stderr
        return p.returncode

    assert await command() == 0
    first = json.loads(path.read_text())
    assert first["master_key_id"] == "active" and first["master_key"] == "a" * 64
    assert first["previous_master_keys"] == {"older": "c" * 64}
    env.update(
        VERIQ_MASTER_KEY="d" * 64,
        VERIQ_MASTER_KEY_ID="replacement",
        VERIQ_PREVIOUS_MASTER_KEYS=json.dumps({"active": "a" * 64, "older": "c" * 64}),
    )
    assert await command() == 0
    persisted = json.loads(path.read_text())
    assert {
        key: persisted[key] for key in ["master_key", "master_key_id", "previous_master_keys"]
    } == {key: first[key] for key in ["master_key", "master_key_id", "previous_master_keys"]}
    env["VERIQ_PREVIOUS_MASTER_KEYS"] = "invalid-secret-json"
    assert await command() == 1
    assert json.loads(path.read_text()) == persisted
