# Reuse the guarded real-MySQL/HTTP fixture; no second test database harness.
import sys
import shutil
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
sys.path.insert(0, str(Path(__file__).parents[1] / "resources"))


@pytest.fixture(autouse=True)
def clean_task_archives(tmp_path):
    yield
    for path in tmp_path.rglob("*"):
        if path.is_dir():
            path.chmod(0o700)
    shutil.rmtree(tmp_path)


@pytest.fixture(autouse=True)
def bundle_issuer(monkeypatch, tmp_path):
    from veriq_server.bundles.issuer import Issuer
    from veriq_server.app import handler_for, make_app

    issuer_path = tmp_path / "issuer" / "keys.json"
    Issuer.initialize(issuer_path)

    def application(settings, db, *args, **kwargs):
        settings.bundle_issuer_path = str(issuer_path)
        app = make_app(settings, db, *args, **kwargs)
        # 历史协议样例显式在本夹具注册退役路由，正式应用没有配置开关可启用离线导出与导入。
        legacy_routes = [
            (
                "/internal/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})/download",
                "native-bundle-download",
            ),
            ("/api/v1/workspaces/([0-9a-fA-F-]{36})/result-imports", "result-imports"),
            (
                "/api/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads",
                "result-import-uploads",
            ),
            (
                "/api/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads/([0-9a-fA-F-]{36})",
                "result-import-uploads",
            ),
            ("/internal/v1/workspaces/([0-9a-fA-F-]{36})/result-imports", "native-result-imports"),
            (
                "/internal/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads",
                "native-result-import-uploads",
            ),
            (
                "/internal/v1/workspaces/([0-9a-fA-F-]{36})/result-import-uploads/([0-9a-fA-F-]{36})",
                "native-result-import-uploads",
            ),
            ("/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles", "bundles"),
            ("/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})", "bundle"),
            (
                "/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})/manifest",
                "bundle-manifest",
            ),
            (
                "/api/v1/workspaces/([0-9a-fA-F-]{36})/bundles/([0-9a-fA-F-]{36})/download",
                "bundle-download",
            ),
        ]
        app.add_handlers(
            ".*",
            [
                (path, handler_for(action), {"config": settings, "db": db, "action": action})
                for path, action in legacy_routes
            ],
        )
        return app

    monkeypatch.setitem(site.__wrapped__.__globals__, "make_app", application)


@pytest.fixture
def approved_metadata(monkeypatch, tmp_path, bundle_issuer):
    from hashlib import sha256
    from veriq_server.contracts import canonical_bytes

    bodies = {
        "package.json": b'{"name":"synthetic-release"}',
        "package-lock.json": b'{"lockfileVersion":3}',
        "dependencies.json": b"[]",
        "engine/compiler.tgz": b"synthetic compiler archive",
    }
    entries = [
        {"path": path, "sha256": sha256(raw).hexdigest(), "sizeBytes": len(raw)}
        for path, raw in bodies.items()
    ]
    inventory = {
        "schemaVersion": "1.0",
        "engines": [
            {
                "engineVersion": "0.1.0",
                "compilerVersion": "0.1.0",
                "runnerSdkVersion": "0.1.0",
                "files": entries,
                "dependencies": [],
            }
        ],
    }
    path = tmp_path / "inventory.json"
    path.write_bytes(canonical_bytes(inventory))
    original = site.__wrapped__.__globals__["make_app"]

    def application(settings, db, *args, **kwargs):
        settings.approved_engine_inventory_path = str(path)
        return original(settings, db, *args, **kwargs)

    monkeypatch.setitem(site.__wrapped__.__globals__, "make_app", application)
    return bodies
