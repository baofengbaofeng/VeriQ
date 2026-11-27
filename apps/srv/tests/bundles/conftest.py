"""离线协议夹具共用认证测试的专用数据库和 HTTP 验证，并仅为历史导出导入测试安装已经退役的处理器。"""

import json
import runpy
import shutil
import sys
from hashlib import sha256
from pathlib import Path

import pytest

from veriq_server.app import handler_for, make_app
from veriq_server.bundles.issuer import Issuer
from veriq_server.contracts import canonical_bytes
from veriq_server.validation import api_document

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
sys.path.insert(0, str(Path(__file__).parents[1] / "resources"))


@pytest.fixture(autouse=True)
def clean_task_archives(tmp_path):
    """授权归档测试会留下只读的子目录，清理时先恢复目录的写权限，再移除本用例独占的临时文件。"""
    yield
    for path in tmp_path.rglob("*"):
        if path.is_dir():
            path.chmod(0o700)
    shutil.rmtree(tmp_path)


@pytest.fixture(name="bundle_issuer", autouse=True)
def _bundle_issuer(monkeypatch, tmp_path):
    """注册历史路由及对应的响应规范，并把同一个临时签发器传给使用额外编译库存的测试应用。"""

    # 历史 HTTP 夹具同时校验线上读响应和退役操作；共用路径上的 GET 与 POST 各保留原方法。
    live = api_document()
    fixture_path = (
        Path(__file__).resolve().parents[4] / "packages/contracts/openapi/offline-fixtures.json"
    )
    fixture_paths = dict(live["paths"])
    for path, operations in json.loads(fixture_path.read_text(encoding="utf-8"))["paths"].items():
        fixture_paths[path] = {**fixture_paths.get(path, {}), **operations}
    monkeypatch.setitem(
        site.__wrapped__.__globals__, "api_document", lambda: {**live, "paths": fixture_paths}
    )

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
    return application


@pytest.fixture
def approved_metadata(monkeypatch, tmp_path, bundle_issuer):
    """创建独立的批准库存及其实际文件字节，并在历史路由应用启动之前注入本次用例专属的库存路径。"""

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

    def application(settings, db, *args, **kwargs):
        settings.approved_engine_inventory_path = str(path)
        return bundle_issuer(settings, db, *args, **kwargs)

    monkeypatch.setitem(site.__wrapped__.__globals__, "make_app", application)
    return bodies
