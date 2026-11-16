"""操作员 CLI：初始化配置与安装密钥、迁移、诊断、创建管理员或启动 Tornado 控制服务，失败信息刻意不回显敏感输入。

`init` 以 0600 独占写配置与 installation-secret，并登记密钥摘要；重复 init 保留已有主密钥环字节。issuer
子命令仅输出公钥元数据；create-admin 消费安装密钥后删除密钥文件。
异常路径统一短错误，避免 ValidationError/Problem 字符串化泄露口令或密钥材料。
"""

import argparse
import asyncio
import getpass
import json
import logging
import os
from pathlib import Path
import secrets
import signal
import sys

from pydantic import ValidationError
from tornado.httpserver import HTTPServer

from .app import make_app
from .handlers.base import MAX_HTTP_BODY_BYTES
from .db import Database
from .migrate import migrate
from .service import Problem, digest, initialize, lock_installation
from .settings import Settings, load_settings, resolve_settings_values, operator_config_values


def secure_write(path: Path, content: str) -> None:
    """以目录 0700、文件 0600 且 O_EXCL 独占创建的方式写入操作员机密文件，拒绝覆盖已有路径，secure_write
    的失败路径返回稳定错误。
    secure_write 实现于 apps/srv/src/veriq_server/cli.py：请按该符号的输入校验、错误码与调用方契约阅读，
    勿假设通用成功默认值。
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)


async def run(args: argparse.Namespace) -> None:
    """按子命令执行 issuer、init、migrate、doctor、create-admin 或 serve，并统一管理数据库生命周期。run 实现于

    apps/srv/src/veriq_server/cli.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    overrides = {
        field: getattr(args, field, None) for field in ("public_url", "host", "port", "environment")
    }
    if args.command == "issuer":
        from .bundles.issuer import Issuer

        if args.operation == "init":
            issuer = Issuer.initialize(args.path)
        else:
            issuer = Issuer(args.path)
            if args.operation == "rotate":
                issuer.rotate()
            elif args.operation == "revoke":
                if not args.key_id:
                    raise ValueError("Key ID required")
                issuer.revoke(args.key_id)
            issuer = Issuer(args.path)
        print(json.dumps(issuer.public()))
        return
    if args.command == "init":
        existed = args.config.exists()
        stored = json.loads(args.config.read_text()) if existed else {}
        values = resolve_settings_values(args.config, overrides)
        if "database_url" not in values:
            values["database_url"] = getpass.getpass("MySQL URL: ")
        for field in ("master_key", "signing_key"):
            if field not in values:
                values[field] = secrets.token_hex(32)
        if "bundle_issuer_path" not in values and not existed:
            from .bundles.issuer import Issuer

            issuer_path = args.config.parent / "veriq-issuer" / "issuer.json"
            if not issuer_path.exists():
                Issuer.initialize(issuer_path)
            values["bundle_issuer_path"] = str(issuer_path.resolve())
        settings = Settings.model_validate(values)
        persisted = operator_config_values(settings.model_dump())
        if not existed:
            secure_write(args.config, json.dumps(persisted, indent=2) + "\n")
        else:
            # 环境变量可覆盖本次运行配置，但回写仍保留磁盘已有的密钥字节，避免启动时的环境覆盖意外轮换持久化密钥。
            persisted.update(
                {key: stored[key] for key in ("master_key", "signing_key") if key in stored}
            )
            if "master_key" in stored:
                # 已有主密钥字节与密钥 ID、历史密钥环一并保留，避免回写将旧标识绑定到不同字节而使既有加密数据无法解密。
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
            (
                "VeriQ initialized. Configuration and installation-secret files are operator-only. Use setup or "
                "create-admin; back up external keys."
            )
        )
        return
    settings = load_settings(args.config, overrides)
    if args.command == "migrate":
        await migrate(settings)
        print("VeriQ database migration complete.")
        return
    if args.command == "rotate-master-key":
        from .rekey import rotate_configuration

        rotate_configuration(settings, args.output, args.new_key_id)
        print(
            "VeriQ key rotation configuration created. Keep previous keys and switch configuration before rekeying."
        )
        return
    db = Database(settings)
    try:
        if args.command == "backup":
            from .recovery import backup

            receipt = await backup(
                db,
                settings,
                args.destination,
                services_stopped=args.services_stopped,
                configuration_path=args.config,
            )
            print(json.dumps({"manifestSha256": receipt}))
        elif args.command == "restore":
            from .recovery import restore

            await restore(
                db,
                settings,
                args.source,
                expected_digest=args.expected_manifest_sha256,
                services_stopped=args.services_stopped,
                allow_restore=args.allow_restore,
                confirm_empty_target=args.confirm_empty_target,
                allow_s3_inventory=args.allow_s3_inventory,
                configuration_path=args.config,
            )
            print("VeriQ backup restored. Run doctor and readiness checks before enabling writers.")
        elif args.command == "rekey":
            from .rekey import rekey

            print(
                json.dumps(
                    await rekey(
                        db, settings, services_stopped=args.services_stopped, limit=args.limit
                    )
                )
            )
        elif args.command == "doctor":
            from .handlers.static import load_published_site
            from .readiness import ReadinessMonitor

            monitor = ReadinessMonitor(settings, db, load_published_site(settings))
            try:
                checks = await monitor.check()
                if not all(checks.values()):
                    raise ValueError("Critical dependencies are unavailable")
            finally:
                await monitor.close()
            print("VeriQ database, schema, static package and configured storage checks are ready.")
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
            server = HTTPServer(application, max_body_size=MAX_HTTP_BODY_BYTES)
            try:
                server.listen(settings.port, address=settings.host)
                stop = asyncio.Event()
                loop = asyncio.get_running_loop()
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.add_signal_handler(sig, stop.set)
                print(f"VeriQ listening on port {settings.port}")
                await stop.wait()
            finally:
                server.stop()
                await server.close_all_connections()
                try:
                    await application.settings["reset_dispatcher"].close()
                finally:
                    await application.settings["readiness_monitor"].close()
    finally:
        await db.close()


def main() -> None:
    """解析 veriq_server 子命令并运行异步入口；敏感校验失败时只打印固定短错误信息不回显输入，main
    的失败路径返回稳定错误。main 实现于

    apps/srv/src/veriq_server/cli.py：请按该符号的输入校验、错误码与调用方契约阅读，勿假设通用成功默认值。
    """
    parser = argparse.ArgumentParser(prog="veriq", description="VeriQ control service")
    parser.add_argument("--config", type=Path, default=Path("veriq.json"))
    parser.add_argument("--public-url")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--environment", choices=["production", "development"])
    sub = parser.add_subparsers(dest="command", required=True)
    issuer = sub.add_parser(
        "issuer",
        help="Initialize/rotate/revoke the dedicated bundle issuer; output public metadata only",
    )
    issuer.add_argument("operation", choices=["init", "show", "rotate", "revoke"])
    issuer.add_argument("--path", type=Path, required=True)
    issuer.add_argument("--key-id")
    sub.add_parser("init")
    sub.add_parser("migrate")
    sub.add_parser("serve")
    sub.add_parser("doctor")
    backup_parser = sub.add_parser(
        "backup",
        help="Consistent offline database/artifact/key snapshot; requires MySQL global read lock privilege",
    )
    backup_parser.add_argument("--destination", type=Path, required=True)
    backup_parser.add_argument("--services-stopped", action="store_true")
    restore_parser = sub.add_parser(
        "restore", help="Restore into an empty migrated target of the exact installed version"
    )
    restore_parser.add_argument("--source", type=Path, required=True)
    restore_parser.add_argument("--expected-manifest-sha256", required=True)
    restore_parser.add_argument("--services-stopped", action="store_true")
    restore_parser.add_argument("--allow-restore", action="store_true")
    restore_parser.add_argument("--confirm-empty-target", action="store_true")
    restore_parser.add_argument("--allow-s3-inventory", action="store_true")
    rotation = sub.add_parser(
        "rotate-master-key",
        help="Create a new private configuration retaining all previous master keys",
    )
    rotation.add_argument("--new-key-id", required=True)
    rotation.add_argument("--output", type=Path, required=True)
    rekey_parser = sub.add_parser(
        "rekey", help="Rewrap a bounded batch without changing credential version identities"
    )
    rekey_parser.add_argument("--services-stopped", action="store_true")
    rekey_parser.add_argument("--limit", type=int, default=100)
    admin = sub.add_parser("create-admin")
    admin.add_argument("--email", required=True)
    admin.add_argument("--display-name", required=True)
    try:
        if sys.platform.startswith("linux"):
            import ctypes

            if ctypes.CDLL(None, use_errno=True).prctl(15, b"veriq", 0, 0, 0) != 0:
                raise OSError("VeriQ process identity could not be set")
        asyncio.run(run(parser.parse_args()))
    except (ValidationError, ValueError, Problem, OSError):
        # 校验异常可能携带密钥等原始输入，终端仅返回固定失败提示，禁止把异常转换成字符串后回显给操作者。
        parser.exit(
            1, "VeriQ command failed. Check configuration, file permissions and command inputs.\n"
        )
    except Exception:
        parser.exit(1, "VeriQ command failed. Check database availability and migration status.\n")


if __name__ == "__main__":
    main()
