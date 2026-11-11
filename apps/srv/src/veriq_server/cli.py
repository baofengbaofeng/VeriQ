"""Operator-only setup and migration commands. Secrets are never printed."""

import argparse
import asyncio
import getpass
import json
import logging
import os
from pathlib import Path
import secrets
import signal

from pydantic import ValidationError
from tornado.httpserver import HTTPServer

from .app import make_app
from .db import Database, Installation
from sqlalchemy import text
from .migrate import migrate
from .service import Problem, digest, initialize, lock_installation
from .settings import Settings, load_settings, resolve_settings_values, operator_config_values


def secure_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)


async def run(args: argparse.Namespace) -> None:
    overrides = {
        field: getattr(args, field, None) for field in ("public_url", "host", "port", "environment")
    }
    if args.command == "init":
        existed = args.config.exists()
        stored = json.loads(args.config.read_text()) if existed else {}
        values = resolve_settings_values(args.config, overrides)
        if "database_url" not in values:
            values["database_url"] = getpass.getpass("MySQL URL: ")
        for field in ("master_key", "signing_key"):
            if field not in values:
                values[field] = secrets.token_hex(32)
        settings = Settings.model_validate(values)
        persisted = operator_config_values(settings.model_dump())
        if not existed:
            secure_write(args.config, json.dumps(persisted, indent=2) + "\n")
        else:
            # Preserve existing key bytes even when an environment override is active.
            persisted.update(
                {key: stored[key] for key in ("master_key", "signing_key") if key in stored}
            )
            if "master_key" in stored:
                # Preserve the whole persisted ring: an ID must never be paired with other bytes.
                persisted["master_key_id"] = stored.get("master_key_id", "primary")
                persisted["previous_master_keys"] = stored.get("previous_master_keys", {})
            if persisted != stored:
                replacement = args.config.with_name(
                    args.config.name + "." + secrets.token_hex(8) + ".tmp"
                )
                secure_write(replacement, json.dumps(persisted, indent=2) + "\n")
                try:
                    os.replace(replacement, args.config)
                finally:
                    replacement.unlink(missing_ok=True)
        await migrate(settings)
        db = Database(settings)
        try:
            async with db.sessions.begin() as session:
                installation = await lock_installation(session)
                if installation.initialized:
                    raise Problem(409, "ALREADY_INITIALIZED", "Installation already initialized")
                secret_path = args.config.with_suffix(".installation-secret")
                if not secret_path.exists():
                    secure_write(secret_path, secrets.token_urlsafe(32) + "\n")
                secret = secret_path.read_text().strip()
                if not secret or len(secret) > 256:
                    raise ValueError("Installation secret file is invalid")
                installation.setup_secret_hash = digest(secret)
        finally:
            await db.close()
        print(
            "VeriQ initialized. Configuration and installation-secret files are operator-only. Use setup or create-admin; back up external keys."
        )
        return
    settings = load_settings(args.config, overrides)
    if args.command == "migrate":
        await migrate(settings)
        print("VeriQ database migration complete.")
        return
    db = Database(settings)
    try:
        if args.command == "doctor":
            async with db.sessions() as session:
                version = str((await session.execute(text("SELECT VERSION()"))).scalar())
                if not version.startswith("8.4.") or await session.get(Installation, 1) is None:
                    raise ValueError("Database/schema is not supported")
            print("VeriQ configuration, MySQL version and installation schema are ready.")
        elif args.command == "create-admin":
            secret_path = args.config.with_suffix(".installation-secret")
            password = getpass.getpass("Administrator password (12+ characters): ")
            if password != getpass.getpass("Confirm password: "):
                raise ValueError("Passwords do not match")
            from .validation import validate_api

            data = {
                "installationSecret": secret_path.read_text().strip(),
                "email": args.email,
                "displayName": args.display_name,
                "password": password,
            }
            validate_api("SetupRequest", data)
            await initialize(db, data)
            secret_path.unlink(missing_ok=True)
            print("VeriQ administrator created; installation secret consumed.")
        else:
            logging.basicConfig(level=logging.INFO, format="%(message)s")
            application = make_app(settings, db)
            server = HTTPServer(application, max_body_size=3 * 1024 * 1024)
            server.listen(settings.port, address=settings.host)
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, stop.set)
            print(f"VeriQ listening on port {settings.port}")
            await stop.wait()
            server.stop()
            await server.close_all_connections()
            await application.settings["reset_dispatcher"].close()
    finally:
        await db.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="veriq_server", description="VeriQ control service")
    parser.add_argument("--config", type=Path, default=Path("veriq.json"))
    parser.add_argument("--public-url")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--environment", choices=["production", "development"])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    sub.add_parser("migrate")
    sub.add_parser("serve")
    sub.add_parser("doctor")
    admin = sub.add_parser("create-admin")
    admin.add_argument("--email", required=True)
    admin.add_argument("--display-name", required=True)
    try:
        asyncio.run(run(parser.parse_args()))
    except (ValidationError, ValueError, Problem, OSError):
        # Validation errors contain input values: never stringify them.
        parser.exit(
            1, "VeriQ command failed. Check configuration, file permissions and command inputs.\n"
        )
    except Exception:
        parser.exit(1, "VeriQ command failed. Check database availability and migration status.\n")


if __name__ == "__main__":
    main()
