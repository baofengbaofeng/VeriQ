import asyncio
import json
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

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
    # The HTTP fixture owns/reset the dedicated test schema; use another listen port.
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
    values = dict(
        database_url="mysql+asyncmy://u:p@localhost/veriq_test",
        public_url="https://veriq.example.com",
        master_key="a" * 64,
        signing_key="b" * 64,
    )
    with pytest.raises(ValidationError):
        Settings(**values, smtp_host="smtp.example.com")
    with pytest.raises(ValidationError):
        Settings(
            **values,
            smtp_host="smtp.example.com",
            smtp_from="sender@example.com",
            smtp_security="none",
        )
    with pytest.raises(ValidationError):
        Settings(
            **values,
            smtp_host="smtp.example.com",
            smtp_from="sender@example.com",
            smtp_username="user",
        )
